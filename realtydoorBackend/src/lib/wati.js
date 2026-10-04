const axios = require('axios');
const logger = require('./logger');
const prisma = require('./prisma');

const client = axios.create({
  baseURL: process.env.WATI_API_ENDPOINT,
  headers: {
    Authorization: `Bearer ${process.env.WATI_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

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
async function sendTemplateMessage(phone, templateName, parameters = [], context = {}) {
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

async function sendSiteVisitOtp(phone, otp, context = {}) {
  return sendTemplateMessage(phone, 'site_visit_otp', [
    { name: '1', value: String(otp) },
  ], context);
}

async function sendLeadAssignedNotice(phone, partnerName, context = {}) {
  return sendTemplateMessage(phone, 'lead_assigned_notice', [
    { name: 'partner_name', value: partnerName },
  ], context);
}

async function sendBuyerFeedbackRequest(phone, partnerName, context = {}) {
  return sendTemplateMessage(phone, 'buyer_feedback_request', [
    { name: 'partner_name', value: partnerName },
  ], context);
}

async function sendPhoneVerificationOtp(phone, otp, context = {}) {
  return sendTemplateMessage(phone, 'phone_verification_otp', [
    { name: '1', value: String(otp) },
  ], context);
}

module.exports = {
  sendTemplateMessage,
  sendSiteVisitOtp,
  sendLeadAssignedNotice,
  sendBuyerFeedbackRequest,
  sendPhoneVerificationOtp,
};
