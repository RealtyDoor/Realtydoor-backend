const { Resend } = require('resend');
const { canSend, CATEGORIES } = require('./notificationGate');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM;

async function send({ to, subject, html, user, category }) {
  if (!canSend({ user, channel: 'EMAIL', category })) return null;
  return resend.emails.send({ from: FROM, to, subject, html });
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
async function sendEscrowHeld(email, amount) {
  return send({
    to: email,
    subject: 'Token Advance Received',
    html: `<p>Your token advance of <strong>₹${Number(amount).toLocaleString('en-IN')}</strong> has been received and is held securely until your deal closes.</p>`,
    category: CATEGORIES.TRANSACTIONAL,
  });
}

async function sendEscrowRefunded(email, amount) {
  return send({
    to: email,
    subject: 'Token Advance Refunded',
    html: `<p>Your token advance of <strong>₹${Number(amount).toLocaleString('en-IN')}</strong> has been refunded to your original payment method. It may take 5–7 business days to reflect.</p>`,
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

module.exports = {
  sendLeadAssigned,
  sendPropertyApproved,
  sendPropertyRejected,
  sendKycVerified,
  sendServiceActivated,
  sendKycRejected,
  sendEscrowHeld,
  sendEscrowRefunded,
  sendEscrowPaymentFailed,
  sendLoanStatusUpdate,
  sendLeadInquiryConfirmed,
};
