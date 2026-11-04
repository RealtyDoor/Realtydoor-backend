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
// The message as the buyer saw it: the catalogue body with {{variables}} filled, when we hold that template's text.
async function renderTemplate(templateName, parameters = []) {
  try {
    const tpl = await prisma.watiTemplate.findUnique({ where: { name: templateName }, select: { body: true } });
    if (!tpl?.body) return null;
    const values = Object.fromEntries((parameters || []).map((p) => [String(p.name), String(p.value)]));
    return tpl.body.replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, k) => (values[k] !== undefined ? values[k] : m));
  } catch { return null; }
}

async function logSend(fields) {
  try {
    const { parameters, ...rest } = fields;
    const renderedText = parameters ? await renderTemplate(fields.templateName, parameters) : null;
    const row = await prisma.watiMessageLog.create({
      data: {
        ...rest,
        ...(parameters && { parameters: Object.fromEntries(parameters.map((p) => [String(p.name), String(p.value)])) }),
        ...(renderedText && { renderedText }),
        eventHistory: [{ status: fields.status, at: new Date().toISOString(), ...(fields.failureReason && { reason: fields.failureReason }) }],
      },
    });
    // The same message goes into the chat thread, so a buyer's conversation reads in one place.
    await prisma.whatsAppMessage.create({
      data: {
        phone: String(fields.recipientPhone).startsWith('+') ? fields.recipientPhone : `+${String(fields.recipientPhone).replace(/\D/g, '')}`,
        direction: 'OUT', kind: 'TEMPLATE', templateName: fields.templateName, text: renderedText || null,
        ...(parameters && { parameters: Object.fromEntries(parameters.map((p) => [String(p.name), String(p.value)])) }),
        watiMessageId: fields.messageId || null, status: fields.status,
        ...(fields.failureReason && { failureReason: fields.failureReason }),
        ...(fields.leadId && { leadId: fields.leadId }), ...(fields.userId && { userId: fields.userId }), ...(fields.ticketId && { ticketId: fields.ticketId }),
      },
    }).catch((err) => logger.warn('[WATI] thread write failed', { error: err.message }));
    return row;
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
  templateName = resolveTemplate(templateName);
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
      parameters,
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
      parameters,
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

// Commission voucher acceptance code (money model phase 2). Uses its own
// template name so the wording can say what the code is for; until that template
// is created and approved in WATI (add it to WATI_LIVE_TEMPLATES) the send is
// logged as FAILED and the partner can ask admin for help. [needs a WATI template]
async function sendVoucherOtp(phone, otp, voucherNumber, context = {}) {
  // Meta rejected the Utility template "commission_voucher_otp" (a code must go in an
  // Authentication template, which carries only the code), so the voucher number is not sent.
  return sendTemplateMessage(phone, 'commission_voucher_code', [
    { name: '1', value: String(otp) },
  ], context, null, CATEGORIES.TRANSACTIONAL);
}

// Templates that are APPROVED in the WATI account and safe to send. A template
// that is still a draft would just log a FAILED row, so notifyUser() skips
// anything not listed here. Once Meta approves a new template, add its name to
// WATI_LIVE_TEMPLATES (comma-separated) in the env — no code change needed.
const DEFAULT_LIVE = [
  'site_visit_otp', 'phone_verification_otp', 'lead_assigned_notice',
  'buyer_feedback_request', 'contact_reply', 'ticket_vendor_dispatched',
];
const liveSet = (env = process.env) => new Set([...DEFAULT_LIVE, ...String(env.WATI_LIVE_TEMPLATES || '').split(',').map((t) => t.trim()).filter(Boolean)]);
const LIVE_TEMPLATES = liveSet();

// The new look (4 Nov 2026: footer "This is sent by Realtydoor", a smile, bold details). Approved templates cannot be edited in WATI, so each
// has a new version. A template resolves to its new version only once that version is listed in WATI_LIVE_TEMPLATES (i.e. Meta approved it);
// until then the old one keeps being sent, so nothing stops while Meta reviews. Variable names are identical in old and new.
// Wording and status: admin-nextjs/docs/WHATSAPP_TEMPLATES_REFRESH.md.
const TEMPLATE_UPGRADES = {
  visit_reminder_v2: 'visit_reminder_v3',
  partner_token_held: 'partner_token_held_v2',
  partner_payout_failed: 'partner_payout_failed_v2',
  partner_buyer_cancelled: 'partner_buyer_cancelled_v2',
  partner_support_reply: 'partner_support_reply_v2',
  partner_tax_invoice_needed: 'partner_tax_invoice_needed_v2',
  partner_tax_invoice_accepted: 'partner_tax_invoice_accepted_v2',
  partner_tax_invoice_rejected: 'partner_tax_invoice_rejected_v2',
  buyer_feedback_request: 'buyer_feedback_request_v3',
  buyer_feedback_request_v2: 'buyer_feedback_request_v3',
  escrow_token_received: 'escrow_token_received_v2',
  escrow_released: 'escrow_released_v2',
  escrow_refunded: 'escrow_refunded_v2',
  escrow_payment_failed: 'escrow_payment_failed_v2',
  buyer_ticket_update: 'buyer_ticket_update_v2',
  dispute_update: 'dispute_update_v2',
  loan_status_update: 'loan_status_update_v2',
  contact_reply: 'contact_reply_v2',
  listing_approved: 'listing_approved_v2',
  listing_rejected: 'listing_rejected_v2',
  listing_changes_requested: 'listing_changes_requested_v2',
  kyc_approved: 'kyc_approved_v2',
  kyc_rejected: 'kyc_rejected_v2',
  ticket_vendor_dispatched: 'ticket_vendor_dispatched_v3',
  ticket_vendor_dispatched_v2: 'ticket_vendor_dispatched_v3',
  lead_assigned_notice: 'lead_assigned_notice_v2',
  nri_video_tour_scheduled: 'nri_video_tour_scheduled_v2',
  lead_registration_received: 'lead_registration_received_v2',
  lead_registration_confirmed: 'lead_registration_confirmed_v2',
};

/** The template to actually send: the new version when it is live, otherwise the name as asked for. */
function resolveTemplate(name, live = LIVE_TEMPLATES) {
  const upgraded = TEMPLATE_UPGRADES[name];
  return upgraded && live.has(upgraded) ? upgraded : name;
}

// WhatsApp copies of the lead-rule messages (4 Nov 2026). Not sent until each name is added to WATI_LIVE_TEMPLATES once Meta approves it.
// Wording and variables: admin-nextjs/docs/WHATSAPP_TEMPLATES.md.
const LEAD_RULE_TEMPLATES = [
  'lead_registration_received', 'lead_registration_confirmed', 'lead_registration_not_credited', 'lead_registration_rejected',
  'lead_hold_ending', 'lead_registration_lapsed', 'lead_extension_approved', 'lead_extension_declined',
  'lead_drop_approved', 'lead_drop_rejected', 'lead_given_checkin',
];

// Fire-and-forget WhatsApp copy of an in-app notification. Looks up the user's
// phone and notifWhatsapp preference itself (OPERATIONAL category), never
// throws; pass '$userName' as a value to insert the recipient's own name — a failed WhatsApp must not break the action that triggered it.
async function notifyUser(userId, templateName, parameters, context = {}) {
  try {
    templateName = resolveTemplate(templateName);
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

// T13 — the v2 template is intimation only (a "Call us" button, no "reply here"). It is used as soon as it is listed in
// WATI_LIVE_TEMPLATES, i.e. once Meta has approved it; until then the approved v1 keeps being sent.
function ticketVendorDispatchedTemplate(env = process.env) {
  const live = String(env.WATI_LIVE_TEMPLATES || '').split(',').map((t) => t.trim());
  return live.includes('ticket_vendor_dispatched_v2') ? 'ticket_vendor_dispatched_v2' : 'ticket_vendor_dispatched';
}

async function sendTicketVendorDispatched(userId, ticketSubject, vendorName, ticketId) {
  return notifyUser(userId, ticketVendorDispatchedTemplate(), {
    ticket_subject: ticketSubject, vendor_name: vendorName,
  }, { ticketId });
}

module.exports = { LEAD_RULE_TEMPLATES, TEMPLATE_UPGRADES, resolveTemplate, liveSet,
  sendTemplateMessage,
  sendSiteVisitOtp,
  sendLeadAssignedNotice,
  sendBuyerFeedbackRequest,
  sendPhoneVerificationOtp,
  notifyUser,
  sendVoucherOtp,
  sendTicketVendorDispatched,
  ticketVendorDispatchedTemplate,
  isRecipientAllowed,
};
