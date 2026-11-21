const nodemailer = require('nodemailer');
const { canSend, CATEGORIES } = require('./notificationGate');
const logger = require('./logger');

const FROM_ADDRESS = process.env.EMAIL_FROM;
// Shown to recipients as: RealtyDoor <support@realtydoor.com>
const FROM = FROM_ADDRESS ? `"RealtyDoor" <${FROM_ADDRESS}>` : FROM_ADDRESS;
// The mailbox that logs in to Gmail SMTP. It is the same as EMAIL_FROM unless EMAIL_SMTP_USER says otherwise
// (Gmail only lets an account send as itself or as an alias set up inside that account).
const SMTP_USER = process.env.EMAIL_SMTP_USER || FROM_ADDRESS;

// Gmail SMTP via an app password (not OAuth) — GMAIL_APP_PASSWORD is a
// 16-character app password generated from the sending Gmail account's
// security settings, not the account's real login password. Previously
// this was Resend, but the real credential configured in .env was always
// shaped like a Gmail app password (four lowercase groups), not a Resend
// key (`re_...`) — every send has been silently failing since
// send()/sendMail() calls are fire-and-forget throughout this codebase.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

// Every caller fires this and forgets (`.catch(() => {})`), so a failing mailbox used to be invisible. Log the
// outcome here, once, for every email the app sends. The error is still thrown so callers behave as before.
// Outside production, EMAIL_ALLOWED_RECIPIENTS (comma-separated addresses, or @domain.com for a whole domain) limits who a
// test run can email, the same idea as WATI_ALLOWED_NUMBERS for WhatsApp. Unset = no limit. Production ignores it.
function isRecipientAllowed(to, env = process.env) {
  if (env.NODE_ENV === 'production') return true;
  const list = String(env.EMAIL_ALLOWED_RECIPIENTS || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  const addr = String(to || '').trim().toLowerCase();
  return list.some((entry) => (entry.startsWith('@') ? addr.endsWith(entry) : addr === entry));
}

async function send({ to, subject, html, user, category, attachments }) {
  if (!to) {
    logger.warn('[Email] skipped: no recipient address', { subject });
    return null;
  }
  if (!isRecipientAllowed(to)) {
    logger.warn('[Email] blocked: recipient not in EMAIL_ALLOWED_RECIPIENTS', { subject });
    return null;
  }
  if (!canSend({ user, channel: 'EMAIL', category })) {
    logger.info('[Email] skipped: recipient turned email notifications off', { to, subject });
    return null;
  }
  try {
    const info = await transporter.sendMail({ from: FROM, to, subject, html, ...(attachments?.length ? { attachments } : {}) });
    logger.info('[Email] sent', { to, subject, messageId: info?.messageId, accepted: info?.accepted });
    return info;
  } catch (err) {
    logger.error('[Email] FAILED to send', { to, subject, code: err.code, responseCode: err.responseCode, error: err.message });
    throw err;
  }
}

async function sendLeadAssigned(email, { buyerName, propertyTitle }, user) {
  const built = buildBranded('lead_assigned', { buyerName, propertyTitle });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

async function sendPropertyApproved(email, propertyTitle, user) {
  const built = buildBranded('property_approved', { propertyTitle });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

async function sendPropertyRejected(email, propertyTitle, note, user) {
  const built = buildBranded('property_rejected', { propertyTitle, note });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

const { portalUrl } = require('./portalUrl');
const { buildWelcomeEmail, buildFormEmail } = require('./welcomeEmailHtml');
const { buildBranded } = require('./brandedEmails');
const { receiptNumber } = require('./pdfReceipt');
const signInLine = (kind) => {
  const url = portalUrl(kind);
  if (!url) return '';
  const who = kind === 'partner' ? 'partner portal' : 'Realtydoor app';
  return `<p><strong>How to sign in:</strong> open the ${who} at <a href="${url}">${url}</a> and sign in with the same Google account or email you registered with. Please use this address (partners cannot sign in on the buyer app or the admin site).</p>`;
};

async function sendKycVerified(email, user) {
  const built = buildBranded('kyc_verified', {});
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

async function sendServiceActivated(email, serviceName, user) {
  const built = buildBranded('service_activated', { serviceName });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

async function sendKycRejected(email, note, user) {
  const built = buildBranded('kyc_rejected', { note });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

// Receipts — always sent regardless of the notifEmail toggle (spec: "Receipts,
// OTPs and security or legal notices always go out").
// `receipt` (optional): { pdf (Buffer), refCode, propertyTitle, chargedPaise, razorpayPaymentId, paidAt }. With it the email is our full receipt with the PDF attached.
async function sendEscrowHeld(email, amount, processingFeePaise = 0, receipt = null) {
  const { pdf, ...rest } = receipt || {};
  const built = buildBranded('escrow_held', { amount, processingFeePaise, receipt: receipt ? { ...rest, hasPdf: !!pdf } : null });
  const files = pdf ? [{ filename: `Realtydoor-receipt-${receiptNumber(rest.razorpayPaymentId)}.pdf`, content: pdf, contentType: 'application/pdf' }] : [];
  return send({ to: email, subject: built.subject, html: built.html, attachments: [...built.attachments, ...files], category: CATEGORIES.TRANSACTIONAL });
}

// `detail` is optional so older callers keep the short wording; the cancel flow passes the charge kept and whether the
// processing fee came back, so the refund email says the same thing the checkout and the receipt say.
// `detail.receipt` (optional): { pdf (Buffer), refCode, refundedAt, razorpayRefundId }. With it the email is our refund receipt with the PDF attached.
async function sendEscrowRefunded(email, amount, detail = {}) {
  const { receipt: r, ...rest } = detail;
  const { pdf, ...receiptRest } = r || {};
  const built = buildBranded('escrow_refunded', { amount, ...rest, receipt: r ? { ...receiptRest, hasPdf: !!pdf } : null });
  const files = pdf ? [{ filename: 'Realtydoor-refund-receipt.pdf', content: pdf, contentType: 'application/pdf' }] : [];
  return send({ to: email, subject: built.subject, html: built.html, attachments: [...built.attachments, ...files], category: CATEGORIES.TRANSACTIONAL });
}

async function sendEscrowPaymentFailed(email) {
  const built = buildBranded('escrow_payment_failed', {});
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, category: CATEGORIES.TRANSACTIONAL });
}

async function sendLoanStatusUpdate(email, status, note, loanId, user) {
  const built = buildBranded('loan_status_update', { status, note, loanId });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

async function sendLeadInquiryConfirmed(email, propertyTitle, user) {
  const built = buildBranded('lead_inquiry_confirmed', { propertyTitle });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

// Sent once, right when an account is first created (auth.service.js's
// createAccount for phone-OTP signup, and syncUserByClerkId's
// !existing branch for a first-time Google sign-in) — never on a later
// login/resync. Content branches on role: a partner needs the KYC
// next-step, a buyer just needs a reason to start browsing.
// Build-out form emails to the builder / owner (not an account holder, so no `user` and no notification preferences).
async function sendOnboardingFormReady(email, { name, title, formUrl, expiresAt }) {
  const { subject, html, attachments } = buildFormEmail('ready', { name, title, formUrl, expiresAt });
  return send({ to: email, subject, html, attachments });
}
// A status change on the request ('in_discussion', 'ready_to_list', 'listing_created', 'closed'): the sender is told, by email, what the team did.
async function sendOnboardingUpdate(email, kind, { name, title }) {
  const { subject, html, attachments } = buildFormEmail(kind, { name, title });
  return send({ to: email, subject, html, attachments });
}
async function sendOnboardingReceived(email, { name, title }) {
  const { subject, html, attachments } = buildFormEmail('received', { name, title });
  return send({ to: email, subject, html, attachments });
}

async function sendWelcomeEmail(email, name, role, user) {
  const { subject, html, attachments } = buildWelcomeEmail(name, role);
  return send({ to: email, subject, html, user, attachments });
}

const FRONTEND = () => process.env.FRONTEND_URL || '';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The visit code itself is never put in an email (it is WhatsApp-only, so it stays with the buyer's own phone).
async function sendVisitScheduled(email, { propertyTitle, whenText, partnerName, leadId }, user) {
  const built = buildBranded('visit_scheduled', { propertyTitle, whenText, partnerName, leadId });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user, category: CATEGORIES.TRANSACTIONAL });
}

async function sendDisputeUpdate(email, { status, note }, user) {
  const built = buildBranded('dispute_update', { status, note });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user, category: CATEGORIES.TRANSACTIONAL });
}

async function sendTicketUpdate(email, { subject, update, ticketId }, user) {
  const built = buildBranded('ticket_update', { subject, update, ticketId });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user });
}

async function sendVideoTourUpdate(email, { propertyTitle, whenText, completed }, user) {
  const built = buildBranded('video_tour_update', { propertyTitle, whenText, completed });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user, category: CATEGORIES.TRANSACTIONAL });
}

async function sendPartnerPayoutProcessed(email, { amountRupees, utr, leadRef }, user) {
  const built = buildBranded('partner_payout_processed', { amountRupees, utr, leadRef });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user, category: CATEGORIES.TRANSACTIONAL });
}

async function sendPartnerTaxInvoiceNeeded(email, { leadRef }, user) {
  const built = buildBranded('partner_tax_invoice_needed', { leadRef });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user, category: CATEGORIES.TRANSACTIONAL });
}

async function sendTaxInvoiceReviewed(email, { accepted, invoiceNumber, reason }, user) {
  const built = buildBranded('tax_invoice_reviewed', { accepted, invoiceNumber, reason });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user, category: CATEGORIES.TRANSACTIONAL });
}

// No bank reason is put in the email: it can contain account details.
async function sendPartnerPayoutFailed(email, { leadRef }, user) {
  const built = buildBranded('partner_payout_failed', { leadRef });
  return send({ to: email, subject: built.subject, html: built.html, attachments: built.attachments, user, category: CATEGORIES.TRANSACTIONAL });
}

module.exports = {
  send,
  isRecipientAllowed,
  sendLeadAssigned,
  sendPropertyApproved,
  sendPropertyRejected,
  sendKycVerified,
  sendServiceActivated,
  sendKycRejected,
  sendEscrowHeld,
  sendEscrowRefunded,
  sendVisitScheduled,
  sendDisputeUpdate,
  sendTicketUpdate,
  sendVideoTourUpdate,
  sendPartnerPayoutProcessed,
  sendPartnerTaxInvoiceNeeded,
  sendTaxInvoiceReviewed,
  sendPartnerPayoutFailed,
  sendEscrowPaymentFailed,
  sendLoanStatusUpdate,
  sendLeadInquiryConfirmed,
  sendWelcomeEmail,
  sendOnboardingFormReady,
  sendOnboardingReceived,
  sendOnboardingUpdate,
  portalUrl,
};
