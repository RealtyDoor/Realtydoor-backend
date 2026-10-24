// Escrow: creating the order (who may, how much, resume, races), verifying a payment (wrong order, not captured, tampered amount,
// someone else's order, already settled) and refunding (state gates, double refund, window, verified letter, gateway failure).
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  escrowTransaction: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({
  razorpay: { payments: { fetch: jest.fn() }, orders: { fetch: jest.fn(), fetchPayments: jest.fn() } },
  createEscrowOrder: jest.fn(), refundPayment: jest.fn(),
  createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(), createPayout: jest.fn(), validateFundAccountOrWarn: jest.fn(),
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn().mockResolvedValue(), sendEscrowHeld: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPaymentCaptured: jest.fn().mockResolvedValue(), onRefund: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const rz = require('../../src/lib/razorpay');
const { createAuditLog } = require('../../src/lib/auditLog');
const { getConfigNumber } = require('../../src/modules/config/config.service');
const { getMoneySettings, parseSettings } = require('../../src/modules/money/moneyConfig');
const ledger = require('../../src/modules/money/ledger.service');
const svc = require('../../src/modules/escrow/escrow.service');

const SETTINGS = jest.requireActual('../../src/modules/money/moneyConfig').parseSettings([]);
const lead = (extra = {}) => ({ id: 'l1', buyerId: 'b1', status: 'SITE_VISIT_DONE', dealPriceAtLock: null, property: { price: 10_000_000 }, ...extra });

beforeEach(() => {
  jest.resetAllMocks();
  getMoneySettings.mockResolvedValue(SETTINGS);
  getConfigNumber.mockImplementation(async (key, dflt) => dflt);
  prisma.escrowTransaction.findFirst.mockResolvedValue(null);
});

describe('getCheckoutQuote', () => {
  test.each([[0], [-5], [NaN], [Infinity], [1e12], ['abc'], [null]])('refuses %p', async (v) => {
    await expect(svc.getCheckoutQuote(v)).rejects.toMatchObject({ statusCode: 400 });
  });
  test('a normal token returns the buyer-visible breakdown, total = token + the (GST-inclusive) fee', async () => {
    const q = await svc.getCheckoutQuote(50000);
    expect(q.tokenPaise).toBe(5_000_000);
    expect(q.totalPaise).toBe(q.tokenPaise + q.processingFeePaise);
    expect(q.refundWindowHours).toBe(48);
  });
});

describe('createOrder', () => {
  test('a lead the buyer does not own is a 404 (looked up by id AND buyer)', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(svc.createOrder('l1', 'someone-else', 50000)).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'l1', buyerId: 'someone-else' });
    expect(rz.createEscrowOrder).not.toHaveBeenCalled();
  });

  test.each(['NEW', 'ASSIGNED', 'SITE_VISIT_SCHEDULED', 'CLOSED', 'DROPPED'])('a lead in status %s cannot be paid into', async (status) => {
    prisma.lead.findFirst.mockResolvedValue(lead({ status }));
    await expect(svc.createOrder('l1', 'b1', 50000)).rejects.toMatchObject({ statusCode: 400 });
    expect(rz.createEscrowOrder).not.toHaveBeenCalled();
  });

  test('AMOUNT TAMPERING: above the cap (10% of the deal price) is refused with the maximum', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    await expect(svc.createOrder('l1', 'b1', 1_000_001)).rejects.toMatchObject({ statusCode: 400, data: { code: 'ESCROW_AMOUNT_ABOVE_MAX', max: 1_000_000 } });
  });

  test('the cap uses the locked deal price when there is one', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ dealPriceAtLock: 1_000_000 }));
    await expect(svc.createOrder('l1', 'b1', 100_001)).rejects.toMatchObject({ data: { code: 'ESCROW_AMOUNT_ABOVE_MAX', max: 100_000 } });
  });

  test('exactly at the cap is allowed', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    rz.createEscrowOrder.mockResolvedValue({ id: 'order_1' });
    prisma.escrowTransaction.create.mockResolvedValue({ id: 'e1' });
    await expect(svc.createOrder('l1', 'b1', 1_000_000)).resolves.toBeTruthy();
  });

  test('below the minimum is refused', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    await expect(svc.createOrder('l1', 'b1', 49_999)).rejects.toMatchObject({ data: { code: 'ESCROW_AMOUNT_BELOW_MIN', min: 50000 } });
  });

  test('with no known price there is no cap (nothing to compare with), but the minimum still applies', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ property: { price: null } }));
    rz.createEscrowOrder.mockResolvedValue({ id: 'order_1' });
    prisma.escrowTransaction.create.mockResolvedValue({ id: 'e1' });
    await expect(svc.createOrder('l1', 'b1', 5_000_000)).resolves.toBeTruthy();
    await expect(svc.createOrder('l1', 'b1', 10)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('the order is for token + fee, and the stored charge is what the gateway is asked for (not what the client sent)', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    rz.createEscrowOrder.mockResolvedValue({ id: 'order_1' });
    prisma.escrowTransaction.create.mockResolvedValue({ id: 'e1' });
    await svc.createOrder('l1', 'b1', 50000);
    const [chargedPaise, receipt] = rz.createEscrowOrder.mock.calls[0];
    const data = prisma.escrowTransaction.create.mock.calls[0][0].data;
    expect(receipt).toBe('escrow_l1');
    expect(data).toMatchObject({ leadId: 'l1', buyerId: 'b1', amount: 50000, amountPaise: 5_000_000, status: 'PAYMENT_PENDING', chargedPaise, razorpayOrderId: 'order_1' });
    expect(chargedPaise).toBeGreaterThan(5_000_000);
  });

  test('a lead that already has a held escrow is a 409 with the existing id', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e9', status: 'HELD' });
    await expect(svc.createOrder('l1', 'b1', 50000)).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_ALREADY_ACTIVE', escrowId: 'e9' } });
    expect(rz.createEscrowOrder).not.toHaveBeenCalled();
  });

  test('an abandoned pending order is resumed, not duplicated, and it keeps its ORIGINAL amount whatever is asked now', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1', status: 'PAYMENT_PENDING', razorpayOrderId: 'order_old', amount: 60000 });
    rz.razorpay.orders.fetch.mockResolvedValue({ id: 'order_old', status: 'created' });
    const out = await svc.createOrder('l1', 'b1', 50000);
    expect(out.resumed).toBe(true);
    expect(out.breakdown.tokenPaise).toBe(6_000_000);
    expect(rz.createEscrowOrder).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.create).not.toHaveBeenCalled();
  });

  test('a pending order whose payment already went through is healed instead of reopened', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    const pending = { id: 'e1', status: 'PAYMENT_PENDING', razorpayOrderId: 'order_old', amount: 50000, buyerId: 'b1', chargedPaise: 5_100_000 };
    prisma.escrowTransaction.findFirst.mockResolvedValue(pending);
    rz.razorpay.orders.fetch.mockResolvedValue({ status: 'paid' });
    rz.razorpay.orders.fetchPayments.mockResolvedValue({ items: [{ id: 'pay_f', status: 'failed' }, { id: 'pay_ok', status: 'captured' }] });
    rz.razorpay.payments.fetch.mockResolvedValue({ order_id: 'order_old', status: 'captured', amount: 5_100_000, currency: 'INR' });
    prisma.escrowTransaction.findUnique.mockResolvedValueOnce(pending).mockResolvedValue({ ...pending, status: 'HELD', buyerId: 'b1', amount: 50000 });
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.lead.findUnique.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue(null);
    const out = await svc.createOrder('l1', 'b1', 50000);
    expect(out.alreadyPaid).toBe(true);
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ razorpayPaymentId: 'pay_ok', status: 'HELD' });
  });

  test('a gateway failure is a 502, nothing is stored', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    rz.createEscrowOrder.mockRejectedValue({ statusCode: 401, error: { description: 'Authentication failed' } });
    await expect(svc.createOrder('l1', 'b1', 50000)).rejects.toMatchObject({ statusCode: 502, data: { code: 'RAZORPAY_ERROR' } });
    expect(prisma.escrowTransaction.create).not.toHaveBeenCalled();
  });

  test('losing the one-active-escrow race gives the same clean 400', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    rz.createEscrowOrder.mockResolvedValue({ id: 'order_2' });
    prisma.escrowTransaction.create.mockRejectedValue(Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: 'escrow_active_lead_unique' } }));
    await expect(svc.createOrder('l1', 'b1', 50000)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('any other database error while storing the order is not swallowed', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    rz.createEscrowOrder.mockResolvedValue({ id: 'order_2' });
    prisma.escrowTransaction.create.mockRejectedValue(new Error('db down'));
    await expect(svc.createOrder('l1', 'b1', 50000)).rejects.toThrow('db down');
  });
});

describe('confirmPayment on the buyer verify path', () => {
  const pending = (extra = {}) => ({ id: 'e1', buyerId: 'b1', leadId: 'l1', razorpayOrderId: 'order_1', status: 'PAYMENT_PENDING', amount: 50000, chargedPaise: 5_120_900, processingFeePaise: 120_900, ...extra });
  const pay = (extra = {}) => ({ order_id: 'order_1', status: 'captured', amount: 5_120_900, currency: 'INR', ...extra });

  test('an unknown order is a 404', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    await expect(svc.confirmPayment('nope', 'pay_1', 'b1')).rejects.toMatchObject({ statusCode: 404 });
  });

  test("another buyer cannot confirm someone else's order (404, and the gateway is not even asked)", async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending());
    await expect(svc.confirmPayment('order_1', 'pay_1', 'intruder')).rejects.toMatchObject({ statusCode: 404 });
    expect(rz.razorpay.payments.fetch).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test.each(['HELD', 'RELEASED', 'REFUNDED', 'FROZEN', 'HELD_PAYOUT_FAILED'])('REPLAY: an escrow already %s is returned untouched', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending({ status }));
    const out = await svc.confirmPayment('order_1', 'pay_1', 'b1');
    expect(out.status).toBe(status);
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    expect(ledger.onPaymentCaptured).not.toHaveBeenCalled();
  });

  test('a payment that belongs to a different order is refused', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending());
    rz.razorpay.payments.fetch.mockResolvedValue(pay({ order_id: 'order_other' }));
    await expect(svc.confirmPayment('order_1', 'pay_1', 'b1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test.each(['authorized', 'created', 'failed', 'refunded'])('a payment that is %s (not captured) is a 409 PAYMENT_NOT_CAPTURED', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending());
    rz.razorpay.payments.fetch.mockResolvedValue(pay({ status }));
    await expect(svc.confirmPayment('order_1', 'pay_1', 'b1')).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAYMENT_NOT_CAPTURED' } });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test.each([[5_000_000, 'INR'], [1, 'INR'], [5_120_901, 'INR'], [5_120_900, 'USD']])('AMOUNT TAMPERING: a payment of %p %s for an order of 5120900 INR is refused', async (amount, currency) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending());
    rz.razorpay.payments.fetch.mockResolvedValue(pay({ amount, currency }));
    await expect(svc.confirmPayment('order_1', 'pay_1', 'b1')).rejects.toMatchObject({ statusCode: 400, data: { code: 'AMOUNT_MISMATCH' } });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('the gateway being down is a 502 and leaves the order pending', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending());
    rz.razorpay.payments.fetch.mockRejectedValue(new Error('timeout'));
    await expect(svc.confirmPayment('order_1', 'pay_1', 'b1')).rejects.toMatchObject({ statusCode: 502 });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('a good payment claims PAYMENT_PENDING/FAILED only, writes HELD once and books the ledger once', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending());
    rz.razorpay.payments.fetch.mockResolvedValue(pay());
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.lead.findUnique.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue(null);
    await svc.confirmPayment('order_1', 'pay_1', 'b1');
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0]).toMatchObject({
      where: { razorpayOrderId: 'order_1', status: { in: ['PAYMENT_PENDING', 'FAILED'] } },
      data: { razorpayPaymentId: 'pay_1', status: 'HELD' },
    });
    expect(ledger.onPaymentCaptured).toHaveBeenCalledTimes(1);
  });

  test('RACE: the loser of the claim books nothing', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending());
    rz.razorpay.payments.fetch.mockResolvedValue(pay());
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await svc.confirmPayment('order_1', 'pay_1', 'b1');
    expect(ledger.onPaymentCaptured).not.toHaveBeenCalled();
  });

  test('the webhook path (no buyer id) does not call the gateway but still claims atomically', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(pending());
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await svc.confirmPayment('order_1', 'pay_1');
    expect(rz.razorpay.payments.fetch).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.updateMany).toHaveBeenCalled();
  });
});

describe('refund', () => {
  const held = (extra = {}) => ({ id: 'e1', status: 'HELD', buyerId: 'b1', leadId: 'l1', amount: 50000, processingFeePaise: 120_900, razorpayPaymentId: 'pay_1', heldAt: new Date(), ...extra });
  beforeEach(() => {
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: null, allocationLetterVerifiedAt: null });
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.escrowTransaction.update.mockImplementation(async ({ data }) => ({ id: 'e1', ...data }));
    prisma.user.findUnique.mockResolvedValue(null);
    rz.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
  });

  test('an unknown escrow is a 404', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    await expect(svc.refund('x', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 404 });
  });

  test.each(['PAYMENT_PENDING', 'RELEASED', 'REFUNDED', 'FROZEN', 'PARTIALLY_REFUNDED', 'FAILED', 'HELD_PAYOUT_FAILED'])('DOUBLE REFUND/RELEASE: an escrow in %s cannot be refunded', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status }));
    await expect(svc.refund('e1', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test('no captured payment id means nothing to refund', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ razorpayPaymentId: null }));
    await expect(svc.refund('e1', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
  });

  test.each([['razorpayPayoutId'], ['razorpayPartnerPayoutId']])('an escrow with a payout on file (%s) is never plain-refunded', async (field) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ [field]: 'pout_1' }));
    await expect(svc.refund('e1', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_HAS_PAYOUTS' } });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test('an admin token-only refund returns exactly the token (fee kept), claims HELD->REFUNDED first, then pays out once', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    const out = await svc.refund('e1', 'a1', 'ip');
    expect(prisma.escrowTransaction.updateMany).toHaveBeenCalledWith({ where: { id: 'e1', status: 'HELD' }, data: expect.objectContaining({ status: 'REFUNDED' }) });
    expect(rz.refundPayment).toHaveBeenCalledTimes(1);
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_1', 5_000_000);
    expect(out.refundIds).toEqual({ push: 'rfnd_1' });
    expect(ledger.onRefund).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ESCROW_REFUNDED', targetId: 'e1' }));
  });

  test('RACE: if another refund won the claim, no money is sent', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.refund('e1', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test('a gateway failure puts the escrow back to HELD and is a 502', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    rz.refundPayment.mockRejectedValue({ statusCode: 400, error: { description: 'insufficient balance' } });
    await expect(svc.refund('e1', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 502 });
    expect(prisma.escrowTransaction.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { status: 'HELD', refundedAt: null } });
    expect(ledger.onRefund).not.toHaveBeenCalled();
  });

  test('a buyer cancel after the free window keeps the cancellation charge', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ heldAt: new Date(Date.now() - 49 * 3600 * 1000) }));
    const out = await svc.refund('e1', 'b1', 'ip', { reason: 'BUYER_CANCEL', actorType: 'BUYER' });
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_1', 5_000_000 - 299_900);
    expect(out.cancellationChargePaise).toBe(299_900);
  });

  test('a buyer cancel inside the free window returns the whole token', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ heldAt: new Date(Date.now() - 3600 * 1000) }));
    await svc.refund('e1', 'b1', 'ip', { reason: 'BUYER_CANCEL', actorType: 'BUYER' });
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_1', 5_000_000);
  });

  test('once the allocation letter is verified a buyer cancel is refused, even inside the window', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: 'u', allocationLetterVerifiedAt: new Date() });
    await expect(svc.refund('e1', 'b1', 'ip', { reason: 'BUYER_CANCEL', actorType: 'BUYER' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'NOT_REFUNDABLE_AFTER_VERIFICATION' } });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test('a dry run quotes and moves nothing', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    const q = await svc.refund('e1', 'a1', 'ip', { dryRun: true });
    expect(q.refundPaise).toBe(5_000_000);
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });
});
