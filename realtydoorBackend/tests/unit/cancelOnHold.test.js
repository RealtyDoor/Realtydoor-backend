// 7 Nov 2026: a buyer cancelling while the token was FROZEN (or HELD_PAYOUT_FAILED, or PARTIALLY_REFUNDED) found no "held" escrow,
// so cancelLead skipped the refund and still dropped the inquiry: the money stayed locked with no inquiry attached, and the cancel
// screen had said "no payment". A token that is on hold must stop the cancel, with a clear message, and the quote must say so.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), update: jest.fn() },
  escrowTransaction: { findFirst: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/modules/escrow/escrow.service', () => ({ refund: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const escrowService = require('../../src/modules/escrow/escrow.service');
const users = require('../../src/modules/users/users.service');

const ON_HOLD = ['FROZEN', 'HELD_PAYOUT_FAILED', 'PARTIALLY_REFUNDED'];
const openLead = { id: 'l1', buyerId: 'u1', status: 'SITE_VISIT_DONE' };

// Behaves like the database: findFirst only returns an escrow whose status is in the requested list.
function escrowInStatus(status) {
  prisma.escrowTransaction.findFirst.mockImplementation(async ({ where }) => {
    const wanted = where.status?.in ?? [where.status];
    return wanted.includes(status) ? { id: 'e1', status } : null;
  });
}

beforeEach(() => { jest.resetAllMocks(); prisma.lead.findFirst.mockResolvedValue(openLead); });

describe.each(ON_HOLD)('token status %s', (status) => {
  test('cancelLead refuses with 409 ESCROW_ON_HOLD, drops nothing and refunds nothing', async () => {
    escrowInStatus(status);
    await expect(users.cancelLead('u1', 'l1', { reason: 'x', reasonLabel: 'Changed my mind' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'ESCROW_ON_HOLD' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(escrowService.refund).not.toHaveBeenCalled();
  });
  test('the cancel quote says the token is on hold and not refundable by cancelling', async () => {
    escrowInStatus(status);
    await expect(users.getCancelQuote('u1', 'l1')).resolves.toEqual({ hasEscrow: true, escrowId: 'e1', stage: 'ON_HOLD', refundable: false });
    expect(escrowService.refund).not.toHaveBeenCalled();
  });
});

describe('the ordinary cases still work', () => {
  test('a HELD token still gets the real quote and a real cancel', async () => {
    escrowInStatus('HELD');
    escrowService.refund.mockResolvedValue({ stage: 'WITHIN_WINDOW', refundable: true, refundPaise: 5000000 });
    await expect(users.getCancelQuote('u1', 'l1')).resolves.toMatchObject({ hasEscrow: true, stage: 'WITHIN_WINDOW', refundable: true });
    escrowService.refund.mockResolvedValueOnce({ refundable: true }).mockResolvedValueOnce({ refundedAmountPaise: 5000000, razorpayRefundId: 'rfnd_1' });
    await users.cancelLead('u1', 'l1', { reason: 'x', reasonLabel: 'Changed my mind' });
    expect(prisma.lead.update).toHaveBeenCalledTimes(1);
  });
  test('no payment at all: the inquiry can still be cancelled', async () => {
    prisma.escrowTransaction.findFirst.mockResolvedValue(null);
    await expect(users.getCancelQuote('u1', 'l1')).resolves.toEqual({ hasEscrow: false });
    await expect(users.cancelLead('u1', 'l1', { reason: 'x', reasonLabel: 'Changed my mind' })).resolves.toEqual({ refund: undefined });
    expect(prisma.lead.update).toHaveBeenCalledTimes(1);
  });
});
