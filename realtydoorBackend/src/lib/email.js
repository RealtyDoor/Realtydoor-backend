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

async function send({ to, subject, html, user, category }) {
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
    const info = await transporter.sendMail({ from: FROM, to, subject, html });
    logger.info('[Email] sent', { to, subject, messageId: info?.messageId, accepted: info?.accepted });
    return info;
  } catch (err) {
    logger.error('[Email] FAILED to send', { to, subject, code: err.code, responseCode: err.responseCode, error: err.message });
    throw err;
  }
}

async function sendLeadAssigned(email, { buyerName, propertyTitle }, user) {
  return send({
    to: email,
    subject: `New Lead Assigned — ${propertyTitle}`,
    html: `<p>A new lead from <strong>${buyerName}</strong> has been assigned to you for <strong>${propertyTitle}</strong>. Log in to your Partner panel to view details.</p>`,
    user,
  });
}

async function sendPropertyApproved(email, propertyTitle, user) {
  return send({
    to: email,
    subject: `Your listing "${propertyTitle}" is live!`,
    html: `<p>Great news! Your property listing <strong>${propertyTitle}</strong> has been approved and is now visible to buyers.</p>`,
    user,
  });
}

async function sendPropertyRejected(email, propertyTitle, note, user) {
  return send({
    to: email,
    subject: `Action required: "${propertyTitle}" needs changes`,
    html: `<p>Your listing <strong>${propertyTitle}</strong> was not approved. Admin note: <em>${note}</em></p>`,
    user,
  });
}

async function sendKycVerified(email, user) {
  return send({
    to: email,
    subject: 'Account Verified — Welcome to RealtyDoor!',
    html: `<p>Your KYC has been verified. You can now list properties and receive leads.</p>`,
    user,
  });
}

async function sendServiceActivated(email, serviceName, user) {
  return send({
    to: email,
    subject: `Service Activated — ${serviceName}`,
    html: `<p>Your <strong>${serviceName}</strong> subscription is now active. Raise tickets from your dashboard anytime.</p>`,
    user,
  });
}

async function sendKycRejected(email, note, user) {
  return send({
    to: email,
    subject: 'KYC Verification — Action Required',
    html: `<p>Your KYC documents could not be verified. Reason: <em>${note}</em>. Please re-submit with the correct documents from your partner profile.</p>`,
    user,
  });
}

// Receipts — always sent regardless of the notifEmail toggle (spec: "Receipts,
// OTPs and security or legal notices always go out").
async function sendEscrowHeld(email, amount, processingFeePaise = 0) {
  const fee = processingFeePaise > 0
    ? ` You also paid a payment processing fee of ₹${(processingFeePaise / 100).toLocaleString('en-IN')} (GST included), which is not returned if you cancel.`
    : '';
  return send({
    to: email,
    subject: 'Token Advance Received',
    html: `<p>Your token advance of <strong>₹${Number(amount).toLocaleString('en-IN')}</strong> has been received and is held in escrow with our payment partner until your allocation letter is verified.${fee}</p>`,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

// `detail` is optional so older callers keep the short wording; the cancel flow passes the charge kept and whether the
// processing fee came back, so the refund email says the same thing the checkout and the receipt say.
async function sendEscrowRefunded(email, amount, detail = {}) {
  const { chargeRupees = 0, feeReturned, propertyTitle } = detail;
  const forProperty = propertyTitle ? ` for <strong>${propertyTitle}</strong>` : '';
  const charge = chargeRupees > 0 ? ` A cancellation charge of <strong>₹${Number(chargeRupees).toLocaleString('en-IN')}</strong> was kept, as shown when you cancelled.` : '';
  const fee = feeReturned === undefined ? '' : (feeReturned ? ' The payment processing fee is returned too.' : ' The payment processing fee is not returned.');
  return send({
    to: email,
    subject: 'Token Advance Refunded',
    html: `<p>Your token advance of <strong>₹${Number(amount).toLocaleString('en-IN')}</strong>${forProperty} has been refunded to your original payment method.${charge}${fee} It may take 5–7 business days to reflect.</p>`,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

async function sendEscrowPaymentFailed(email) {
  return send({
    to: email,
    subject: 'Token Advance Payment Failed',
    html: `<p>Your token advance payment could not be processed. Please retry from your dashboard or contact support if the issue persists.</p>`,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

async function sendLoanStatusUpdate(email, status, note, loanId, user) {
  const readableStatus = status.replace(/_/g, ' ');
  // Dev feedback, 2026-10-08 (L5) — "Log in to your dashboard" named no
  // actual page; same /dashboard/loan stale-route problem as the
  // in-app notification, just pointed to nothing clickable at all.
  const path = status === 'SANCTIONED' && loanId ? `/user/loans/sanctioned?id=${loanId}` : '/user/loans';
  const link = `${process.env.FRONTEND_URL}${path}`;
  return send({
    to: email,
    subject: `Loan Application Update — ${readableStatus}`,
    html: `<p>Your loan application status has been updated to <strong>${readableStatus}</strong>.${note ? ` Admin note: <em>${note}</em>.` : ''} <a href="${link}">View your loan application</a> for full details.</p>`,
    user,
  });
}

async function sendLeadInquiryConfirmed(email, propertyTitle, user) {
  return send({
    to: email,
    subject: `Your Inquiry for "${propertyTitle}" is Being Processed`,
    html: `<p>Great news! Your inquiry for <strong>${propertyTitle}</strong> has been assigned to one of our verified partners. You will be contacted shortly to schedule a site visit.</p>`,
    user,
  });
}

// Sent once, right when an account is first created (auth.service.js's
// createAccount for phone-OTP signup, and syncUserByClerkId's
// !existing branch for a first-time Google sign-in) — never on a later
// login/resync. Content branches on role: a partner needs the KYC
// next-step, a buyer just needs a reason to start browsing.
async function sendWelcomeEmail(email, name, role, user) {
  const isPartner = role === 'PARTNER';
  return send({
    to: email,
    subject: isPartner ? 'Welcome to RealtyDoor — list your first property' : 'Welcome to RealtyDoor!',
    html: isPartner
      ? `<p>Hi ${name},</p><p>Welcome to RealtyDoor! Complete your KYC from your partner dashboard to start listing properties and receiving leads.</p>`
      : `<p>Hi ${name},</p><p>Welcome to RealtyDoor! Browse verified listings and save your favourites from your dashboard anytime.</p>`,
    user,
  });
}

const FRONTEND = () => process.env.FRONTEND_URL || '';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The visit code itself is never put in an email (it is WhatsApp-only, so it stays with the buyer's own phone).
async function sendVisitScheduled(email, { propertyTitle, whenText, partnerName, leadId }, user) {
  return send({
    to: email,
    subject: `Site visit scheduled — ${propertyTitle}`,
    html: `<p>Your site visit to <strong>${esc(propertyTitle)}</strong> is set for <strong>${esc(whenText)}</strong>${partnerName ? ` with ${esc(partnerName)}` : ''}.</p><p>Your visit code was sent to you on WhatsApp. Share it with the partner only when you are at the property. <a href="${FRONTEND()}/user/inquiries/${esc(leadId)}">View your inquiry</a>.</p>`,
    user,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

async function sendDisputeUpdate(email, { status, note }, user) {
  return send({
    to: email,
    subject: `Your report is ${status}`,
    html: `<p>Your report has moved to <strong>${esc(status)}</strong>.${note ? ` Note from our team: <em>${esc(note)}</em>.` : ''} <a href="${FRONTEND()}/user/disputes">See your reports</a>.</p>`,
    user,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

async function sendTicketUpdate(email, { subject, update, ticketId }, user) {
  return send({
    to: email,
    subject: `Update on your ticket — ${subject}`,
    html: `<p>There is an update on your ticket <strong>${esc(subject)}</strong>: ${esc(update)}</p><p><a href="${FRONTEND()}/user/tickets/${esc(ticketId)}">Open the ticket</a> to read it or reply.</p>`,
    user,
  });
}

async function sendVideoTourUpdate(email, { propertyTitle, whenText, completed }, user) {
  return send({
    to: email,
    subject: completed ? 'Your video tour is ready' : 'Your video tour is scheduled',
    html: completed
      ? `<p>Your video tour${propertyTitle ? ` of <strong>${esc(propertyTitle)}</strong>` : ''} has been completed. <a href="${FRONTEND()}/user/nri">Open your video tours</a>.</p>`
      : `<p>Your live video tour${propertyTitle ? ` of <strong>${esc(propertyTitle)}</strong>` : ''} is scheduled for <strong>${esc(whenText)}</strong>. Your Realtydoor partner will walk you through the property on a video call.</p>`,
    user,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

async function sendPartnerPayoutProcessed(email, { amountRupees, utr, leadRef }, user) {
  return send({
    to: email,
    subject: 'Your commission payout was processed',
    html: `<p>Your payout of <strong>₹${Number(amountRupees).toLocaleString('en-IN')}</strong>${leadRef ? ` for ${esc(leadRef)}` : ''} has been processed${utr ? ` (UTR ${esc(utr)})` : ''}. <a href="${FRONTEND()}/partners/finance/payouts">See Payouts &amp; paperwork</a>.</p>`,
    user,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

async function sendPartnerTaxInvoiceNeeded(email, { leadRef }, user) {
  return send({
    to: email,
    subject: 'Upload your tax invoice to get paid',
    html: `<p>The deal ${esc(leadRef)} is closed, and your commission is waiting for your GST tax invoice. <a href="${FRONTEND()}/partners/finance/payouts">Upload it from Payouts &amp; paperwork</a>. Your payout goes ahead after Realtydoor accepts it.</p>`,
    user,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

async function sendTaxInvoiceReviewed(email, { accepted, invoiceNumber, reason }, user) {
  return send({
    to: email,
    subject: accepted ? 'Your tax invoice was accepted' : 'Your tax invoice needs a correction',
    html: accepted
      ? `<p>Invoice <strong>${esc(invoiceNumber)}</strong> was accepted. Your commission payout can now go ahead. <a href="${FRONTEND()}/partners/finance/payouts">See Payouts &amp; paperwork</a>.</p>`
      : `<p>Invoice <strong>${esc(invoiceNumber)}</strong> was rejected: <em>${esc(reason)}</em>. Please upload a corrected invoice from <a href="${FRONTEND()}/partners/finance/payouts">Payouts &amp; paperwork</a>.</p>`,
    user,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

// No bank reason is put in the email: it can contain account details.
async function sendPartnerPayoutFailed(email, { leadRef }, user) {
  return send({
    to: email,
    subject: 'Your commission payout could not be completed',
    html: `<p>We could not complete the commission payout for ${esc(leadRef)}. Our team is looking into it and will contact you if we need anything from you. <a href="${FRONTEND()}/partners/finance">See your deals and payouts</a>.</p>`,
    user,
    category: CATEGORIES.TRANSACTIONAL,
  });
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
};
