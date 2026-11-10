jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/lib/prisma', () => ({ escrowTransaction: { findMany: jest.fn(), update: jest.fn() } }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigValue: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ refund: { holdDays: 30 } }) }));
jest.mock('../../src/modules/escrow/escrow.service', () => ({ refund: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { notifyAdmins } = require('../../src/lib/notifications');
const { getConfigValue } = require('../../src/modules/config/config.service');
const escrowService = require('../../src/modules/escrow/escrow.service');
const job = require('../../src/jobs/escrowHoldExpiry');

beforeEach(() => { jest.clearAllMocks(); getConfigValue.mockResolvedValue('false'); prisma.escrowTransaction.update.mockResolvedValue({}); });

describe('escrow hold-limit job (T59)', () => {
  test('with automatic refund off it alerts once per escrow, not every night', async () => {
    prisma.escrowTransaction.findMany.mockResolvedValue([
      { id: 'e1', status: 'HELD', amount: 50000, holdLimitAlertedAt: null },
      { id: 'e2', status: 'HELD', amount: 60000, holdLimitAlertedAt: new Date() },
    ]);
    const r = await job.runOnce();
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(prisma.escrowTransaction.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { holdLimitAlertedAt: expect.any(Date) } });
    expect(r).toMatchObject({ due: 2, alerted: 1, refunded: 0 });
    expect(escrowService.refund).not.toHaveBeenCalled();
  });
  test('with automatic refund on it refunds token only, as the system', async () => {
    getConfigValue.mockResolvedValue('true');
    prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'e1', status: 'HELD', amount: 50000 }]);
    escrowService.refund.mockResolvedValue({});
    const r = await job.runOnce();
    expect(escrowService.refund).toHaveBeenCalledWith('e1', null, null, expect.objectContaining({ reason: 'ADMIN_TOKEN_ONLY', actorType: 'SYSTEM' }));
    expect(r.refunded).toBe(1);
  });
  test('a failed refund is counted, not thrown', async () => {
    getConfigValue.mockResolvedValue('true');
    prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'e1', status: 'HELD', amount: 50000 }]);
    escrowService.refund.mockRejectedValue(new Error('boom'));
    expect((await job.runOnce()).failed).toBe(1);
  });
});

describe('frozen escrows past the hold limit (7 Nov 2026)', () => {
  test('are looked up with the held ones, and an admin is alerted once; never refunded, even with automatic refund on', async () => {
    getConfigValue.mockResolvedValue('true');
    prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'f1', status: 'FROZEN', amount: 50000, holdLimitAlertedAt: null }]);
    const r = await job.runOnce();
    expect(prisma.escrowTransaction.findMany.mock.calls[0][0].where.status).toEqual({ in: ['HELD', 'HELD_PAYOUT_FAILED', 'FROZEN', 'PARTIALLY_REFUNDED'] });
    expect(escrowService.refund).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins.mock.calls[0][0].title).toMatch(/frozen/i);
    expect(prisma.escrowTransaction.update).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { holdLimitAlertedAt: expect.any(Date) } });
    expect(r).toMatchObject({ refunded: 0, alerted: 1 });
  });
  test('a frozen escrow already alerted is left alone', async () => {
    prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'f1', status: 'FROZEN', amount: 50000, holdLimitAlertedAt: new Date() }]);
    await job.runOnce();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});

// Audit Nov 2026, F7: these two states still hold buyer money and used to be invisible to this job.
describe('part-refunded and payout-failed tokens past the hold limit', () => {
  test.each([['PARTIALLY_REFUNDED', /part-refunded/i], ['HELD_PAYOUT_FAILED', /payout-failed/i]])('%s: an admin is alerted once and it is never refunded automatically', async (status, title) => {
    getConfigValue.mockResolvedValue('true');
    prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'x1', status, amount: 50000, holdLimitAlertedAt: null }]);
    const r = await job.runOnce();
    expect(escrowService.refund).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins.mock.calls[0][0].title).toMatch(title);
    expect(prisma.escrowTransaction.update).toHaveBeenCalledWith({ where: { id: 'x1' }, data: { holdLimitAlertedAt: expect.any(Date) } });
    expect(r).toMatchObject({ refunded: 0, alerted: 1 });
  });
});
