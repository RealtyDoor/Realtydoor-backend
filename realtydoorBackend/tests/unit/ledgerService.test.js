// The money ledger: the rules every row must pass, one row per idempotency key, manual lines (reason, reversal once only),
// payout status rows that never edit the original, and the deal card arithmetic.
jest.mock('../../src/lib/prisma', () => ({
  moneyLedgerEntry: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
  lead: { findUnique: jest.fn() },
  escrowTransaction: { findMany: jest.fn() },
  tdsEntry: { findMany: jest.fn() },
  partnerTaxInvoice: { findMany: jest.fn() },
  commissionVoucher: { findMany: jest.fn() },
}));
const prisma = require('../../src/lib/prisma');
const ledger = require('../../src/modules/money/ledger.service');

const good = (over = {}) => ({
  type: 'TOKEN_IN', direction: 'IN', partyType: 'BUYER', grossPaise: 5000000, netPaise: 5000000, idempotencyKey: 'k1', createdByType: 'SYSTEM', ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  prisma.moneyLedgerEntry.findUnique.mockResolvedValue(null);
  prisma.moneyLedgerEntry.create.mockImplementation(async ({ data }) => ({ id: 'row1', ...data }));
});

describe('record: what every row must satisfy', () => {
  test('a good row is stored with defaults (RECORDED, zero GST/TDS/fee, a date)', async () => {
    const row = await ledger.record(good());
    expect(row).toMatchObject({ status: 'RECORDED', gstPaise: 0, tdsPaise: 0, feePaise: 0 });
    expect(row.entryDate).toBeInstanceOf(Date);
  });
  test.each([
    ['an unknown type', { type: 'FREE_MONEY' }],
    ['an unknown direction', { direction: 'SIDEWAYS' }],
    ['an unknown status', { status: 'MAYBE' }],
    ['an unknown party', { partyType: 'ALIEN' }],
    ['a fractional gross', { grossPaise: 10.5 }],
    ['a string gross', { grossPaise: '100' }],
    ['a NaN net', { netPaise: NaN }],
    ['an infinite net', { netPaise: Infinity }],
    ['a missing net', { netPaise: undefined }],
    ['a fractional GST', { gstPaise: 0.1 }],
    ['a fractional TDS', { tdsPaise: 1.5 }],
    ['a fractional fee', { feePaise: '3' }],
    ['no idempotency key', { idempotencyKey: '' }],
    ['no creator type', { createdByType: undefined }],
    ['an ADJUSTMENT with no reason', { type: 'ADJUSTMENT', reason: '   ' }],
  ])('refuses %s', async (_n, over) => {
    await expect(ledger.record(good(over))).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.moneyLedgerEntry.create).not.toHaveBeenCalled();
  });
  test('REPLAY: the same key returns the first row and writes nothing', async () => {
    prisma.moneyLedgerEntry.findUnique.mockResolvedValue({ id: 'first' });
    expect(await ledger.record(good())).toEqual({ id: 'first' });
    expect(prisma.moneyLedgerEntry.create).not.toHaveBeenCalled();
  });
  test('RACE: losing the unique-index race returns the winner', async () => {
    prisma.moneyLedgerEntry.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' });
    prisma.moneyLedgerEntry.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    expect(await ledger.record(good())).toEqual({ id: 'winner' });
  });
  test('any other write error is raised', async () => {
    prisma.moneyLedgerEntry.create.mockRejectedValue(new Error('db down'));
    await expect(ledger.record(good())).rejects.toThrow('db down');
  });
  test('recordSafe never throws into a payment flow, but returns null so the gap is visible', async () => {
    expect(await ledger.recordSafe(good({ grossPaise: 1.5 }))).toBeNull();
    prisma.moneyLedgerEntry.create.mockRejectedValue(new Error('db down'));
    expect(await ledger.recordSafe(good())).toBeNull();
  });
});

describe('addManual', () => {
  const manual = (over = {}) => ({ type: 'ADJUSTMENT', direction: 'IN', partyType: 'REALTYDOOR', grossPaise: 10000, reason: 'Bank charge correction', ...over });

  test.each(['TOKEN_IN', 'REFUND', 'SELLER_PAYOUT', 'PARTNER_COMMISSION', 'TDS_DEPOSITED', 'BROKERAGE_RECEIVED', 'NOPE'])('the system-only type %s cannot be typed in by hand', async (type) => {
    await expect(ledger.addManual(manual({ type }), 'a1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.moneyLedgerEntry.create).not.toHaveBeenCalled();
  });
  test.each([[undefined], [''], ['   ']])('a reason of %p is refused', async (reason) => {
    await expect(ledger.addManual(manual({ reason }), 'a1')).rejects.toMatchObject({ data: { code: 'REASON_REQUIRED' } });
  });
  test('net defaults to gross less TDS less fee; who made it is recorded', async () => {
    const row = await ledger.addManual(manual({ tdsPaise: 200, feePaise: 50 }), 'a1');
    expect(row).toMatchObject({ netPaise: 9750, createdByType: 'ADMIN', createdById: 'a1', status: 'RECORDED', reason: 'Bank charge correction' });
  });
  test('a retry with the same idempotency key does not double the line', async () => {
    prisma.moneyLedgerEntry.findUnique.mockResolvedValue({ id: 'first' });
    expect(await ledger.addManual(manual({ idempotencyKey: 'same' }), 'a1')).toEqual({ id: 'first' });
    expect(prisma.moneyLedgerEntry.create).not.toHaveBeenCalled();
  });
  test('two entries without a key get different keys', async () => {
    await ledger.addManual(manual(), 'a1');
    await ledger.addManual(manual(), 'a1');
    const keys = prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });
  test('reversing an entry that does not exist is a 404', async () => {
    prisma.moneyLedgerEntry.findUnique.mockResolvedValue(null);
    await expect(ledger.addManual(manual({ reversesEntryId: 'nope' }), 'a1')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('DOUBLE REVERSAL: an entry already reversed cannot be reversed again', async () => {
    prisma.moneyLedgerEntry.findUnique.mockResolvedValue({ id: 'orig', leadId: 'l1' });
    prisma.moneyLedgerEntry.findFirst.mockResolvedValue({ id: 'earlier-reversal' });
    await expect(ledger.addManual(manual({ reversesEntryId: 'orig' }), 'a1')).rejects.toMatchObject({ statusCode: 409, data: { code: 'ALREADY_REVERSED' } });
    expect(prisma.moneyLedgerEntry.create).not.toHaveBeenCalled();
  });
  test('a reversal points at the original and inherits its deal', async () => {
    prisma.moneyLedgerEntry.findUnique.mockResolvedValueOnce({ id: 'orig', leadId: 'l7', escrowId: 'e7' }).mockResolvedValue(null);
    prisma.moneyLedgerEntry.findFirst.mockResolvedValue(null);
    const row = await ledger.addManual(manual({ reversesEntryId: 'orig' }), 'a1');
    expect(row).toMatchObject({ reversesEntryId: 'orig', leadId: 'l7', escrowId: 'e7' });
  });
  test('fractional rupees are refused (paise only)', async () => {
    await expect(ledger.addManual(manual({ grossPaise: 100.5 }), 'a1')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('onPayoutStatus', () => {
  const parent = { id: 'p1', leadId: 'l1', escrowId: 'e1', type: 'SELLER_PAYOUT', partyType: 'SELLER', grossPaise: 100, tdsPaise: 0, netPaise: 100 };
  test('a payout we never booked is logged and ignored', async () => {
    prisma.moneyLedgerEntry.findFirst.mockResolvedValue(null);
    expect(await ledger.onPayoutStatus({ escrowId: 'e1', payoutId: 'x', status: 'processed' })).toBeNull();
    expect(prisma.moneyLedgerEntry.create).not.toHaveBeenCalled();
  });
  test('an unknown status writes nothing', async () => {
    prisma.moneyLedgerEntry.findFirst.mockResolvedValue(parent);
    expect(await ledger.onPayoutStatus({ escrowId: 'e1', payoutId: 'x', status: 'banana' })).toBeNull();
    expect(prisma.moneyLedgerEntry.create).not.toHaveBeenCalled();
  });
  test.each([['processed', 'PAID', 'OUT'], ['failed', 'FAILED', 'NONE'], ['rejected', 'FAILED', 'NONE'], ['reversed', 'REVERSED', 'NONE'], ['cancelled', 'FAILED', 'NONE']])('%s becomes a NEW %s row that points at the original', async (status, mapped, direction) => {
    prisma.moneyLedgerEntry.findFirst.mockResolvedValue(parent);
    const row = await ledger.onPayoutStatus({ escrowId: 'e1', payoutId: 'pout1', status, utr: 'U1' });
    expect(row).toMatchObject({ status: mapped, direction, relatedEntryId: 'p1', idempotencyKey: `payoutStatus:pout1:${mapped}`, createdByType: 'WEBHOOK' });
  });
});

describe('buildWhere and withCurrentStatus', () => {
  test('builds only from the filters given, with a date range', () => {
    expect(ledger.buildWhere({})).toEqual({});
    expect(ledger.buildWhere({ leadId: 'l', type: ['A', 'B'], from: '2026-10-01', to: '2026-10-31' })).toEqual({
      leadId: 'l', type: { in: ['A', 'B'] }, entryDate: { gte: new Date('2026-10-01'), lte: new Date('2026-10-31') },
    });
  });
  test('a newer same-type row that points at an original supplies its current status; other types do not', () => {
    const rows = [
      { id: 'a', type: 'SELLER_PAYOUT', status: 'DUE', entryDate: '2026-10-01', relatedEntryId: null },
      { id: 'b', type: 'SELLER_PAYOUT', status: 'PAID', entryDate: '2026-10-02', relatedEntryId: 'a' },
      { id: 'c', type: 'SELLER_PAYOUT', status: 'REVERSED', entryDate: '2026-10-03', relatedEntryId: 'a' },
      { id: 'd', type: 'REFUND', status: 'RECORDED', entryDate: '2026-10-04', relatedEntryId: 'a' },
    ];
    const out = Object.fromEntries(ledger.withCurrentStatus(rows).map((r) => [r.id, r.currentStatus]));
    expect(out).toMatchObject({ a: 'REVERSED', b: 'PAID', c: 'REVERSED', d: 'RECORDED' });
  });
});

describe('dealMoneyCard', () => {
  test('an unknown deal is a 404', async () => {
    prisma.lead.findUnique.mockResolvedValue(null);
    for (const k of ['escrowTransaction', 'moneyLedgerEntry', 'tdsEntry', 'partnerTaxInvoice', 'commissionVoucher']) prisma[k].findMany.mockResolvedValue([]);
    await expect(ledger.dealMoneyCard('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('adds up cash in, held, partner share and brokerage outstanding from the rows (status-update rows are not double counted)', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1' });
    prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'e1', status: 'HELD', amount: 50000, processingFeePaise: 100 }]);
    prisma.tdsEntry.findMany.mockResolvedValue([]); prisma.partnerTaxInvoice.findMany.mockResolvedValue([]); prisma.commissionVoucher.findMany.mockResolvedValue([]);
    prisma.moneyLedgerEntry.findMany.mockResolvedValue([
      { id: '1', type: 'TOKEN_IN', status: 'RECORDED', grossPaise: 5000000, netPaise: 5000000, tdsPaise: 0, entryDate: '2026-10-01' },
      { id: '2', type: 'PARTNER_COMMISSION', status: 'DUE', grossPaise: 100000, netPaise: 98000, tdsPaise: 2000, entryDate: '2026-10-02' },
      { id: '3', type: 'PARTNER_COMMISSION', status: 'PAID', grossPaise: 100000, netPaise: 98000, tdsPaise: 2000, entryDate: '2026-10-03', relatedEntryId: '2' },
      { id: '4', type: 'BROKERAGE_INVOICED', status: 'DUE', grossPaise: 0, netPaise: 300000, tdsPaise: 0, entryDate: '2026-10-04' },
      { id: '5', type: 'BROKERAGE_RECEIVED', status: 'PAID', grossPaise: 0, netPaise: 100000, tdsPaise: 0, entryDate: '2026-10-05' },
    ]);
    const card = await ledger.dealMoneyCard('l1');
    expect(card.summary.cashIn.tokenPaise).toBe(5000000);
    expect(card.summary.heldInEscrowPaise).toBe(5000000);
    expect(card.summary.partner).toMatchObject({ commissionPaise: 100000, tdsPaise: 2000, netPaise: 98000 });
    expect(card.summary.brokerage).toMatchObject({ invoicedPaise: 300000, receivedPaise: 100000, outstandingPaise: 200000 });
  });
});
