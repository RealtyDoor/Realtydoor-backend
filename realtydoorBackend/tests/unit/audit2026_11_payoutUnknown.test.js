// Audit Nov 2026, F1 (and F3, F4): the ways out of HELD_PAYOUT_FAILED when a payout request got NO ANSWER from RazorpayX.
// The leg is marked "unconfirmed". The rule under test: nothing is paid, refunded or closed by hand until RazorpayX has
// been asked, by the reference id we sent, whether that payout exists.
jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
  lead: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({
  createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(), createPayout: jest.fn(), validateFundAccountOrWarn: jest.fn(),
  refundPayment: jest.fn(), rawGet: jest.fn(), findPayoutByReference: jest.fn(),
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onPayoutRecreated: jest.fn(), onPayoutStatus: jest.fn(), onRefund: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const rz = require('../../src/lib/razorpay');
const ledger = require('../../src/modules/money/ledger.service');
const { createNotification } = require('../../src/lib/notifications');
const svc = require('../../src/modules/escrow/escrowPayout.service');

const LONG_AGO = new Date(Date.now() - 60 * 60 * 1000);
const row = (over = {}) => ({
  id: 'e1', leadId: 'l1', buyerId: 'b1', status: 'HELD_PAYOUT_FAILED', amount: 50000, razorpayPaymentId: 'pay_1', netAmount: 49000, partnerShareAmount: 0,
  razorpayPayoutId: null, razorpayPartnerPayoutId: null, sellerPayoutStatus: 'unconfirmed', partnerPayoutStatus: null, payoutAttempt: 0,
  adminNote: null, refundedAmountPaise: 0, updatedAt: LONG_AGO, ...over,
});
const SELLER = { name: 'S', email: 's@x.in', phone: '9999999999', ifsc: 'HDFC0001234', accountNumber: '123456789' };
const retry = () => svc.retryPayout('e1', { leg: 'seller', sellerDetails: SELLER }, 'a1', 'ip');
const timeout = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

beforeEach(() => {
  jest.resetAllMocks();
  require('../../src/lib/auditLog').createAuditLog.mockResolvedValue();
  createNotification.mockResolvedValue();
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.escrowTransaction.update.mockImplementation(async ({ data }) => ({ id: 'e1', ...data }));
  rz.createPayoutContact.mockResolvedValue({ id: 'c1' });
  rz.createPayoutFundAccount.mockResolvedValue({ id: 'fa1' });
  rz.createPayout.mockResolvedValue({ id: 'pout_new', status: 'queued' });
  rz.refundPayment.mockResolvedValue({ id: 'rfnd_1' });
});

describe('retrying a leg whose earlier payout request got no answer', () => {
  test('DOUBLE PAYMENT: the earlier payout exists at RazorpayX, so it is recorded and NO second payout is created', async () => {
    prisma.escrowTransaction.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: 'RELEASED', razorpayPayoutId: 'pout_lost', sellerPayoutStatus: 'processing' }));
    rz.findPayoutByReference.mockResolvedValue({ id: 'pout_lost', status: 'processing', amount: 4900000, reference_id: 'esc_s_e1_a0' });
    await expect(retry()).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAYOUT_FOUND' } });
    expect(rz.findPayoutByReference).toHaveBeenCalledWith('esc_s_e1_a0');
    expect(rz.createPayout).not.toHaveBeenCalled();
    const adopt = prisma.escrowTransaction.updateMany.mock.calls[0][0];
    expect(adopt.where).toEqual({ id: 'e1', sellerPayoutStatus: 'unconfirmed' });
    expect(adopt.data).toMatchObject({ razorpayPayoutId: 'pout_lost', sellerPayoutStatus: 'processing', status: 'RELEASED' });
    expect(ledger.onPayoutRecreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), expect.objectContaining({ leg: 'seller', payoutId: 'pout_lost', amountPaise: 4900000 }));
  });

  test('a found payout does not put the escrow back to RELEASED while the other leg is still failed', async () => {
    prisma.escrowTransaction.findUnique
      .mockResolvedValueOnce(row({ partnerPayoutStatus: 'failed', partnerShareAmount: 1000 }))
      .mockResolvedValueOnce(row({ razorpayPayoutId: 'pout_lost', sellerPayoutStatus: 'processing', partnerPayoutStatus: 'failed' }));
    rz.findPayoutByReference.mockResolvedValue({ id: 'pout_lost', status: 'processing', reference_id: 'esc_s_e1_a0' });
    rz.rawGet.mockResolvedValue({ status: 'processing' });
    await expect(retry()).rejects.toMatchObject({ data: { code: 'PAYOUT_STILL_IN_FLIGHT' } });
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data.status).toBeUndefined();
    expect(rz.createPayout).not.toHaveBeenCalled();
  });

  test('RazorpayX has no such payout (and the request is old enough): the leg is marked failed and the retry goes ahead once', async () => {
    prisma.escrowTransaction.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ sellerPayoutStatus: 'failed' }));
    rz.findPayoutByReference.mockResolvedValue(null);
    await retry();
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'e1', sellerPayoutStatus: 'unconfirmed' }, data: { sellerPayoutStatus: 'failed' } });
    expect(rz.createPayout).toHaveBeenCalledTimes(1);
    expect(rz.createPayout.mock.calls[0][2]).toBe('esc_s_e1_a1');
    expect(ledger.onPayoutRecreated).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ leg: 'seller', payoutId: 'pout_new', attempt: 1 }));
  });

  test('RazorpayX cannot be asked: nothing is created and nothing is changed', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row());
    rz.findPayoutByReference.mockRejectedValue(timeout());
    await expect(retry()).rejects.toMatchObject({ statusCode: 502, data: { code: 'RAZORPAYX_ERROR' } });
    expect(rz.createPayout).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('"not found" less than two minutes after the lost request is not trusted: wait', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row({ updatedAt: new Date() }));
    rz.findPayoutByReference.mockResolvedValue(null);
    await expect(retry()).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAYOUT_UNCONFIRMED' } });
    expect(rz.createPayout).not.toHaveBeenCalled();
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });

  test('the other leg is looked up too (the retry moves the shared attempt number on)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row({ sellerPayoutStatus: 'failed', partnerPayoutStatus: 'unconfirmed', partnerShareAmount: 1000 }));
    rz.findPayoutByReference.mockRejectedValue(timeout());
    await expect(retry()).rejects.toMatchObject({ statusCode: 502 });
    expect(rz.findPayoutByReference).toHaveBeenCalledWith('esc_p_e1_a0');
    expect(rz.createPayout).not.toHaveBeenCalled();
  });
});

describe('the retry itself gets no answer', () => {
  const failedRow = () => row({ sellerPayoutStatus: 'failed', razorpayPayoutId: 'pout_old' });
  test('a timeout marks the leg unconfirmed (so the next action looks it up) and never RELEASED', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failedRow());
    rz.rawGet.mockResolvedValue({ status: 'failed' });
    rz.createPayout.mockRejectedValue(timeout());
    await expect(retry()).rejects.toMatchObject({ statusCode: 502, data: { code: 'PAYOUT_UNCONFIRMED' } });
    const data = prisma.escrowTransaction.update.mock.calls.at(-1)[0].data;
    expect(data.sellerPayoutStatus).toBe('unconfirmed');
    expect(data.status).toBeUndefined();
    expect(ledger.onPayoutRecreated).not.toHaveBeenCalled();
  });
  test('a clear refusal (4xx) is a plain failure: nothing was created, the leg is not marked unconfirmed', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(failedRow());
    rz.rawGet.mockResolvedValue({ status: 'failed' });
    rz.createPayout.mockRejectedValue({ statusCode: 400, error: { description: 'bad account' } });
    await expect(retry()).rejects.toMatchObject({ statusCode: 502, data: { code: 'RAZORPAYX_ERROR' } });
    expect(prisma.escrowTransaction.update).not.toHaveBeenCalled();
  });
  test('F3: a successful retry does not hide the other leg\'s failure (the escrow stays payout-failed)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row({ sellerPayoutStatus: 'failed', razorpayPayoutId: 'pout_old', partnerPayoutStatus: 'failed', razorpayPartnerPayoutId: 'pout_p' }));
    rz.rawGet.mockResolvedValue({ status: 'failed' });
    await retry();
    const data = prisma.escrowTransaction.update.mock.calls.at(-1)[0].data;
    expect(data).toMatchObject({ razorpayPayoutId: 'pout_new', sellerPayoutStatus: 'queued' });
    expect(data.status).toBeUndefined();
  });
});

describe('refunding the rest, or closing by hand, while a payout may exist', () => {
  test('DOUBLE PAYMENT: no refund while RazorpayX cannot be asked about an unconfirmed payout', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row());
    rz.findPayoutByReference.mockRejectedValue(timeout());
    await expect(svc.refundRemaining('e1', 'buyer asked', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 502 });
    expect(rz.refundPayment).not.toHaveBeenCalled();
  });
  test('DOUBLE PAYMENT: the payout turned out to exist, so there is nothing to refund', async () => {
    prisma.escrowTransaction.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: 'RELEASED', razorpayPayoutId: 'pout_lost', sellerPayoutStatus: 'processed' }));
    rz.findPayoutByReference.mockResolvedValue({ id: 'pout_lost', status: 'processed', utr: 'U1', reference_id: 'esc_s_e1_a0' });
    await expect(svc.refundRemaining('e1', 'buyer asked', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAYOUT_FOUND' } });
    expect(rz.refundPayment).not.toHaveBeenCalled();
    expect(ledger.onPayoutStatus).toHaveBeenCalledWith(expect.objectContaining({ payoutId: 'pout_lost', status: 'processed', utr: 'U1' }));
  });
  test('"mark as settled" is refused too until the unconfirmed payout has been looked up', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row({ updatedAt: new Date() }));
    rz.findPayoutByReference.mockResolvedValue(null);
    await expect(svc.resolvePayout('e1', { resolution: 'PAID_OUTSIDE', note: 'paid by cheque' }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAYOUT_UNCONFIRMED' } });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });
  test('F4: a refund of the rest writes its ledger row and tells the buyer', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(row({ sellerPayoutStatus: 'failed', razorpayPayoutId: 'pout_s' }));
    rz.rawGet.mockResolvedValue({ status: 'failed' });
    await svc.refundRemaining('e1', 'seller backed out', 'a1', 'ip');
    expect(rz.refundPayment).toHaveBeenCalledWith('pay_1', 5000000);
    expect(prisma.escrowTransaction.update.mock.calls.at(-1)[0].data).toMatchObject({ razorpayRefundId: 'rfnd_1', refundReason: 'REFUND_REMAINING' });
    expect(ledger.onRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), expect.objectContaining({ refundPaise: 5000000, reason: 'REFUND_REMAINING' }), expect.objectContaining({ refundId: 'rfnd_1' }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'b1', type: 'ESCROW_REFUNDED' }));
  });
});
