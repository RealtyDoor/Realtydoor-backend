const axios = require('axios');
const logger = require('./logger');
const prisma = require('./prisma');
const { canSend, CATEGORIES } = require('./notificationGate');

const client = axios.create({
  baseURL: process.env.WATI_API_ENDPOINT,
  headers: {
    Authorization: `Bearer ${process.env.WATI_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

// T23 — outside production, WATI_ALLOWED_NUMBERS (comma-separated phone
// numbers) limits who a test run can message, so admin and partner testing
// cannot reach real people. Unset = no limit. Production ignores it.
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}
function isRecipientAllowed(phone, env = process.env) {
  if (env.NODE_ENV === 'production') return true;
  const list = String(env.WATI_ALLOWED_NUMBERS || '').split(',').map(normalizePhone).filter(Boolean);
  if (list.length === 0) return true;
  return list.includes(normalizePhone(phone));
}

// 12.5 — every outbound send gets a WatiMessageLog row, success or failure.
// Logging must never break a send: a notification going out matters more than
// our record of it, so a logging failure is swallowed with a warning. The
// webhook later updates the row in place as WATI reports delivered/read.
async function logSend(fields) {
  try {
    return await prisma.watiMessageLog.create({ data: fields });
  } catch (err) {
    logger.warn('[WATI] message log write failed', { templateName: fields.templateName, error: err.message });
    return null;
  }
}

// `context` carries the ids that let the delivery log link a message back to
// what caused it (12.5's "linked lead or ticket"). Callers pass what they know.
// `user`/`category` feed the privacy-spec enforcement gate (notificationGate.js)
// — omitted by direct/manual sends (admin template replies), which keep
// sending unconditionally exactly as before this gate existed, since there's
// no toggle to respect without a user in scope.
async function sendTemplateMessage(phone, templateName, parameters = [], context = {}, user, category) {
  if (!canSend({ user, channel: 'WHATSAPP', category })) return null;

  if (!isRecipientAllowed(phone)) {
    logger.warn(`[WATI] ${templateName} to ${normalizePhone(phone).replace(/\d(?=\d{4})/g, 'x')} blocked: not in WATI_ALLOWED_NUMBERS`);
    return null;
  }

  const e164 = phone.replace(/\D/g, '');
  const startedAt = Date.now();
  try {
    const res = await client.post(`/api/v1/sendTemplateMessage?whatsappNumber=${e164}`, {
      template_name: templateName,
      broadcast_name: templateName,
      parameters,
    });

    await logSend({
      // WATI's response shape varies by account/version, so probe the known
      // spots rather than assuming one. Null is fine — the row is still the
      // record that a send happened.
      messageId: res.data?.messageId ?? res.data?.id ?? null,
      templateName,
      recipientPhone: phone,
      status: 'SENT',
      latencyMs: Date.now() - startedAt,
      ...context,
    });

    return res;
  } catch (err) {
    const status = err.response?.status;
    const data   = JSON.stringify(err.response?.data);
    logger.error(`[WATI] ${templateName} → ${phone} failed: HTTP ${status} — ${data}`);

    await logSend({
      templateName,
      recipientPhone: phone,
      status: 'FAILED',
      failureReason: `HTTP ${status ?? 'ERR'} — ${err.message}`.slice(0, 500),
      latencyMs: Date.now() - startedAt,
      ...context,
    });

    throw err;
  }
}

// OTPs — always sent regardless of the notifWhatsapp toggle (spec: "Receipts,
// OTPs and security or legal notices always go out").
async function sendSiteVisitOtp(phone, otp, context = {}) {
  return sendTemplateMessage(phone, 'site_visit_otp', [
    { name: '1', value: String(otp) },
  ], context, null, CATEGORIES.TRANSACTIONAL);
}

async function sendLeadAssignedNotice(phone, partnerName, context = {}, user) {
  return sendTemplateMessage(phone, 'lead_assigned_notice', [
    { name: 'partner_name', value: partnerName },
  ], context, user);
}

async function sendBuyerFeedbackRequest(phone, partnerName, context = {}, user) {
  return sendTemplateMessage(phone, 'buyer_feedback_request', [
    { name: 'partner_name', value: partnerName },
  ], context, user);
}

async function sendPhoneVerificationOtp(phone, otp, context = {}) {
  return sendTemplateMessage(phone, 'phone_verification_otp', [
    { name: '1', value: String(otp) },
  ], context, null, CATEGORIES.TRANSACTIONAL);
}

// Templates that are APPROVED in the WATI account and safe to send. A template
// that is still a draft would just log a FAILED row, so notifyUser() skips
// anything not listed here. Once Meta approves a new template, add its name to
// WATI_LIVE_TEMPLATES (comma-separated) in the env — no code change needed.
const LIVE_TEMPLATES = new Set([
  'site_visit_otp', 'phone_verification_otp', 'lead_assigned_notice',
  'buyer_feedback_request', 'contact_reply', 'ticket_vendor_dispatched',
  ...(process.env.WATI_LIVE_TEMPLATES || '').split(',').map((t) => t.trim()).filter(Boolean),
]);

// Fire-and-forget WhatsApp copy of an in-app notification. Looks up the user's
// phone and notifWhatsapp preference itself (OPERATIONAL category), never
// throws; pass '$userName' as a value to insert the recipient's own name — a failed WhatsApp must not break the action that triggered it.
async function notifyUser(userId, templateName, parameters, context = {}) {
  try {
    if (!LIVE_TEMPLATES.has(templateName)) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, phone: true, notifWhatsapp: true, marketingOptIn: true },
    });
    if (!user?.phone) return null;
    return await sendTemplateMessage(
      user.phone, templateName,
      Object.entries(parameters).map(([name, value]) => ({
        name, value: String(value === '$userName' ? (user.name || 'there') : value).replace(/\s+/g, ' ').trim(),
      })),
      { userId, ...context }, user,
    );
  } catch (err) {
    logger.warn('[WATI] notifyUser failed', { templateName, userId, error: err.message });
    return null;
  }
}

async function sendTicketVendorDispatched(userId, ticketSubject, vendorName, ticketId) {
  return notifyUser(userId, 'ticket_vendor_dispatched', {
    ticket_subject: ticketSubject, vendor_name: vendorName,
  }, { ticketId });
}

module.exports = {
  sendTemplateMessage,
  sendSiteVisitOtp,
  sendLeadAssignedNotice,
  sendBuyerFeedbackRequest,
  sendPhoneVerificationOtp,
  notifyUser,
  sendTicketVendorDispatched,
  isRecipientAllowed,
};
