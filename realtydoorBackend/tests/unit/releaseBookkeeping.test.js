jest.mock('../../src/lib/prisma', () => ({
  moneyLedgerEntry: { findUnique: jest.fn(), create: jest.fn() },
  escrowTransaction: { findUnique: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/lib/razorpay', () => ({ razorpay: {} }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn(), sendEscrowHeld: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const ledger = require('../../src/modules/money/ledger.service');
const escrow = require('../../src/modules/escrow/escrow.service');

const e = { id: 'e1', leadId: 'l1' };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.moneyLedgerEntry.findUnique.mockResolvedValue(null);
  prisma.moneyLedgerEntry.create.mockImplementation(async ({ data }) => ({ id: `row_${data.status}`, ...data }));
});

describe('seller payout ledger lines', () => {
  test('a transfer the admin confirms as made outside Razorpay is settled at once (a DUE line and a PAID line)', async () => {
    await ledger.onSellerPayout(e, { sellerAmountPaise: 5000000, payoutId: null });
    const rows = prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data);
    expect(rows.map((r) => r.status)).toEqual(['DUE', 'PAID']);
    expect(rows[1]).toMatchObject({ type: 'SELLER_PAYOUT', relatedEntryId: 'row_DUE', grossPaise: 5000000, idempotencyKey: 'sellerPayoutManual:e1' });
  });

  test('a RazorpayX payout stays DUE until its webhook says it was processed', async () => {
    await ledger.onSellerPayout(e, { sellerAmountPaise: 5000000, payoutId: 'pout_1', status: 'processing' });
    const rows = prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data);
    expect(rows.map((r) => r.status)).toEqual(['DUE']);
  });
});

describe('repairReleaseBookkeeping', () => {
  test('refuses an escrow that was not released', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1', status: 'HELD' });
    await expect(escrow.repairReleaseBookkeeping('e1', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('says plainly when the escrow does not exist', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(null);
    await expect(escrow.repairReleaseBookkeeping('e1', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 404 });
  });
});
