// Held and refunded totals (7 Nov 2026): a frozen token and a part-refunded token still hold the buyer's money, and a part-refunded token holds
// only what is left. Every screen that totals escrow money must agree.
jest.mock('../../src/lib/prisma', () => ({
  escrowTransaction: { findMany: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
  userSubscription: { aggregate: jest.fn() },
  lead: { count: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: {}, refundPayment: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({}));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));
jest.mock('../../src/modules/money/ledger.service', () => ({}));

const prisma = require('../../src/lib/prisma');
const totals = require('../../src/lib/escrowTotals');
const escrowSvc = require('../../src/modules/escrow/escrow.service');

// RD-L-000109 shape: 2,50,000 held, 50,000 frozen, 49,998 part-refunded with 24,998 gone back (so 25,000 left).
const ROWS = [
  { status: 'HELD', amount: 250000, refundedAmountPaise: 0 },
  { status: 'FROZEN', amount: 50000, refundedAmountPaise: 0 },
  { status: 'PARTIALLY_REFUNDED', amount: 49998, refundedAmountPaise: 2499800 },
  { status: 'REFUNDED', amount: 1000, refundedAmountPaise: 100000 },
  { status: 'RELEASED', amount: 7000, refundedAmountPaise: 0 },
  { status: 'FAILED', amount: 3000, refundedAmountPaise: 0 },
];

describe('escrowTotals', () => {
  test('held counts HELD, FROZEN and the remainder of a part-refunded token, nothing else', () => {
    expect(totals.sumHeld(ROWS)).toBe(325000);
  });
  test('refunded counts whole refunds plus the refunded part of open tokens', () => {
    expect(totals.sumRefunded(ROWS)).toBe(1000 + 24998);
  });
  test('a part-refunded token never counts below zero', () => {
    expect(totals.heldRupees({ status: 'PARTIALLY_REFUNDED', amount: 100, refundedAmountPaise: 99999 })).toBe(0);
  });
  test('missing refundedAmountPaise counts as nothing refunded', () => {
    expect(totals.heldRupees({ status: 'HELD', amount: 500 })).toBe(500);
  });
  test('held paise for the ledger', () => {
    expect(totals.heldPaise({ status: 'PARTIALLY_REFUNDED', amount: 49998, refundedAmountPaise: 2499800 })).toBe(2500000);
  });
});

describe('getEscrowStats', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.escrowTransaction.aggregate.mockImplementation(async (a) => ({ _sum: { amount: a.where.status === 'REFUNDED' && !a.where.refundedAt ? 1000 : 0 } }));
    prisma.escrowTransaction.count.mockResolvedValue(0);
    prisma.escrowTransaction.findMany.mockImplementation(async (args) => {
      const s = args?.where?.status;
      if (s && s.in) return ROWS.filter((r) => s.in.includes(r.status));
      if (s === 'REFUNDED') return ROWS.filter((r) => r.status === 'REFUNDED');
      return [];
    });
  });
  test('heldSum and heldCount include frozen and part-refunded money', async () => {
    const stats = await escrowSvc.getEscrowStats();
    expect(stats.heldSum).toBe(325000);
    expect(stats.heldCount).toBe(3);
  });
  test('refundedSum includes the part-refunded share', async () => {
    const stats = await escrowSvc.getEscrowStats();
    expect(stats.refundedSum).toBe(1000 + 24998);
  });
});
