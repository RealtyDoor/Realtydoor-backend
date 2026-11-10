// The nightly "this token has sat too long" reminder. Audit Nov 2026, F7: it used to look at HELD only, so a part-refunded
// token and one whose payout failed (both still hold buyer money) were never escalated.
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/lib/prisma', () => ({ escrowTransaction: { findMany: jest.fn(), update: jest.fn() }, user: { findMany: jest.fn() } }));
jest.mock('../../src/lib/notifications', () => ({ broadcastNotification: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(14) }));

const prisma = require('../../src/lib/prisma');
const { broadcastNotification } = require('../../src/lib/notifications');
const job = require('../../src/jobs/escrowAutoEscalate');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([{ id: 'adm1' }]);
  prisma.escrowTransaction.update.mockResolvedValue({});
});

test('looks at every state that still holds buyer money except FROZEN (a person is already deciding that one)', async () => {
  prisma.escrowTransaction.findMany.mockResolvedValue([]);
  await job.runOnce();
  expect(prisma.escrowTransaction.findMany.mock.calls[0][0].where.status).toEqual({ in: ['HELD', 'PARTIALLY_REFUNDED', 'HELD_PAYOUT_FAILED'] });
});

test('escalates each overdue token once, whatever holding state it is in', async () => {
  prisma.escrowTransaction.findMany.mockResolvedValue([
    { id: 'e1', status: 'PARTIALLY_REFUNDED', amount: 50000, autoEscalatedAt: null },
    { id: 'e2', status: 'HELD_PAYOUT_FAILED', amount: 50000 },
    { id: 'e3', status: 'HELD', amount: 50000, autoEscalatedAt: new Date() },
  ]);
  expect(await job.runOnce()).toEqual({ escalated: 2 });
  expect(broadcastNotification).toHaveBeenCalledTimes(2);
  expect(prisma.escrowTransaction.update.mock.calls.map((c) => c[0].where.id)).toEqual(['e1', 'e2']);
});
