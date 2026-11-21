// The 19 emails about a buyer's or partner's own activity, re-skinned in the branded layout (Nov 2026). A pure re-skin: same subjects, same money
// wording, same preferences. These tests pin that, and that nothing a person typed can inject markup.
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'm1', accepted: ['a@b.c'] });
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: (...a) => mockSendMail(...a) }) }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const email = require('../../src/lib/email');
const { BUILDERS, buildBranded } = require('../../src/lib/brandedEmails');

const last = () => mockSendMail.mock.calls[mockSendMail.mock.calls.length - 1][0];
beforeEach(() => { jest.clearAllMocks(); process.env.FRONTEND_URL = 'https://www.realtydoor.com'; });

const EVIL = '<script>alert(1)</script> "q" & <img src=x onerror=1>';
// Every email once, with a value that would be dangerous if it were not escaped.
const CALLS = {
  lead_assigned: () => email.sendLeadAssigned('a@b.c', { buyerName: EVIL, propertyTitle: EVIL }, { notifEmail: true }),
  property_approved: () => email.sendPropertyApproved('a@b.c', EVIL, {}),
  property_rejected: () => email.sendPropertyRejected('a@b.c', EVIL, EVIL, {}),
  kyc_verified: () => email.sendKycVerified('a@b.c', {}),
  service_activated: () => email.sendServiceActivated('a@b.c', EVIL, {}),
  kyc_rejected: () => email.sendKycRejected('a@b.c', EVIL, {}),
  escrow_held: () => email.sendEscrowHeld('a@b.c', 50000, 120900),
  escrow_refunded: () => email.sendEscrowRefunded('a@b.c', 47001, { chargeRupees: 2999, feeReturned: false, propertyTitle: EVIL }),
  escrow_payment_failed: () => email.sendEscrowPaymentFailed('a@b.c'),
  loan_status_update: () => email.sendLoanStatusUpdate('a@b.c', 'IN_REVIEW', EVIL, 'LN1', {}),
  lead_inquiry_confirmed: () => email.sendLeadInquiryConfirmed('a@b.c', EVIL, {}),
  visit_scheduled: () => email.sendVisitScheduled('a@b.c', { propertyTitle: EVIL, whenText: EVIL, partnerName: EVIL, leadId: 'L1' }, {}),
  dispute_update: () => email.sendDisputeUpdate('a@b.c', { status: EVIL, note: EVIL }, {}),
  ticket_update: () => email.sendTicketUpdate('a@b.c', { subject: EVIL, update: EVIL, ticketId: 'T1' }, {}),
  video_tour_update: () => email.sendVideoTourUpdate('a@b.c', { propertyTitle: EVIL, whenText: EVIL, completed: false }, {}),
  partner_payout_processed: () => email.sendPartnerPayoutProcessed('a@b.c', { amountRupees: 52500, utr: EVIL, leadRef: EVIL }, {}),
  partner_tax_invoice_needed: () => email.sendPartnerTaxInvoiceNeeded('a@b.c', { leadRef: EVIL }, {}),
  tax_invoice_reviewed: () => email.sendTaxInvoiceReviewed('a@b.c', { accepted: false, invoiceNumber: EVIL, reason: EVIL }, {}),
  partner_payout_failed: () => email.sendPartnerPayoutFailed('a@b.c', { leadRef: EVIL }, {}),
};

describe('all 19 are branded and safe', () => {
  test('there is one builder for every email, and a call for each', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual(Object.keys(CALLS).sort());
    expect(Object.keys(BUILDERS)).toHaveLength(19);
  });
  test.each(Object.keys(CALLS))('%s: branded layout, inline logo, footer, and nothing typed by a person is left as markup', async (key) => {
    await CALLS[key]();
    const { html, attachments } = last();
    expect(html).toContain('cid:realtydoor-logo');
    expect(html).toContain('Follow us on');
    expect(html).toContain('Realtydoor tech private limited');
    expect(html).toContain('You are receiving this because');
    expect(attachments).toHaveLength(6);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror=1>');
  });
  test('the HTML starts as a full document with a title and a hidden preview line', () => {
    const { html } = buildBranded('escrow_payment_failed');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toContain('display:none;max-height:0');
  });
});

describe('subjects are unchanged', () => {
  const subjects = {
    lead_assigned: ['New Lead Assigned — P', () => email.sendLeadAssigned('a@b.c', { buyerName: 'B', propertyTitle: 'P' }, {})],
    property_approved: ['Your listing "P" is live!', () => email.sendPropertyApproved('a@b.c', 'P', {})],
    property_rejected: ['Action required: "P" needs changes', () => email.sendPropertyRejected('a@b.c', 'P', 'n', {})],
    kyc_verified: ['Account Verified — Welcome to RealtyDoor!', () => email.sendKycVerified('a@b.c', {})],
    service_activated: ['Service Activated — S', () => email.sendServiceActivated('a@b.c', 'S', {})],
    kyc_rejected: ['KYC Verification — Action Required', () => email.sendKycRejected('a@b.c', 'n', {})],
    escrow_held: ['Token Advance Received', () => email.sendEscrowHeld('a@b.c', 1000)],
    escrow_refunded: ['Token Advance Refunded', () => email.sendEscrowRefunded('a@b.c', 1000)],
    escrow_payment_failed: ['Token Advance Payment Failed', () => email.sendEscrowPaymentFailed('a@b.c')],
    loan_status_update: ['Loan Application Update — IN REVIEW', () => email.sendLoanStatusUpdate('a@b.c', 'IN_REVIEW', null, null, {})],
    lead_inquiry_confirmed: ['Your Inquiry for "P" is Being Processed', () => email.sendLeadInquiryConfirmed('a@b.c', 'P', {})],
    visit_scheduled: ['Site visit scheduled — P', () => email.sendVisitScheduled('a@b.c', { propertyTitle: 'P', whenText: 'w', leadId: 'L' }, {})],
    dispute_update: ['Your report is resolved', () => email.sendDisputeUpdate('a@b.c', { status: 'resolved' }, {})],
    ticket_update: ['Update on your ticket — Tap', () => email.sendTicketUpdate('a@b.c', { subject: 'Tap', update: 'u', ticketId: 'T' }, {})],
    video_tour_update: ['Your video tour is ready', () => email.sendVideoTourUpdate('a@b.c', { completed: true }, {})],
    partner_payout_processed: ['Your commission payout was processed', () => email.sendPartnerPayoutProcessed('a@b.c', { amountRupees: 1, leadRef: 'R' }, {})],
    partner_tax_invoice_needed: ['Upload your tax invoice to get paid', () => email.sendPartnerTaxInvoiceNeeded('a@b.c', { leadRef: 'R' }, {})],
    tax_invoice_reviewed: ['Your tax invoice was accepted', () => email.sendTaxInvoiceReviewed('a@b.c', { accepted: true, invoiceNumber: 'I' }, {})],
    partner_payout_failed: ['Your commission payout could not be completed', () => email.sendPartnerPayoutFailed('a@b.c', { leadRef: 'R' }, {})],
  };
  test.each(Object.entries(subjects))('%s', async (_k, [subject, call]) => {
    await call();
    expect(last().subject).toBe(subject);
  });
});

describe('the money wording is word for word', () => {
  test('token received, with and without the processing fee', async () => {
    await email.sendEscrowHeld('a@b.c', 50000, 120900);
    expect(last().html).toContain('Your token advance of <strong>₹50,000</strong> has been received and is held in escrow with our payment partner until your allocation letter is verified. You also paid a payment processing fee of ₹1,209 (GST included), which is not returned if you cancel.');
    await email.sendEscrowHeld('a@b.c', 50000);
    expect(last().html).toContain('until your allocation letter is verified.</div>');
    expect(last().html).not.toContain('payment processing fee of');
  });
  test('refund: the charge kept, the fee, and the 5 to 7 days', async () => {
    await email.sendEscrowRefunded('a@b.c', 47001, { chargeRupees: 2999, feeReturned: false, propertyTitle: 'Vrunda City' });
    expect(last().html).toContain('has been refunded to your original payment method. A cancellation charge of <strong>₹2,999</strong> was kept, as shown when you cancelled. The payment processing fee is not returned. It may take 5–7 business days to reflect.');
  });
  test('payment failed', async () => {
    await email.sendEscrowPaymentFailed('a@b.c');
    expect(last().html).toContain('Your token advance payment could not be processed. Please retry from your dashboard or contact support if the issue persists.');
  });
  test('payout failed shows no bank reason', async () => {
    await email.sendPartnerPayoutFailed('a@b.c', { leadRef: 'RD-L-1', reason: 'ACCOUNT 12345678901' }, {});
    expect(last().html).not.toContain('12345678901');
  });
});

describe('who can switch these off is unchanged', () => {
  const off = { notifEmail: false };
  test.each([
    ['lead assigned', () => email.sendLeadAssigned('a@b.c', { buyerName: 'B', propertyTitle: 'P' }, off)],
    ['listing approved', () => email.sendPropertyApproved('a@b.c', 'P', off)],
    ['KYC verified', () => email.sendKycVerified('a@b.c', off)],
    ['ticket update', () => email.sendTicketUpdate('a@b.c', { subject: 's', update: 'u', ticketId: 'T' }, off)],
    ['loan update', () => email.sendLoanStatusUpdate('a@b.c', 'APPROVED', null, null, off)],
    ['inquiry confirmed', () => email.sendLeadInquiryConfirmed('a@b.c', 'P', off)],
  ])('%s respects "email alerts off"', async (_n, call) => {
    expect(await call()).toBeNull();
    expect(mockSendMail).not.toHaveBeenCalled();
  });
  test.each([
    ['visit scheduled', () => email.sendVisitScheduled('a@b.c', { propertyTitle: 'P', whenText: 'w', leadId: 'L' }, off)],
    ['report update', () => email.sendDisputeUpdate('a@b.c', { status: 'resolved' }, off)],
    ['video tour', () => email.sendVideoTourUpdate('a@b.c', { completed: true }, off)],
    ['payout processed', () => email.sendPartnerPayoutProcessed('a@b.c', { amountRupees: 1, leadRef: 'R' }, off)],
    ['tax invoice needed', () => email.sendPartnerTaxInvoiceNeeded('a@b.c', { leadRef: 'R' }, off)],
    ['tax invoice reviewed', () => email.sendTaxInvoiceReviewed('a@b.c', { accepted: true, invoiceNumber: 'I' }, off)],
    ['payout failed', () => email.sendPartnerPayoutFailed('a@b.c', { leadRef: 'R' }, off)],
    ['token received', () => email.sendEscrowHeld('a@b.c', 1000)],
    ['refund', () => email.sendEscrowRefunded('a@b.c', 1000)],
    ['payment failed', () => email.sendEscrowPaymentFailed('a@b.c')],
  ])('%s is a receipt or legal notice and always goes out', async (_n, call) => {
    expect(await call()).toBeTruthy();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('buttons go to the right page', () => {
  const href = () => (last().html.match(/<a href="([^"]+)" style="display:inline-block/) || [])[1];
  test.each([
    ['lead assigned', () => email.sendLeadAssigned('a@b.c', { buyerName: 'B', propertyTitle: 'P' }, {}), 'https://www.realtydoor.com/partners/leads'],
    ['listing approved', () => email.sendPropertyApproved('a@b.c', 'P', {}), 'https://www.realtydoor.com/partners/listings'],
    ['payout', () => email.sendPartnerPayoutProcessed('a@b.c', { amountRupees: 1, leadRef: 'R' }, {}), 'https://www.realtydoor.com/partners/finance/payouts'],
    ['payout failed', () => email.sendPartnerPayoutFailed('a@b.c', { leadRef: 'R' }, {}), 'https://www.realtydoor.com/partners/finance'],
    ['visit', () => email.sendVisitScheduled('a@b.c', { propertyTitle: 'P', whenText: 'w', leadId: 'L 1/2' }, {}), 'https://www.realtydoor.com/user/inquiries/L%201%2F2'],
    ['ticket', () => email.sendTicketUpdate('a@b.c', { subject: 's', update: 'u', ticketId: 'T9' }, {}), 'https://www.realtydoor.com/user/tickets/T9'],
    ['loan', () => email.sendLoanStatusUpdate('a@b.c', 'SANCTIONED', null, 'LN7', {}), 'https://www.realtydoor.com/user/loans/sanctioned?id=LN7'],
    ['loan (other status)', () => email.sendLoanStatusUpdate('a@b.c', 'IN_REVIEW', null, 'LN7', {}), 'https://www.realtydoor.com/user/loans'],
    ['KYC verified', () => email.sendKycVerified('a@b.c', {}), 'https://partner.realtydoor.com'],
  ])('%s', async (_n, call, url) => { await call(); expect(href()).toBe(url); });
  test('the refund and a finished video tour have no button that goes nowhere', async () => {
    await email.sendEscrowRefunded('a@b.c', 1000);
    expect(href()).toBeUndefined();
    await email.sendVideoTourUpdate('a@b.c', { completed: false, whenText: 'w' }, {});
    expect(href()).toBeUndefined();
  });
});

describe('an unknown design is a clear error, not a blank email', () => {
  test('throws', () => expect(() => buildBranded('nope')).toThrow(/No email design called/));
});

describe('our branded receipts (sent in addition to Razorpay\'s own)', () => {
  const { buildEscrowReceiptPdf, buildRefundReceiptPdf, receiptNumber } = require('../../src/lib/pdfReceipt');
  const paidAt = new Date('2026-11-20T06:30:00Z');

  test('token received with a receipt: the full details, a plain note about Razorpay, and our PDF attached', async () => {
    const pdf = await buildEscrowReceiptPdf({ refCode: 'RD-L-000107', propertyTitle: 'Vrunda City', buyerName: 'Anita Rao', amount: 50000, processingFeePaise: 120900, chargedPaise: 5120900, razorpayPaymentId: 'pay_ABCD1234efgh', paidAt });
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
    await email.sendEscrowHeld('a@b.c', 50000, 120900, { pdf, refCode: 'RD-L-000107', propertyTitle: 'Vrunda City', chargedPaise: 5120900, razorpayPaymentId: 'pay_ABCD1234efgh', paidAt });
    const { html, attachments, subject } = last();
    expect(subject).toBe('Token Advance Received');
    expect(html).toContain('RCT-1234EFGH');
    expect(html).toContain('RD-L-000107');
    expect(html).toContain('Vrunda City');
    expect(html).toContain('₹51,209');           // total paid
    expect(html).toContain('pay_ABCD1234efgh');
    expect(html).toContain('20 November 2026');
    expect(html).toContain('Razorpay, our payment partner, also sends its own payment confirmation separately.');
    expect(html).toContain('a PDF copy is attached');
    const file = attachments.find((a) => a.contentType === 'application/pdf');
    expect(file.filename).toBe('Realtydoor-receipt-RCT-1234EFGH.pdf');
    expect(Buffer.isBuffer(file.content)).toBe(true);
    expect(attachments).toHaveLength(7);          // six branding images plus the receipt
  });
  test('the money sentence is unchanged by the receipt details', async () => {
    await email.sendEscrowHeld('a@b.c', 50000, 120900, { refCode: 'R', razorpayPaymentId: 'pay_X1', paidAt });
    expect(last().html).toContain('has been received and is held in escrow with our payment partner until your allocation letter is verified. You also paid a payment processing fee of ₹1,209 (GST included), which is not returned if you cancel.');
  });
  test('a receipt whose PDF could not be made still sends, and does not claim an attachment', async () => {
    await email.sendEscrowHeld('a@b.c', 50000, 120900, { refCode: 'R', razorpayPaymentId: 'pay_X1', paidAt });
    expect(last().html).not.toContain('a PDF copy is attached');
    expect(last().html).toContain('This is your Realtydoor receipt');
    expect(last().attachments).toHaveLength(6);
  });
  test('the receipt number is the same in the email and on the PDF', () => {
    expect(receiptNumber('pay_ABCD1234efgh')).toBe('RCT-1234EFGH');
    expect(receiptNumber(null)).toBe('RCT-N/A');
  });
  test('refund with a receipt: reference, date and our refund PDF attached', async () => {
    const pdf = await buildRefundReceiptPdf({ refCode: 'RD-L-000107', propertyTitle: 'Vrunda City', buyerName: 'Anita Rao', tokenPaise: 5000000, feePaise: 120900, refundedPaise: 4700100, chargePaise: 299900, razorpayRefundId: 'rfnd_999', refundedAt: paidAt });
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
    await email.sendEscrowRefunded('a@b.c', 47001, { chargeRupees: 2999, feeReturned: false, propertyTitle: 'Vrunda City', receipt: { pdf, refCode: 'RD-L-000107', refundedAt: paidAt, razorpayRefundId: 'rfnd_999' } });
    const { html, attachments } = last();
    expect(html).toContain('rfnd_999');
    expect(html).toContain('Razorpay also sends its own refund confirmation separately.');
    expect(html).toContain('a PDF copy is attached');
    expect(attachments.find((a) => a.contentType === 'application/pdf').filename).toBe('Realtydoor-refund-receipt.pdf');
    // the refund wording itself is unchanged
    expect(html).toContain('A cancellation charge of <strong>₹2,999</strong> was kept, as shown when you cancelled. The payment processing fee is not returned. It may take 5–7 business days to reflect.');
  });
  test('hostile text in the property or reference cannot inject markup into a receipt', async () => {
    await email.sendEscrowHeld('a@b.c', 1000, 0, { refCode: EVIL, propertyTitle: EVIL, razorpayPaymentId: 'pay_X1', paidAt });
    expect(last().html).not.toContain('<script>');
    expect(last().html).not.toContain('<img src=x');
  });
});

// Payment audit 21 Nov 2026 (Customer Fee Bearer; owner: refunds are the token at most, mistakes settled offline through a request).
describe('refund email: Razorpay\'s charge and raising a request', () => {
  const { buildBranded: build } = require('../../src/lib/brandedEmails');
  test('no fee of ours: names Razorpay\'s charge with its amount, a row for it, and a link to raise a request', () => {
    const { html } = build('escrow_refunded', { amount: 50000, propertyTitle: 'Plot', gatewayChargePaise: 118000 });
    expect(html).toContain("Razorpay's payment-gateway charge of <strong>₹1,180</strong> is not returned");
    expect(html).toContain('charge (kept by Razorpay)'); // the details table escapes the apostrophe
    expect(html).toContain('/user/disputes/new');
    expect(html).toContain('raise a request');
    expect(html).not.toContain('processing fee');
  });
  test('charge not known (older payment): the sentence without an amount', () => {
    const { html } = build('escrow_refunded', { amount: 50000 });
    expect(html).toContain("Razorpay's payment-gateway charge is not returned");
  });
  test('an older payment with our own fee keeps its fee sentence, and still gets the request link', () => {
    const { html } = build('escrow_refunded', { amount: 47001, feeReturned: false, chargeRupees: 2999 });
    expect(html).toContain('processing fee is not returned');
    expect(html).not.toContain("Razorpay's payment-gateway charge");
    expect(html).toContain('/user/disputes/new');
  });
  test('a part refund is worded as one', () => {
    const b = build('escrow_refunded', { amount: 10000, partial: true });
    expect(b.subject).toBe('Part of Your Token Advance Refunded');
    expect(b.html).toContain('of your token advance');
  });
});

describe('refund notices when Razorpay took nothing, and the shared note (payment audit 21 Nov 2026)', () => {
  const { buildBranded: build } = require('../../src/lib/brandedEmails');
  const { gatewayRefundNote } = require('../../src/lib/escrowUtils');
  test('email: a known zero charge gets no Razorpay sentence, but still the request link', () => {
    const { html } = build('escrow_refunded', { amount: 50000, gatewayChargePaise: 0 });
    expect(html).not.toContain("Razorpay's payment-gateway charge");
    expect(html).toContain('/user/disputes/new');
  });
  test('in-app note: amount when known, request line only for zero, plain for unknown, nothing for an older fee payment', () => {
    expect(gatewayRefundNote({ processingFeePaise: 0, gatewayChargePaise: 118000 })).toContain('of ₹1,180 is not returned');
    expect(gatewayRefundNote({ processingFeePaise: 0, gatewayChargePaise: 0 })).toBe(' If you think we made a mistake, raise a request from your account.');
    expect(gatewayRefundNote({ processingFeePaise: 0, gatewayChargePaise: null })).toContain("Razorpay's payment-gateway charge is not returned");
    expect(gatewayRefundNote({ processingFeePaise: 120900 })).toBe('');
  });
});
