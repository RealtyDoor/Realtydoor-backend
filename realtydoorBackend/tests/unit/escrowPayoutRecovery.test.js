// The way out of HELD_PAYOUT_FAILED: retry a leg, mark it settled outside, or refund the remainder. The risk here is paying twice,
// so every test checks that money is sent at most once and never while an earlier payout could still land.
jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
  lead: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({
  createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(), createPayout: jest.fn(), validateFundAccountOrWarn: jest.fn(), refundPayment: jest.fn(), rawGet: jest.fn(),
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const rz = require('../../src/lib/razorpay');
const svc = require('../../src/modules/escrow/escrowPayout.service');

const failed = (over = {}) => ({
  id: 'e1', leadId: 'l1', status: 'HELD_PAYOUT_FAILED', amount: 50000, razorpayPaymentId: 'pay_1', netAmount: 49000, partnerShareAmount: 1000,
  razorpayPayoutId: 'pout_s', razorpayPartnerPayoutId: null, sellerPayoutStatus: 'failed', adminNote: null, refundedAmountPaise: 0, ...over,
});
const SELLER = { name: 'S', email: 's@x.in', phone: '9999999999', ifsc: 'HDFC0001234', accountNumber: '123456789' };

beforeEach(() => {
  jest.resetAllMocks();
  require('../../src/lib/auditLog').createAuditLog.mockResolvedValue();
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.escrowTransaction.update.mockImplementation(async ({ data }) => ({ id: 'e1', ...data }));
  rz.rawGet.mockResolvedValue({ status: 'failed' });
  rz.createPayoutContact.mockResolvedValue({ id: 'c1' });
  rz.createPayoutFundAccount.mockResolvedValue({ id: 'fa1' });
  rz.createPayout.mockResolvedValue({ id: 'pout_new', status: 'queued' });
  rz.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
});

describe('retryPayout', () => {
  test('an unknown escrow is a 404; one that is not payout-failed is refused', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    await expect(svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 404 });
    for (const status of ['HELD', 'RELEASED', 'REFUNDED', 'FROZEN']) {
      prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ status }));
      await expect(svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'ESCROW_NOT_PAYOUT_FAILED' } });
    }
    expect(rz.createPayout).not.toHaveBeenCalled();
  });
  test.each(['queued', 'pending', 'processing'])('DOUBLE PAYMENT: a previous payout still %s at RazorpayX blocks the retry', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    rz.rawGet.mockResolvedValue({ status });
    await expect(svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAYOUT_STILL_IN_FLIGHT' } });
    expect(rz.createPayout).not.toHaveBeenCalled();
  });
  test('DOUBLE PAYMENT: a previous payout that actually processed blocks the retry', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    rz.rawGet.mockResolvedValue({ status: 'processed' });
    await expect(svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'PAYOUT_ALREADY_PROCESSED' } });
    expect(rz.createPayout).not.toHaveBeenCalled();
  });
  test('if RazorpayX cannot be asked about the old payout, nothing is retried (it might have landed)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    rz.rawGet.mockRejectedValue(new Error('timeout'));
    await expect(svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 502 });
    expect(rz.createPayout).not.toHaveBeenCalled();
  });
  test('no amount on file, or no new bank details for the seller, is refused', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ netAmount: 0 }));
    await expect(svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    await expect(svc.retryPayout('e1', { leg: 'seller' }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(rz.createPayout).not.toHaveBeenCalled();
  });
  test('RACE: the claim is keyed on the attempt number just read; the loser of a double click sends nothing', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ payoutAttempt: 1 }));
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'e1', status: 'HELD_PAYOUT_FAILED', payoutAttempt: 1 });
    expect(rz.createPayoutContact).not.toHaveBeenCalled();
    expect(rz.createPayout).not.toHaveBeenCalled();
  });
  test('a row never retried before is matched as "attempt not set", not as 0', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    await svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip');
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].where.payoutAttempt).toEqual({ isSet: false });
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toEqual({ payoutAttempt: 1 });
  });
  test('a successful seller retry pays the amount on file once, with an attempt-specific idempotency key, and goes back to RELEASED', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ payoutAttempt: 2 }));
    const out = await svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER, note: 'new account' }, 'a1', 'ip');
    expect(rz.createPayout).toHaveBeenCalledTimes(1);
    const [fa, paise, ref, key] = rz.createPayout.mock.calls[0];
    expect(fa).toBe('fa1'); expect(paise).toBe(4_900_000);
    expect(ref.length).toBeLessThanOrEqual(40);
    expect(key).toContain(':3'); // attempt 3
    expect(out).toMatchObject({ status: 'RELEASED', razorpayPayoutId: 'pout_new' });
  });
  test('the partner leg uses the partner\'s verified payout account only', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ razorpayPayoutId: null, razorpayPartnerPayoutId: 'pout_p' }));
    prisma.lead.findUnique.mockResolvedValue({ assignedPartnerId: 'p1' });
    prisma.user.findUnique.mockResolvedValue({ razorpayFundAccountId: 'fa_p', payoutAccountStatus: 'PENDING_CLARIFICATION' });
    await expect(svc.retryPayout('e1', { leg: 'partner' }, 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'PARTNER_PAYOUT_ACCOUNT_NOT_ACTIVE' } });
    expect(rz.createPayout).not.toHaveBeenCalled();
    prisma.user.findUnique.mockResolvedValue({ razorpayFundAccountId: 'fa_p', payoutAccountStatus: 'ACTIVE' });
    await svc.retryPayout('e1', { leg: 'partner' }, 'a1', 'ip');
    expect(rz.createPayout.mock.calls[0][0]).toBe('fa_p');
  });
  test('RazorpayX refusing the new payout is a 502', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    rz.createPayout.mockRejectedValue({ statusCode: 400, error: { description: 'insufficient balance' } });
    await expect(svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('resolvePayout', () => {
  test.each([[undefined], ['DONE'], ['paid_outside'], ['']])('a resolution of %p is refused', async (resolution) => {
    await expect(svc.resolvePayout('e1', { resolution, note: 'settled by bank transfer' }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });
  test.each([[undefined], [''], ['    '], ['abc'], ['x'.repeat(501)]])('a note of %j is refused (an audit reason is required)', async (note) => {
    await expect(svc.resolvePayout('e1', { resolution: 'PAID_OUTSIDE', note }, 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'NOTE_REQUIRED' } });
  });
  test('only a payout-failed escrow, and only once (the claim is on the status)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ status: 'RELEASED' }));
    await expect(svc.resolvePayout('e1', { resolution: 'PAID_OUTSIDE', note: 'settled by bank transfer' }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.resolvePayout('e1', { resolution: 'PAID_OUTSIDE', note: 'settled by bank transfer' }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('resolving records who, what and why, and sends no money', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    await svc.resolvePayout('e1', { resolution: 'PAID_OUTSIDE', note: 'settled by bank transfer' }, 'a1', 'ip');
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'RELEASED', resolvedByAdminId: 'a1', resolution: 'PAID_OUTSIDE' });
    expect(rz.createPayout).not.toHaveBeenCalled();
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });
});

describe('refundRemaining', () => {
  const live = (...statuses) => { statuses.forEach((s) => rz.rawGet.mockResolvedValueOnce({ status: s })); };

  test('only a payout-failed escrow with a captured payment', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ status: 'HELD' }));
    await expect(svc.refundRemaining('e1', 'note', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ razorpayPaymentId: null }));
    await expect(svc.refundRemaining('e1', 'note', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
  });
  test.each(['queued', 'pending', 'processing'])('DOUBLE PAYMENT: a leg still %s could land after the refund, so the refund is refused', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    live(status);
    await expect(svc.refundRemaining('e1', 'note', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAYOUT_STILL_IN_FLIGHT' } });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });
  test('a failed seller leg means the whole token is still the buyer\'s to get back', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    live('failed');
    await svc.refundRemaining('e1', 'note', 'a1', 'ip');
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_1', 5_000_000);
  });
  test('a processed seller leg is taken out of what can be refunded', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    live('processed');
    await svc.refundRemaining('e1', 'note', 'a1', 'ip');
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_1', 5_000_000 - 4_900_000);
  });
  test('an earlier partial refund is taken out too, so more than the token can never be refunded', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ refundedAmountPaise: 2_000_000 }));
    live('failed');
    await svc.refundRemaining('e1', 'note', 'a1', 'ip');
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_1', 3_000_000);
  });
  test('a partner paid from company money does not reduce the buyer\'s refund; an old-style partner leg does', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ razorpayPartnerPayoutId: 'pout_p', partnerPaidFromCompany: true }));
    live('failed');
    await svc.refundRemaining('e1', 'note', 'a1', 'ip');
    expect(rz.refundPayment).toHaveBeenLastCalledWith('pay_1', 5_000_000);
    expect(rz.rawGet).toHaveBeenCalledTimes(1); // the partner leg is not even looked at
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ razorpayPartnerPayoutId: 'pout_p' }));
    live('failed', 'processed');
    await svc.refundRemaining('e1', 'note', 'a1', 'ip');
    expect(rz.refundPayment).toHaveBeenLastCalledWith('pay_1', 5_000_000 - 100_000);
  });
  test('nothing left to refund is a 409 and sends nothing', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed({ refundedAmountPaise: 5_000_000 }));
    live('failed');
    await expect(svc.refundRemaining('e1', 'note', 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'NOTHING_TO_REFUND' } });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });
  test('RACE: the loser of a double click does not call RazorpayX', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    live('failed');
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.refundRemaining('e1', 'note', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });
  test('a gateway failure puts the escrow back to payout-failed so it can be tried again', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    live('failed');
    rz.refundPayment.mockRejectedValue({ statusCode: 400, error: {} });
    await expect(svc.refundRemaining('e1', 'note', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 502 });
    expect(prisma.escrowTransaction.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { status: 'HELD_PAYOUT_FAILED', refundedAt: null } });
  });
});

describe('getPayouts', () => {
  test('uses the live RazorpayX status, and falls back to the stored one if it cannot be fetched', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failed());
    rz.rawGet.mockResolvedValueOnce({ status: 'reversed', amount: 4_900_000, utr: 'U1' });
    expect((await svc.getPayouts('e1'))[0]).toMatchObject({ leg: 'seller', status: 'reversed', amount: 49000 });
    rz.rawGet.mockRejectedValueOnce(new Error('down'));
    expect((await svc.getPayouts('e1'))[0]).toMatchObject({ status: 'failed', amount: 49000 });
  });
});
