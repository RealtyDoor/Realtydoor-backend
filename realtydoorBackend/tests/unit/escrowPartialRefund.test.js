// Admin "other amount" refund: any amount up to what is still refundable, repeatable until the token is fully refunded,
// reason required, never past the cap, money state reverted when Razorpay fails, no double refund from two admins at once.
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
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const ledger = require('../../src/modules/money/ledger.service');
const svc = require('../../src/modules/escrow/escrow.service');

const SETTINGS = jest.requireActual('../../src/modules/money/moneyConfig').parseSettings([]);
const held = (extra = {}) => ({
  id: 'e1', leadId: 'l1', buyerId: 'b1', status: 'HELD', amount: 50000, processingFeePaise: 120900,
  razorpayPaymentId: 'pay_1', razorpayPayoutId: null, razorpayPartnerPayoutId: null, refundedAmountPaise: 0, refundIds: [], heldAt: new Date(), ...extra,
});
const REASON = 'Buyer agreed a partial goodwill refund';

beforeEach(() => {
  jest.resetAllMocks();
  getMoneySettings.mockResolvedValue(SETTINGS);
  prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-1', assignedPartnerId: null, allocationLetterVerifiedAt: null, property: { title: 'Flat' } });
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.escrowTransaction.update.mockResolvedValue({ id: 'e1' });
  prisma.user.findUnique.mockResolvedValue(null);
  rz.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
});

describe('refundPartial: refusing bad requests before any money moves', () => {
  test.each([[0], [-100], [1.5], [NaN], [Infinity], ['5000'], [null], [undefined]])('amount %p is a 400', async (amountPaise) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await expect(svc.refundPartial('e1', 'a1', '1.1.1.1', { amountPaise, reason: REASON })).rejects.toMatchObject({ statusCode: 400 });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test.each([[''], ['abc'], ['   '], [undefined], ['x'.repeat(501)]])('reason %p is a 400', async (reason) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await expect(svc.refundPartial('e1', 'a1', '1.1.1.1', { amountPaise: 100_00, reason })).rejects.toMatchObject({ statusCode: 400 });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test('unknown escrow is a 404', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON })).rejects.toMatchObject({ statusCode: 404 });
  });

  test.each(['FROZEN', 'RELEASED', 'REFUNDED', 'PAYMENT_PENDING', 'FAILED', 'CANCELLED', 'HELD_PAYOUT_FAILED'])('status %s cannot be refunded here', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status }));
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON })).rejects.toMatchObject({ statusCode: 400 });
    expect(rz.refundPayment).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('a payment that was never captured is refused', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ razorpayPaymentId: null }));
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a payout already on file is a 409 (would pay twice)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ razorpayPayoutId: 'pout_1' }));
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON })).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_HAS_PAYOUTS' } });
  });

  test('more than the token is a 400 naming what is left', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 5_000_001, reason: REASON })).rejects.toMatchObject({ statusCode: 400, data: { code: 'AMOUNT_TOO_HIGH' } });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test('more than what is still left after an earlier partial refund is a 400', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 2_500_100, refundIds: ['rfnd_0'] }));
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 2_499_901, reason: REASON })).rejects.toMatchObject({ statusCode: 400, data: { code: 'AMOUNT_TOO_HIGH' } });
  });

  test('nothing left to refund is a 400', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 5_000_000 }));
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100, reason: REASON })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a verified allocation letter blocks it (dispute route), as for the standard refund', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterVerifiedAt: new Date() });
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON })).rejects.toMatchObject({ statusCode: 409, data: { code: 'NOT_REFUNDABLE_AFTER_VERIFICATION' } });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });
});

describe('refundPartial: the happy paths', () => {
  test('part of the token: Razorpay gets exactly that amount, escrow becomes PARTIALLY_REFUNDED with the running total, audited with amount and reason', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await svc.refundPartial('e1', 'a1', '9.9.9.9', { amountPaise: 2_500_100, reason: REASON });

    expect(rz.refundPayment).toHaveBeenCalledWith('pay_1', 2_500_100);
    const claim = prisma.escrowTransaction.updateMany.mock.calls[0][0];
    expect(claim.data).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 2_500_100 });
    expect(claim.where.id).toBe('e1');
    expect(ledger.onRefund).toHaveBeenCalledTimes(1);
    expect(ledger.onRefund.mock.calls[0][1]).toMatchObject({ refundPaise: 2_500_100, feeReturned: false, cancellationChargePaise: 0 });
    const audit = createAuditLog.mock.calls[0][0];
    expect(audit).toMatchObject({ action: 'ESCROW_REFUNDED', targetId: 'e1', reason: REASON, ipAddress: '9.9.9.9' });
    expect(audit.after).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundPaise: 2_500_100, totalRefundedPaise: 2_500_100 });
  });

  test('a second refund of the exact remainder completes it: status REFUNDED with a closing date', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 2_500_100, refundIds: ['rfnd_0'] }));
    await svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 2_499_900, reason: REASON });
    const claim = prisma.escrowTransaction.updateMany.mock.calls[0][0];
    expect(claim.data.status).toBe('REFUNDED');
    expect(claim.data.refundedAmountPaise).toBe(5_000_000);
    expect(claim.data.refundedAt).toBeInstanceOf(Date);
    expect(claim.where).toMatchObject({ id: 'e1', status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 2_500_100 });
  });

  test('the Razorpay refund id is stored once on the escrow so the refund.created webhook recognises it', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    await svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON });
    const marks = prisma.escrowTransaction.updateMany.mock.calls.map((c) => c[0]);
    const idMark = marks.find((m) => m.data.refundIds);
    expect(idMark.data).toMatchObject({ razorpayRefundId: 'rfnd_1', refundIds: { push: 'rfnd_1' }, refundReason: 'ADMIN_PARTIAL' });
  });
});

describe('refundPartial: failures and races leave the money state exactly as it was', () => {
  test('Razorpay failing puts the escrow back to what it was and returns a 502', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 1_000_000, refundIds: ['rfnd_0'] }));
    rz.refundPayment.mockRejectedValue({ statusCode: 400, error: { description: 'invalid request sent' } });
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 500_000, reason: REASON })).rejects.toMatchObject({ statusCode: 502, data: { code: 'RAZORPAY_BALANCE_LOW' } });
    const revert = prisma.escrowTransaction.updateMany.mock.calls[1][0];
    expect(revert.where).toMatchObject({ id: 'e1', refundedAmountPaise: 1_500_000 });
    expect(revert.data).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmountPaise: 1_000_000 });
    expect(ledger.onRefund).not.toHaveBeenCalled();
    // The only audit row is the failure itself: nothing says a refund happened.
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 'a1', actorRole: 'ADMIN', action: 'ESCROW_REFUND_FAILED', targetId: 'e1',
      after: expect.objectContaining({ route: 'refund-partial', amountPaise: 500_000, paymentId: 'pay_1', code: 'RAZORPAY_BALANCE_LOW', providerMessage: 'invalid request sent' }),
    }));
  });

  test.each([
    ['a vague "invalid request sent"', { statusCode: 400, error: { description: 'invalid request sent' } }],
    ['an explicit balance message', { statusCode: 400, error: { description: 'Your account does not have enough balance to carry out the refund operation.' } }],
  ])('%s becomes a clear low-balance message the admin can act on', async (_n, rzErr) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    rz.refundPayment.mockRejectedValue(rzErr);
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 500_000, reason: REASON })).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/not enough balance.*top up.*try again/i),
      data: { code: 'RAZORPAY_BALANCE_LOW' },
    });
  });

  test('another Razorpay failure keeps its own text and code', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    rz.refundPayment.mockRejectedValue({ statusCode: 500, error: { description: 'Gateway down' } });
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 500_000, reason: REASON })).rejects.toMatchObject({
      message: expect.stringContaining('Gateway down'), data: { code: 'RAZORPAY_ERROR' },
    });
  });

  test('losing the race to another admin (claim matches nothing) never calls Razorpay', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    prisma.escrowTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON })).rejects.toMatchObject({ statusCode: 409 });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });

  test('five admins pressing at once: only the claim winner reaches Razorpay', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    prisma.escrowTransaction.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    const runs = await Promise.allSettled(Array.from({ length: 5 }, () => svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON })));
    expect(rz.refundPayment).toHaveBeenCalledTimes(1);
    expect(runs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  test('the webhook got there first (refund id already counted): the total is set straight, not double counted', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    prisma.escrowTransaction.updateMany
      .mockResolvedValueOnce({ count: 1 })   // claim
      .mockResolvedValueOnce({ count: 0 });  // id mark: refundIds already has it
    await svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 2_500_100, reason: REASON });
    const fix = prisma.escrowTransaction.update.mock.calls[0][0];
    expect(fix.data).toMatchObject({ refundedAmountPaise: 2_500_100, status: 'PARTIALLY_REFUNDED' });
  });

  test('a notification failure after the money moved never turns into a failed refund', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(held());
    require('../../src/lib/notifications').createNotification.mockRejectedValue(new Error('boom'));
    await expect(svc.refundPartial('e1', 'a1', 'ip', { amountPaise: 100_00, reason: REASON })).resolves.toBeDefined();
  });
});

describe('refundPartialSchema (the request body)', () => {
  const { refundPartialSchema } = require('../../src/modules/escrow/escrow.validator');
  test('accepts whole paise and a reason', () => {
    expect(refundPartialSchema.parse({ amountPaise: 2_500_100, reason: REASON })).toEqual({ amountPaise: 2_500_100, reason: REASON });
  });
  test.each([[{}], [{ amountPaise: 0, reason: REASON }], [{ amountPaise: -1, reason: REASON }], [{ amountPaise: 1.5, reason: REASON }],
    [{ amountPaise: '100', reason: REASON }], [{ amountPaise: 1e12, reason: REASON }], [{ amountPaise: 100 }], [{ amountPaise: 100, reason: 5 }],
    [{ amountPaise: 100, reason: 'x'.repeat(1001) }]])('refuses %j', (body) => {
    expect(() => refundPartialSchema.parse(body)).toThrow();
  });
});
