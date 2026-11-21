// Razorpay's Customer Fee Bearer, LOCKED ON since 20 Nov 2026 (owner: permanent, no rollback). Our order is the token only, we add no fee, Razorpay
// shows and collects its own charge at checkout (Test Mode proof: order Rs 50,000, payment Rs 51,180), and the amount check allows the captured
// payment to be the token plus a capped extra. The PLATFORM branches of the helpers are kept only for old records.
jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findUnique: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
  user: { findUnique: jest.fn() },
  lead: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: { payments: { fetch: jest.fn() } } }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn(), sendEscrowHeld: jest.fn().mockResolvedValue(), sendPartnerTaxInvoiceNeeded: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPaymentCaptured: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const { razorpay } = require('../../src/lib/razorpay');
const notifications = require('../../src/lib/notifications');
const email = require('../../src/lib/email');
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const { parseSettings } = jest.requireActual('../../src/modules/money/moneyConfig');
const { paymentMatchesOrder, MAX_CUSTOMER_FEE_PCT } = require('../../src/lib/escrowUtils');
const { escrowReceiptNote } = require('../../src/lib/pdfReceipt');
const svc = require('../../src/modules/escrow/escrow.service');
const { buildBranded } = require('../../src/lib/brandedEmails');

const rows = (o) => Object.entries(o).map(([key, value]) => ({ key, value: String(value) }));
const TOKEN = 5_000_000;           // ₹50,000
const WITH_OUR_FEE = 5_120_900;    // ₹51,209 (today's order amount)

describe('the setting is LOCKED to Customer Fee Bearer (owner, 20 Nov 2026: permanent, no rollback)', () => {
  test('with nothing stored: CUSTOMER, our fee off', () => {
    const f = parseSettings([]).processingFee;
    expect([f.bearer, f.enabled]).toEqual(['CUSTOMER', false]);
  });
  test('a stored PLATFORM, a stored processing_fee_enabled=true, a typo or an empty value can never put our fee back', () => {
    for (const r of [{ processing_fee_bearer: 'PLATFORM' }, { processing_fee_enabled: 'true' }, { processing_fee_bearer: 'PLATFORM', processing_fee_enabled: 'true' },
      { processing_fee_bearer: 'customer' }, { processing_fee_bearer: '' }, { processing_fee_bearer: 'YES' }]) {
      const f = parseSettings(rows(r)).processingFee;
      expect([f.bearer, f.enabled]).toEqual(['CUSTOMER', false]);
    }
  });
  test('it is still a money key (audited), so an old screen writing it is recorded', () => {
    const { isMoneyKey } = jest.requireActual('../../src/modules/money/moneyConfig');
    expect(isMoneyKey('processing_fee_bearer')).toBe(true);
  });
});

describe('the checkout quote: the order is the token, nothing of ours on top', () => {
  test.each([[false], [true]])('nri=%p: total = token, fee 0, CUSTOMER, cancel terms kept', (nri) => {
    for (const r of [[], rows({ processing_fee_bearer: 'PLATFORM', processing_fee_enabled: 'true' })]) {
      const q = svc.checkoutBreakdown(TOKEN, parseSettings(r), { nri });
      expect([q.tokenPaise, q.totalPaise, q.processingFeePaise, q.feeBearer, q.processingFeeEnabled]).toEqual([TOKEN, TOKEN, 0, 'CUSTOMER', false]);
      expect(q.cancellationChargePaise).toBe(299900);
      expect(q.refundWindowHours).toBeGreaterThan(0);
    }
  });
});

describe('the amount rule', () => {
  const ok = (paid, expected, bearer) => paymentMatchesOrder({ paidPaise: paid, expectedPaise: expected, currency: 'INR', bearer });
  test('PLATFORM (today): exactly the order amount, nothing more, nothing less', () => {
    expect(ok(WITH_OUR_FEE, WITH_OUR_FEE, 'PLATFORM')).toBe(true);
    expect(ok(WITH_OUR_FEE + 1, WITH_OUR_FEE, 'PLATFORM')).toBe(false);
    expect(ok(WITH_OUR_FEE - 1, WITH_OUR_FEE, 'PLATFORM')).toBe(false);
    expect(ok(WITH_OUR_FEE, WITH_OUR_FEE, undefined)).toBe(true);
    expect(ok(TOKEN + 118_000, TOKEN, 'PLATFORM')).toBe(false);   // a fee added by Razorpay while we still charge our own would be a double charge
  });
  test('CUSTOMER: the token itself, or the token plus Razorpay\'s charge up to the cap', () => {
    expect(ok(TOKEN, TOKEN, 'CUSTOMER')).toBe(true);
    expect(ok(TOKEN + 118_000, TOKEN, 'CUSTOMER')).toBe(true);     // 2.36%
    expect(ok(TOKEN + 177_000, TOKEN, 'CUSTOMER')).toBe(true);     // 3.54%
    expect(ok(TOKEN + Math.ceil((TOKEN * MAX_CUSTOMER_FEE_PCT) / 100), TOKEN, 'CUSTOMER')).toBe(true);
  });
  test('CUSTOMER still refuses less than the token, and refuses much more', () => {
    expect(ok(TOKEN - 1, TOKEN, 'CUSTOMER')).toBe(false);
    expect(ok(TOKEN + Math.ceil((TOKEN * MAX_CUSTOMER_FEE_PCT) / 100) + 1, TOKEN, 'CUSTOMER')).toBe(false);
    expect(ok(TOKEN * 2, TOKEN, 'CUSTOMER')).toBe(false);
  });
  test('a wrong currency, or an amount that is not a whole number of paise, is always refused', () => {
    expect(paymentMatchesOrder({ paidPaise: TOKEN, expectedPaise: TOKEN, currency: 'USD', bearer: 'CUSTOMER' })).toBe(false);
    expect(paymentMatchesOrder({ paidPaise: TOKEN + 0.5, expectedPaise: TOKEN, currency: 'INR', bearer: 'CUSTOMER' })).toBe(false);
    expect(paymentMatchesOrder({ paidPaise: '5000000', expectedPaise: TOKEN, currency: 'INR', bearer: 'CUSTOMER' })).toBe(false);
  });
});

describe('confirming a payment', () => {
  const pending = { id: 'e1', buyerId: 'b1', leadId: 'l1', razorpayOrderId: 'order_1', status: 'PAYMENT_PENDING', amount: 50000, chargedPaise: TOKEN, processingFeePaise: 0 };
  const held = { ...pending, status: 'HELD', razorpayPaymentId: 'pay_1', heldAt: new Date() };
  const pay = (amount) => ({ order_id: 'order_1', status: 'captured', amount, currency: 'INR' });
  const flush = () => new Promise((r) => setTimeout(r, 20));
  beforeEach(() => {
    jest.resetAllMocks();
    notifications.createNotification.mockResolvedValue(); notifications.notifyAdmins.mockResolvedValue();
    email.sendEscrowHeld.mockResolvedValue();
    prisma.user.findUnique.mockResolvedValue({ email: 'b@example.com' });
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.escrowTransaction.findFirst.mockResolvedValue(held);
    prisma.escrowTransaction.findUnique.mockResolvedValueOnce(pending).mockResolvedValueOnce(held);
    prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-1', assignedPartnerId: null, property: { id: 'p1', title: 'Plot', partnerId: 'o1' }, propertyInterest: null });
  });

  test('CUSTOMER: a payment of the token plus Razorpay\'s charge is accepted, and the token held is the token', async () => {
    getMoneySettings.mockResolvedValue(parseSettings(rows({ processing_fee_bearer: 'CUSTOMER' })));
    razorpay.payments.fetch.mockResolvedValue(pay(TOKEN + 118_000));
    const out = await svc.confirmPayment('order_1', 'pay_1', 'b1');
    expect(out.status).toBe('HELD');
    expect(out.amount).toBe(50000);
    await flush();
    expect(email.sendEscrowHeld.mock.calls[0][3]).toMatchObject({ feeBearer: 'CUSTOMER' });
  });
  test('Razorpay\'s charge is saved on the payment (buyer path and webhook path), so screens, emails and receipts can name it', async () => {
    getMoneySettings.mockResolvedValue(parseSettings([]));
    razorpay.payments.fetch.mockResolvedValue(pay(TOKEN + 118_000));
    await svc.confirmPayment('order_1', 'pay_1', 'b1');
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'HELD', capturedPaise: TOKEN + 118_000, gatewayChargePaise: 118_000 });
    prisma.escrowTransaction.updateMany.mockClear();
    prisma.escrowTransaction.findUnique.mockReset().mockResolvedValueOnce(pending).mockResolvedValueOnce(held);
    await svc.confirmPayment('order_1', 'pay_1', null, { amount: TOKEN + 177_000, currency: 'INR' });
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ capturedPaise: TOKEN + 177_000, gatewayChargePaise: 177_000 });
  });
  test('band, buyer path: less than the token, or more than the cap above it, is refused and nothing is written', async () => {
    getMoneySettings.mockResolvedValue(parseSettings([]));
    for (const amt of [TOKEN - 1, TOKEN + Math.ceil((TOKEN * MAX_CUSTOMER_FEE_PCT) / 100) + 1]) {
      prisma.escrowTransaction.findUnique.mockReset().mockResolvedValue(pending);
      razorpay.payments.fetch.mockResolvedValue(pay(amt));
      await expect(svc.confirmPayment('order_1', 'pay_1', 'b1')).rejects.toMatchObject({ data: { code: 'AMOUNT_MISMATCH' } });
    }
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });
  test('band, webhook path: a payment outside the band tells admins and is not confirmed', async () => {
    getMoneySettings.mockResolvedValue(parseSettings([]));
    const out = await svc.confirmPayment('order_1', 'pay_1', null, { amount: TOKEN * 2, currency: 'INR' });
    expect(out).toMatchObject({ status: 'PAYMENT_PENDING' });
    expect(notifications.notifyAdmins).toHaveBeenCalled();
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });
});

describe('the wording', () => {
  test('receipt PDF note: fee sentence only for a payment that had a fee; the Razorpay sentence only under CUSTOMER; nothing stray for a fee-free PLATFORM payment', () => {
    expect(escrowReceiptNote({ processingFeePaise: 120900 })).toContain('not returned if you cancel');
    const cust = escrowReceiptNote({ processingFeePaise: 0, feeBearer: 'CUSTOMER' });
    expect(cust).toContain('Realtydoor adds no fee to this payment');
    expect(cust).toContain('collected by Razorpay');
    expect(cust).not.toContain('not returned');
    expect(escrowReceiptNote({ processingFeePaise: 0, feeBearer: 'PLATFORM' })).not.toMatch(/fee/i);
  });
  test('the token-received email says so under CUSTOMER, and keeps today\'s sentences otherwise', () => {
    const cust = buildBranded('escrow_held', { amount: 50000, processingFeePaise: 0, receipt: { feeBearer: 'CUSTOMER', razorpayPaymentId: 'pay_X1' } }).html;
    expect(cust).toContain('Realtydoor adds no fee to this payment. Any payment-gateway charge was shown and collected by Razorpay at checkout.');
    const today = buildBranded('escrow_held', { amount: 50000, processingFeePaise: 120900, receipt: { feeBearer: 'PLATFORM', razorpayPaymentId: 'pay_X1' } }).html;
    expect(today).toContain('You also paid a payment processing fee of ₹1,209 (GST included), which is not returned if you cancel.');
    expect(today).not.toContain('Realtydoor adds no fee');
    const plain = buildBranded('escrow_held', { amount: 50000, processingFeePaise: 0, receipt: { feeBearer: 'PLATFORM', razorpayPaymentId: 'pay_X1' } }).html;
    expect(plain).not.toContain('Realtydoor adds no fee');
  });
  test('a refund of a fee-free payment never mentions a processing fee', () => {
    const html = buildBranded('escrow_refunded', { amount: 47001, chargeRupees: 2999, feeReturned: undefined }).html;
    expect(html).not.toContain('processing fee');
    expect(html).toContain('A cancellation charge of <strong>₹2,999</strong> was kept');
  });
});

describe('nothing under-states what the card was charged (Customer Fee Bearer)', () => {
  const { escrowReceiptLines } = require('../../src/lib/pdfReceipt');
  test('PDF receipt: today it ends in "Total paid"; under CUSTOMER it says "Paid to Realtydoor" and names Razorpay\'s charge', () => {
    const today = escrowReceiptLines({ amount: 50000, processingFeePaise: 118000, chargedPaise: 5118000 });
    expect(today.map((l) => l.label)).toEqual(['Token advance', 'Payment processing fee (GST included)', 'Total paid']);
    const cust = escrowReceiptLines({ amount: 50000, processingFeePaise: 0, chargedPaise: 5000000, feeBearer: 'CUSTOMER' });
    expect(cust.map((l) => l.label)).toEqual(['Token advance', 'Payment gateway charge', 'Paid to Realtydoor']);
    expect(cust[1].value).toBe('Collected by Razorpay');
    expect(cust.some((l) => l.label === 'Total paid')).toBe(false);
  });
  test('receipt email: the same labels', () => {
    const cust = buildBranded('escrow_held', { amount: 50000, processingFeePaise: 0, receipt: { feeBearer: 'CUSTOMER', chargedPaise: 5000000, razorpayPaymentId: 'pay_X1' } }).html;
    expect(cust).toContain('Paid to Realtydoor');
    expect(cust).toContain('Collected by Razorpay');
    expect(cust).not.toContain('Total paid');
    const today = buildBranded('escrow_held', { amount: 50000, processingFeePaise: 118000, receipt: { feeBearer: 'PLATFORM', chargedPaise: 5118000, razorpayPaymentId: 'pay_X1' } }).html;
    expect(today).toContain('Total paid');
    expect(today).not.toContain('Paid to Realtydoor');
  });
  test('the ledger note for a refund of a fee-free payment does not claim a fee was kept', async () => {
    const ledger = jest.requireActual('../../src/modules/money/ledger.service');
    expect(typeof ledger.onRefund).toBe('function');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/modules/money/ledger.service.js'), 'utf8');
    expect(src).toContain("!(quote.feePaise > 0) ? 'Token returned'");
  });
});

describe('service receipts (Razorpay\'s fee bearer is account-wide)', () => {
  const { serviceReceiptLines } = require('../../src/lib/pdfReceipt');
  test('today: ends in Total paid; CUSTOMER: Paid to Realtydoor and Razorpay\'s charge named', () => {
    expect(serviceReceiptLines({ amountPaise: 299900 }).map((l) => l.label).pop()).toBe('Total paid');
    const c = serviceReceiptLines({ amountPaise: 299900, feeBearer: 'CUSTOMER' });
    expect(c.map((l) => l.label)).toContain('Payment gateway charge');
    expect(c.pop()).toMatchObject({ label: 'Paid to Realtydoor', strong: true });
  });
});

describe('refund receipt PDF lines (payment audit 21 Nov 2026)', () => {
  const { refundReceiptLines } = require('../../src/lib/pdfReceipt');
  test('no fee of ours and Razorpay\'s charge known: a line for it, and the refund is the token', () => {
    const l = refundReceiptLines({ tokenPaise: TOKEN, feePaise: 0, refundedPaise: TOKEN, chargePaise: 0, gatewayChargePaise: 118000 });
    expect(l.map((x) => x.label)).toContain("Razorpay's payment-gateway charge (paid to Razorpay, not returned)");
    expect(l.at(-1)).toMatchObject({ label: 'Refunded to your original payment method', strong: true });
  });
  test('an older payment with our fee: no Razorpay line, the fee line as before', () => {
    const l = refundReceiptLines({ tokenPaise: TOKEN, feePaise: 120900, refundedPaise: TOKEN, chargePaise: 0, gatewayChargePaise: 118000 });
    expect(l.map((x) => x.label).join('|')).not.toContain('Razorpay');
    expect(l.map((x) => x.label)).toContain('Payment processing fee (not returned)');
  });
});
