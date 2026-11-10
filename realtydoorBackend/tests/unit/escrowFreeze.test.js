// Freeze and unfreeze (7 Nov 2026): a part-refunded escrow can be frozen too, unfreezing restores the state it was frozen from (never a
// part-refunded escrow as HELD, which would let the standard refund pay the whole token out a second time), the claim is atomic, and the
// buyer and the assigned partner are told (in-app only; no WhatsApp template exists for it, and the reason is not shown to them).
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn() },
  escrowTransaction: { findUnique: jest.fn(), updateMany: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: {}, refundPayment: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn(), sendEscrowHeld: jest.fn() }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({}));

const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const { createNotification } = require('../../src/lib/notifications');
const { notifyUser } = require('../../src/lib/wati');
const svc = require('../../src/modules/escrow/escrow.service');

const escrow = (extra = {}) => ({ id: 'e1', leadId: 'l1', buyerId: 'b1', status: 'HELD', refundedAmountPaise: 0, ...extra });
const REASON = 'Dispute raised by the buyer';
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.resetAllMocks();
  createNotification.mockResolvedValue();
  prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
  prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-1', assignedPartnerId: 'p1', property: { title: 'Vrunda City' } });
});

describe('freeze', () => {
  test.each(['HELD', 'PARTIALLY_REFUNDED'])('a %s escrow can be frozen, claimed on the status just read', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow({ status }));
    await svc.freeze('e1', REASON, 'a1', '1.1.1.1');
    const claim = prisma.escrowTransaction.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: 'e1', status: { in: ['HELD', 'PARTIALLY_REFUNDED'] } });
    expect(claim.data).toMatchObject({ status: 'FROZEN', frozenReason: REASON, frozenByAdminId: 'a1', unfrozenAt: null });
    expect(createAuditLog.mock.calls[0][0]).toMatchObject({ action: 'ESCROW_FROZEN', before: { status }, after: { status: 'FROZEN', reason: REASON } });
  });
  test.each(['FROZEN', 'RELEASED', 'REFUNDED', 'PAYMENT_PENDING', 'FAILED', 'CANCELLED', 'HELD_PAYOUT_FAILED'])('status %s cannot be frozen', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow({ status }));
    await expect(svc.freeze('e1', REASON, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });
  test('unknown escrow is a 404', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    await expect(svc.freeze('e1', REASON, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('losing the race to a release or refund is a 409 and sends no notice', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow());
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.freeze('e1', REASON, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_STATE_CHANGED' } });
    await flush();
    expect(createNotification).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });
  test('the buyer and the assigned partner are told, without the reason', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow());
    await svc.freeze('e1', REASON, 'a1', 'ip');
    await flush();
    const calls = createNotification.mock.calls.map((c) => c[0]);
    const buyer = calls.find((c) => c.userId === 'b1');
    const partner = calls.find((c) => c.userId === 'p1');
    expect(buyer).toMatchObject({ title: 'Your token is on hold', type: 'ESCROW_FROZEN' });
    expect(buyer.message).toBe('Your token for Vrunda City is on hold while our team reviews your deal. It stays safe in escrow, and we will update you here.');
    expect(partner).toMatchObject({ title: 'Token on hold', type: 'ESCROW_FROZEN' });
    expect(partner.message).toBe("RD-L-1: the buyer's token is on hold while our team reviews the deal.");
    expect(JSON.stringify(calls)).not.toContain(REASON);
    expect(notifyUser).not.toHaveBeenCalled();
  });
  test('a lead with no assigned partner tells only the buyer; a notice failure never fails the freeze', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow());
    prisma.lead.findUnique.mockResolvedValue({ refCode: 'RD-L-1', assignedPartnerId: null, property: { title: 'Vrunda City' } });
    createNotification.mockRejectedValue(new Error('boom'));
    await expect(svc.freeze('e1', REASON, 'a1', 'ip')).resolves.toBeDefined();
    await flush();
    expect(createNotification.mock.calls.map((c) => c[0].userId)).toEqual(['b1']);
  });
});

describe('unfreeze', () => {
  test('an escrow frozen from HELD goes back to HELD', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow({ status: 'FROZEN', refundedAmountPaise: 0 }));
    await svc.unfreeze('e1', 'a1', 'ip');
    const claim = prisma.escrowTransaction.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: 'e1', status: 'FROZEN' });
    expect(claim.data).toMatchObject({ status: 'HELD' });
    expect(createAuditLog.mock.calls[0][0]).toMatchObject({ action: 'ESCROW_UNFROZEN', before: { status: 'FROZEN' }, after: { status: 'HELD' } });
  });
  test('an escrow that was part-refunded goes back to PARTIALLY_REFUNDED, never HELD (HELD would let a full refund pay the token twice)', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow({ status: 'FROZEN', refundedAmountPaise: 2_500_200 }));
    await svc.unfreeze('e1', 'a1', 'ip');
    expect(prisma.escrowTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'PARTIALLY_REFUNDED' });
    expect(createAuditLog.mock.calls[0][0].after).toMatchObject({ status: 'PARTIALLY_REFUNDED' });
  });
  test.each(['HELD', 'PARTIALLY_REFUNDED', 'RELEASED', 'REFUNDED'])('status %s is not frozen, so unfreeze is a 400', async (status) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow({ status }));
    await expect(svc.unfreeze('e1', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });
  test('losing the race is a 409', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow({ status: 'FROZEN' }));
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.unfreeze('e1', 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409 });
  });
  test('the buyer and partner are told the hold is lifted', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(escrow({ status: 'FROZEN' }));
    await svc.unfreeze('e1', 'a1', 'ip');
    await flush();
    const calls = createNotification.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.userId === 'b1')).toMatchObject({ title: 'The hold on your token is lifted', type: 'ESCROW_UNFROZEN', message: 'The hold on your token for Vrunda City has been lifted.' });
    expect(calls.find((c) => c.userId === 'p1')).toMatchObject({ title: 'Token hold lifted', type: 'ESCROW_UNFROZEN', message: "RD-L-1: the hold on the buyer's token has been lifted." });
  });
});
