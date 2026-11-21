/**
 * Writes a browser-viewable preview of every branded email (images inlined) into admin-nextjs/docs/email-preview/, with sample data.
 * Nothing is sent. Run: node scripts/renderEmailPreviews.js
 */
const fs = require('fs');
const path = require('path');
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.realtydoor.com';
const { buildBranded } = require('../src/lib/brandedEmails');
const { buildWelcomeEmail, buildFormEmail } = require('../src/lib/welcomeEmailHtml');

const OUT = path.resolve(__dirname, '../../../admin-nextjs/docs/email-preview');
fs.mkdirSync(OUT, { recursive: true });

const SAMPLE = {
  lead_assigned: { buyerName: 'Anita Rao', propertyTitle: 'Vrunda City Gated Plots' },
  property_approved: { propertyTitle: 'Vrunda City Gated Plots' },
  property_rejected: { propertyTitle: 'Green Park Chintamani', note: 'Please add the RERA certificate and a clearer cover photo.' },
  kyc_verified: {},
  kyc_rejected: { note: 'The PAN card photo is blurred. Please upload a clear copy.' },
  partner_payout_processed: { amountRupees: 52500, utr: 'UTR2611200012345', leadRef: 'RD-L-000105' },
  partner_tax_invoice_needed: { leadRef: 'RD-L-000105' },
  'tax_invoice_reviewed-accepted': { accepted: true, invoiceNumber: 'INV-2026-014' },
  'tax_invoice_reviewed-rejected': { accepted: false, invoiceNumber: 'INV-2026-014', reason: 'GSTIN does not match your registration.' },
  partner_payout_failed: { leadRef: 'RD-L-000105' },
  service_activated: { serviceName: 'Legal document check' },
  escrow_held: { amount: 50000, processingFeePaise: 120900, receipt: { hasPdf: true, refCode: 'RD-L-000107', propertyTitle: 'Vrunda City Gated Plots', chargedPaise: 5120900, razorpayPaymentId: 'pay_ABCD1234efgh', paidAt: '2026-11-20T06:30:00Z' } },
  escrow_refunded: { amount: 50000, gatewayChargePaise: 118000, propertyTitle: 'Vrunda City Gated Plots', receipt: { hasPdf: true, refCode: 'RD-L-000107', refundedAt: '2026-11-22T09:00:00Z', razorpayRefundId: 'rfnd_Nk29Xa7' } },
  escrow_payment_failed: {},
  loan_status_update: { status: 'SANCTIONED', note: 'Sanction letter is ready.', loanId: 'LN123' },
  lead_inquiry_confirmed: { propertyTitle: 'Vrunda City Gated Plots' },
  visit_scheduled: { propertyTitle: 'Vrunda City Gated Plots', whenText: 'Sat, 22 Nov, 11:00 am IST', partnerName: 'Dev One', leadId: 'L123' },
  dispute_update: { status: 'resolved', note: 'The refund has been sent.' },
  ticket_update: { subject: 'Tap leak', update: 'A plumber has been assigned for Friday.', ticketId: 'T123' },
  'video_tour_update-scheduled': { propertyTitle: 'Vrunda City Gated Plots', whenText: 'Fri, 21 Nov, 9:00 pm IST', completed: false },
  'video_tour_update-ready': { propertyTitle: 'Vrunda City Gated Plots', completed: true },
};

let n = 0;
for (const [name, vars] of Object.entries(SAMPLE)) {
  const key = name.replace(/-(accepted|rejected|scheduled|ready)$/, '');
  fs.writeFileSync(path.join(OUT, `mail-${name}.html`), buildBranded(key, vars, { inline: true }).html);
  n += 1;
}
fs.writeFileSync(path.join(OUT, 'welcome-buyer.html'), buildWelcomeEmail('Anil Machireddy', 'USER', { inline: true }).html);
fs.writeFileSync(path.join(OUT, 'welcome-partner.html'), buildWelcomeEmail('Anil Machireddy', 'PARTNER', { inline: true }).html);
console.log(`Wrote ${n} previews + 2 welcome previews to ${OUT}`);
