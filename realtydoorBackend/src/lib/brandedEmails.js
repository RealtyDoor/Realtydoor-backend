'use strict';

// The emails Realtydoor sends to buyers and partners about their own activity, all in the branded layout (src/lib/emailShell.js).
// A pure re-skin of the earlier plain emails (Nov 2026): same subjects, same sentences (the money, fee and cancel-charge wording is unchanged),
// same recipients and same preferences; only the look is new, plus a clear button to the right page. Every value a person typed is escaped here;
// subjects are plain text. The visit code and bank details are never put in an email.
const { esc, renderEmail, BLUE } = require('./emailShell');
const { portalUrl } = require('./portalUrl');
const { receiptNumber } = require('./pdfReceipt');

const FRONTEND = () => String(process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
const paise = (p) => `₹${(Number(p) / 100).toLocaleString('en-IN')}`;
const istStamp = (d) => { try { return `${new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST`; } catch { return ''; } };

const BUYER = 'You are receiving this because of your Realtydoor account.';
const BUYER_MONEY = 'You are receiving this because of a payment on your Realtydoor account. Receipts and payment notices are always sent.';
const PARTNER = 'You are receiving this because you are a Realtydoor partner.';
const PARTNER_MONEY = 'You are receiving this because of your commission with Realtydoor. Payment and tax notices are always sent.';

// Each builder returns the parts of one email. `headline` is plain text (escaped when rendered).
const BUILDERS = {
  // ── Partner ────────────────────────────────────────────────────────────────────────────────────────────────────
  lead_assigned: ({ buyerName, propertyTitle }) => ({
    subject: `New Lead Assigned — ${propertyTitle}`,
    preheader: 'A new buyer lead is waiting for you in your partner panel.',
    headline: 'You have a new lead',
    introHtml: `A new lead from <strong>${esc(buyerName)}</strong> has been assigned to you for <strong>${esc(propertyTitle)}</strong>. Log in to your Partner panel to view details.`,
    details: [['Buyer', buyerName], ['Property', propertyTitle]],
    button: { label: 'Open your partner panel', url: `${FRONTEND()}/partners/leads` },
    reason: PARTNER,
  }),
  property_approved: ({ propertyTitle }) => ({
    subject: `Your listing "${propertyTitle}" is live!`,
    preheader: 'Your listing has been approved and buyers can see it.',
    headline: 'Your listing is live',
    introHtml: `Great news! Your property listing <strong>${esc(propertyTitle)}</strong> has been approved and is now visible to buyers.`,
    button: { label: 'View your listings', url: `${FRONTEND()}/partners/listings` },
    reason: PARTNER,
  }),
  property_rejected: ({ propertyTitle, note }) => ({
    subject: `Action required: "${propertyTitle}" needs changes`,
    preheader: 'Your listing was not approved yet. Here is what to change.',
    headline: 'Your listing needs changes',
    introHtml: `Your listing <strong>${esc(propertyTitle)}</strong> was not approved. Admin note: <em>${esc(note)}</em>`,
    button: { label: 'Update your listing', url: `${FRONTEND()}/partners/listings` },
    reason: PARTNER,
  }),
  kyc_verified: () => ({
    subject: 'Account Verified — Welcome to RealtyDoor!',
    preheader: 'Your KYC is verified. You can now list properties and receive leads.',
    headline: 'You are verified',
    introHtml: 'Your KYC has been verified. You can now list properties and receive leads.',
    button: portalUrl('partner') ? { label: 'Open the partner portal', url: portalUrl('partner') } : undefined,
    noteHtml: 'Sign in with the same Google account or email you registered with. Please use this address only: partners cannot sign in on the buyer app or the admin site.',
    reason: PARTNER,
  }),
  kyc_rejected: ({ note }) => ({
    subject: 'KYC Verification — Action Required',
    preheader: 'Your KYC documents could not be verified. Please send them again.',
    headline: 'Your KYC needs another look',
    introHtml: `Your KYC documents could not be verified. Reason: <em>${esc(note)}</em>. Please re-submit with the correct documents from your partner profile.`,
    button: { label: 'Open your partner profile', url: `${FRONTEND()}/partners/profile` },
    reason: PARTNER,
  }),
  partner_payout_processed: ({ amountRupees, utr, leadRef }) => ({
    subject: 'Your commission payout was processed',
    preheader: 'Your commission has been paid out.',
    headline: 'Your payout was processed',
    introHtml: `Your payout of <strong>${esc(rupees(amountRupees))}</strong>${leadRef ? ` for ${esc(leadRef)}` : ''} has been processed${utr ? ` (UTR ${esc(utr)})` : ''}.`,
    details: [['Amount', rupees(amountRupees)], ['Deal', leadRef], ['Bank reference (UTR)', utr]],
    button: { label: 'See Payouts & paperwork', url: `${FRONTEND()}/partners/finance/payouts` },
    reason: PARTNER_MONEY,
  }),
  partner_tax_invoice_needed: ({ leadRef }) => ({
    subject: 'Upload your tax invoice to get paid',
    preheader: 'Your commission is waiting for your GST tax invoice.',
    headline: 'Upload your tax invoice',
    introHtml: `The deal ${esc(leadRef)} is closed, and your commission is waiting for your GST tax invoice. Upload it from Payouts &amp; paperwork. Your payout goes ahead after Realtydoor accepts it.`,
    details: [['Deal', leadRef]],
    button: { label: 'Upload your invoice', url: `${FRONTEND()}/partners/finance/payouts` },
    reason: PARTNER_MONEY,
  }),
  tax_invoice_reviewed: ({ accepted, invoiceNumber, reason }) => (accepted
    ? {
      subject: 'Your tax invoice was accepted',
      preheader: 'Your commission payout can now go ahead.',
      headline: 'Your tax invoice was accepted',
      introHtml: `Invoice <strong>${esc(invoiceNumber)}</strong> was accepted. Your commission payout can now go ahead.`,
      details: [['Invoice', invoiceNumber]],
      button: { label: 'See Payouts & paperwork', url: `${FRONTEND()}/partners/finance/payouts` },
      reason: PARTNER_MONEY,
    }
    : {
      subject: 'Your tax invoice needs a correction',
      preheader: 'Please upload a corrected tax invoice.',
      headline: 'Your tax invoice needs a correction',
      introHtml: `Invoice <strong>${esc(invoiceNumber)}</strong> was rejected: <em>${esc(reason)}</em>. Please upload a corrected invoice from Payouts &amp; paperwork.`,
      details: [['Invoice', invoiceNumber], ['Reason', reason]],
      button: { label: 'Upload a corrected invoice', url: `${FRONTEND()}/partners/finance/payouts` },
      reason: PARTNER_MONEY,
    }),
  // No bank reason is put in the email: it can contain account details.
  partner_payout_failed: ({ leadRef }) => ({
    subject: 'Your commission payout could not be completed',
    preheader: 'We could not complete your payout. Our team is looking into it.',
    headline: 'Your payout could not be completed',
    introHtml: `We could not complete the commission payout for ${esc(leadRef)}. Our team is looking into it and will contact you if we need anything from you.`,
    details: [['Deal', leadRef]],
    button: { label: 'See your deals and payouts', url: `${FRONTEND()}/partners/finance` },
    reason: PARTNER_MONEY,
  }),

  // ── Buyer ──────────────────────────────────────────────────────────────────────────────────────────────────────
  service_activated: ({ serviceName }) => ({
    subject: `Service Activated — ${serviceName}`,
    preheader: 'Your subscription is now active.',
    headline: 'Your service is active',
    introHtml: `Your <strong>${esc(serviceName)}</strong> subscription is now active. Raise tickets from your dashboard anytime.`,
    details: [['Service', serviceName]],
    button: { label: 'Open your dashboard', url: `${FRONTEND()}/user/dashboard` },
    reason: BUYER,
  }),
  // Our own receipt, sent in addition to Razorpay's payment confirmation. With `receipt` it carries the full receipt details and says so; without it
  // (older callers) it keeps the short form. The sentence about escrow, the fee and cancelling is unchanged.
  escrow_held: ({ amount, processingFeePaise = 0, receipt = null }) => {
    const fee = processingFeePaise > 0
      ? ` You also paid a payment processing fee of ₹${(processingFeePaise / 100).toLocaleString('en-IN')} (GST included), which is not returned if you cancel.`
      : '';
    // No fee of ours on this payment: say so, and who collects the gateway's charge (only when Razorpay's Customer Fee Bearer is on).
    const noFee = !(processingFeePaise > 0) && receipt && receipt.feeBearer === 'CUSTOMER'
      ? ' Realtydoor adds no fee to this payment. Any payment-gateway charge was shown and collected by Razorpay at checkout.' : '';
    const feeRow = processingFeePaise > 0 ? [['Payment processing fee (GST included)', paise(processingFeePaise)]] : [];
    const totalPaise = receipt && receipt.chargedPaise > 0 ? receipt.chargedPaise : Math.round(Number(amount) * 100) + (processingFeePaise > 0 ? processingFeePaise : 0);
    const details = receipt
      ? [
        ['Receipt no.', receiptNumber(receipt.razorpayPaymentId)], ['Deal reference', receipt.refCode], ['Property', receipt.propertyTitle],
        ['Paid on', receipt.paidAt ? istStamp(receipt.paidAt) : ''], ['Token advance', rupees(amount)], ...feeRow,
        ...(noFee ? [['Payment gateway charge', 'Collected by Razorpay'], ['Paid to Realtydoor', paise(totalPaise)]] : [['Total paid', paise(totalPaise)]]),
        ['Payment reference', receipt.razorpayPaymentId],
      ]
      : [['Token advance', rupees(amount)], ...feeRow];
    return {
      subject: 'Token Advance Received',
      preheader: 'Your Realtydoor receipt: we have received your token advance. It is held in escrow.',
      headline: 'Token advance received',
      introHtml: `Your token advance of <strong>${esc(rupees(amount))}</strong> has been received and is held in escrow with our payment partner until your allocation letter is verified.${esc(fee)}${esc(noFee)}`,
      details,
      button: { label: 'See your inquiries', url: `${FRONTEND()}/user/inquiries` },
      noteHtml: receipt ? `This is your Realtydoor receipt${receipt.hasPdf ? ', and a PDF copy is attached' : ''}. Razorpay, our payment partner, also sends its own payment confirmation separately.` : '',
      reason: BUYER_MONEY,
    };
  },
  // `detail` is optional so older callers keep the short wording; the cancel flow passes the charge kept and whether the processing fee came back,
  // so the refund email says the same thing the checkout and the receipt say.
  // Payment audit 21 Nov 2026 (Razorpay Customer Fee Bearer; owner: refunds are the token at most, our rare mistakes settled offline):
  // with no processing fee of ours on the payment (feeReturned undefined) the email names Razorpay's own charge as not returned, with
  // its amount when known, and EVERY refund email says how to raise a request. `partial` words a part refund.
  escrow_refunded: ({ amount, chargeRupees = 0, feeReturned, propertyTitle, receipt = null, gatewayChargePaise = null, partial = false }) => {
    const forProperty = propertyTitle ? ` for <strong>${esc(propertyTitle)}</strong>` : '';
    const charge = chargeRupees > 0 ? ` A cancellation charge of <strong>${esc(rupees(chargeRupees))}</strong> was kept, as shown when you cancelled.` : '';
    // Known amount: named. Known zero (Razorpay took nothing on this payment): nothing to say. Unknown (older payment): the plain sentence.
    const gateway = gatewayChargePaise === 0 ? ''
      : Number.isInteger(gatewayChargePaise) && gatewayChargePaise > 0
        ? ` Razorpay's payment-gateway charge of <strong>${esc(paise(gatewayChargePaise))}</strong> is not returned: Razorpay keeps it.`
        : " Razorpay's payment-gateway charge is not returned: Razorpay keeps it.";
    const fee = feeReturned === undefined ? gateway : (feeReturned ? ' The payment processing fee is returned too.' : ' The payment processing fee is not returned.');
    const what = partial
      ? `<strong>${esc(rupees(amount))}</strong> of your token advance${forProperty} has been refunded to your original payment method.`
      : `Your token advance of <strong>${esc(rupees(amount))}</strong>${forProperty} has been refunded to your original payment method.`;
    const request = `If you think we made a mistake, <a href="${FRONTEND()}/user/disputes/new" style="color:${BLUE};">raise a request</a> and our team will look into it.`;
    return {
      subject: partial ? 'Part of Your Token Advance Refunded' : 'Token Advance Refunded',
      preheader: partial ? 'Part of your token advance has been refunded to your original payment method.' : 'Your token advance has been refunded to your original payment method.',
      headline: partial ? 'Part of your token advance was refunded' : 'Your token advance was refunded',
      introHtml: `${what}${charge}${fee} It may take 5–7 business days to reflect.`,
      details: [['Refunded', rupees(amount)], ['Property', propertyTitle], ...(chargeRupees > 0 ? [['Charge kept', rupees(chargeRupees)]] : []),
        ...(feeReturned === undefined && Number.isInteger(gatewayChargePaise) && gatewayChargePaise > 0 ? [["Razorpay's charge (kept by Razorpay)", paise(gatewayChargePaise)]] : []),
        ...(receipt ? [['Deal reference', receipt.refCode], ['Refunded on', receipt.refundedAt ? istStamp(receipt.refundedAt) : ''], ['Refund reference', receipt.razorpayRefundId]] : [])],
      noteHtml: `${receipt ? `This is your Realtydoor refund receipt${receipt.hasPdf ? ', and a PDF copy is attached' : ''}. Razorpay also sends its own refund confirmation separately. ` : ''}${request}`,
      reason: BUYER_MONEY,
    };
  },
  escrow_payment_failed: () => ({
    subject: 'Token Advance Payment Failed',
    preheader: 'Your token advance payment could not be processed.',
    headline: 'Your payment did not go through',
    introHtml: 'Your token advance payment could not be processed. Please retry from your dashboard or contact support if the issue persists.',
    button: { label: 'Retry from your dashboard', url: `${FRONTEND()}/user/dashboard` },
    reason: BUYER_MONEY,
  }),
  loan_status_update: ({ status, note, loanId }) => {
    const readable = String(status).replace(/_/g, ' ');
    // The sanctioned loan page needs the loan id; every other status opens the loans list.
    const path = status === 'SANCTIONED' && loanId ? `/user/loans/sanctioned?id=${loanId}` : '/user/loans';
    return {
      subject: `Loan Application Update — ${readable}`,
      preheader: `Your loan application is now: ${readable}.`,
      headline: 'Your loan application was updated',
      introHtml: `Your loan application status has been updated to <strong>${esc(readable)}</strong>.${note ? ` Admin note: <em>${esc(note)}</em>.` : ''}`,
      details: [['Status', readable], ['Note', note]],
      button: { label: 'View your loan application', url: `${FRONTEND()}${path}` },
      reason: BUYER,
    };
  },
  lead_inquiry_confirmed: ({ propertyTitle }) => ({
    subject: `Your Inquiry for "${propertyTitle}" is Being Processed`,
    preheader: 'A verified partner has your inquiry.',
    headline: 'Your inquiry is being processed',
    introHtml: `Great news! Your inquiry for <strong>${esc(propertyTitle)}</strong> has been assigned to one of our verified partners. You will be contacted shortly to schedule a site visit.`,
    details: [['Property', propertyTitle]],
    button: { label: 'See your inquiries', url: `${FRONTEND()}/user/inquiries` },
    reason: BUYER,
  }),
  // The visit code itself is never put in an email (it is WhatsApp-only, so it stays with the buyer's own phone).
  visit_scheduled: ({ propertyTitle, whenText, partnerName, leadId }) => ({
    subject: `Site visit scheduled — ${propertyTitle}`,
    preheader: 'Your site visit is booked.',
    headline: 'Your site visit is scheduled',
    introHtml: `Your site visit to <strong>${esc(propertyTitle)}</strong> is set for <strong>${esc(whenText)}</strong>${partnerName ? ` with ${esc(partnerName)}` : ''}.<br><br>Your visit code was sent to you on WhatsApp. Share it with the partner only when you are at the property.`,
    details: [['Property', propertyTitle], ['When', whenText], ['With', partnerName]],
    button: { label: 'View your inquiry', url: `${FRONTEND()}/user/inquiries/${encodeURIComponent(String(leadId ?? ''))}` },
    reason: 'You are receiving this because of a site visit you booked on Realtydoor.',
  }),
  dispute_update: ({ status, note }) => ({
    subject: `Your report is ${status}`,
    preheader: `Your report is now ${status}.`,
    headline: 'An update on your report',
    introHtml: `Your report has moved to <strong>${esc(status)}</strong>.${note ? ` Note from our team: <em>${esc(note)}</em>.` : ''}`,
    details: [['Status', status], ['Note', note]],
    button: { label: 'See your reports', url: `${FRONTEND()}/user/disputes` },
    reason: BUYER,
  }),
  ticket_update: ({ subject, update, ticketId }) => ({
    subject: `Update on your ticket — ${subject}`,
    preheader: 'Our team replied on your support ticket.',
    headline: 'There is an update on your ticket',
    introHtml: `There is an update on your ticket <strong>${esc(subject)}</strong>: ${esc(update)}<br><br>Open the ticket to read it or reply.`,
    button: { label: 'Open the ticket', url: `${FRONTEND()}/user/tickets/${encodeURIComponent(String(ticketId ?? ''))}` },
    reason: BUYER,
  }),
  video_tour_update: ({ propertyTitle, whenText, completed }) => ({
    subject: completed ? 'Your video tour is ready' : 'Your video tour is scheduled',
    preheader: completed ? 'Your video tour has been completed.' : 'Your live video tour is booked.',
    headline: completed ? 'Your video tour is ready' : 'Your video tour is scheduled',
    introHtml: completed
      ? `Your video tour${propertyTitle ? ` of <strong>${esc(propertyTitle)}</strong>` : ''} has been completed.`
      : `Your live video tour${propertyTitle ? ` of <strong>${esc(propertyTitle)}</strong>` : ''} is scheduled for <strong>${esc(whenText)}</strong>. Your Realtydoor partner will walk you through the property on a video call.`,
    details: [['Property', propertyTitle], ...(completed ? [] : [['When', whenText]])],
    button: completed ? { label: 'Open your video tours', url: `${FRONTEND()}/user/nri` } : undefined,
    reason: BUYER,
  }),
};

/** The subject, HTML and inline attachments of one branded email. `inline: true` puts the images in the page (for a browser preview). */
function buildBranded(key, vars = {}, { inline = false } = {}) {
  const make = BUILDERS[key];
  if (!make) throw new Error(`No email design called "${key}".`);
  const p = make(vars);
  const { html, attachments } = renderEmail({
    title: p.headline, preheader: p.preheader, headlineHtml: esc(p.headline), introHtml: p.introHtml, details: p.details,
    stepsTitle: p.stepsTitle, steps: p.steps, button: p.button, noteHtml: p.noteHtml || '', reason: p.reason, inline,
  });
  return { subject: p.subject, html, attachments };
}

module.exports = { buildBranded, BUILDERS };
