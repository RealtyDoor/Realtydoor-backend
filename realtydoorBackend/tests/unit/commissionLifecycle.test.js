// Commission terms and the seller-fee states PENDING -> INVOICED -> COLLECTED (DISPUTED as a side exit):
// each state change is allowed only from the right state, TDS cannot exceed the invoice, a frozen deal rate cannot be edited.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), update: jest.fn() },
  leadCommissionLine: { findMany: jest.fn() },
  user: { findUnique: jest.fn() },
  platformConfig: { findMany: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/fileUpload', () => ({ s3Upload: jest.fn().mockResolvedValue({ url: 'https://bucket/receipts/r.pdf' }) }));
jest.mock('../../src/lib/pdfReceipt', () => ({ buildCommissionReceiptPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-')) }));
jest.mock('../../src/modules/money/ledger.service', () => ({ onBrokerageInvoiced: jest.fn().mockResolvedValue(), onBrokerageReceived: jest.fn().mockResolvedValue(), recordSafe: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn(async (k, d) => d), getConfigValue: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const ledger = require('../../src/modules/money/ledger.service');
const svc = require('../../src/modules/commission/commission.service');

// A lead row as getLeadTerms selects it. 1 crore deal, 2% fee = 2,00,000; one closing agent at 50% of the fee.
const row = (over = {}) => ({
  id: 'l1', feePct: 2, dealPriceAtLock: 10_000_000, commissionLockedAt: new Date(), commissionVersion: 1, rateCardId: null, rateCardVersion: null,
  platformCommissionPct: 0, commissionAmountPaise: 0, commissionStatus: 'PENDING', invoiceUrl: null, invoicedAt: null, collectedAt: null, ...over,
});
const line = { payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50 };

beforeEach(() => {
  jest.resetAllMocks();
  require('../../src/lib/fileUpload').s3Upload.mockResolvedValue({ url: 'https://bucket/receipts/r.pdf' });
  require('../../src/lib/pdfReceipt').buildCommissionReceiptPdf.mockResolvedValue(Buffer.from('%PDF-'));
  require('../../src/lib/auditLog').createAuditLog.mockResolvedValue();
  require('../../src/lib/notifications').createNotification.mockResolvedValue();
  ledger.onBrokerageInvoiced.mockResolvedValue(); ledger.onBrokerageReceived.mockResolvedValue(); ledger.recordSafe.mockResolvedValue();
  require('../../src/modules/config/config.service').getConfigNumber.mockImplementation(async (k, d) => d);
  prisma.platformConfig.findMany.mockResolvedValue([]);
  prisma.leadCommissionLine.findMany.mockResolvedValue([line]);
  prisma.lead.update.mockImplementation(async ({ data }) => ({ ...row(), ...data }));
  prisma.user.findUnique.mockResolvedValue({ name: 'Owner' });
});
const leadIs = (over, extra = {}) => prisma.lead.findUnique.mockImplementation(async ({ select }) => {
  if (select && select.property && !select.feePct) return { refCode: 'RD-L-1', adminNotes: null, property: { title: 'Plot', partnerId: 'owner1' }, ...extra };
  return row(over);
});

describe('getLeadTerms', () => {
  test('an unknown lead is a 404', async () => {
    prisma.lead.findUnique.mockResolvedValue(null);
    await expect(svc.getLeadTerms('x')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('works out fee, partner total and headroom from price, fee % and the lines', async () => {
    prisma.lead.findUnique.mockResolvedValue(row());
    const t = await svc.getLeadTerms('l1');
    expect(t.amounts).toMatchObject({ feeAmount: 200000, partnerTotal: 100000, headroom: 100000, sellerNet: 9_800_000 });
    expect(t.locked).toBe(true);
  });
  test('no price or no fee % means no amounts rather than made-up zeros', async () => {
    prisma.lead.findUnique.mockResolvedValue(row({ dealPriceAtLock: null }));
    expect((await svc.getLeadTerms('l1')).amounts).toBeNull();
  });
  test('an agreed flat advisor amount is shown exactly, not recomputed', async () => {
    prisma.lead.findUnique.mockResolvedValue(row());
    prisma.leadCommissionLine.findMany.mockResolvedValue([{ payeeRole: 'ADVISOR', payeeUserId: 'a1', pct: 3.3333, flatAmountPaise: 666700 }]);
    expect((await svc.getLeadTerms('l1')).amounts.byPayee[0].amount).toBe(6667);
  });
});

describe('lockLeadTerms', () => {
  test('already locked terms cannot be locked again', async () => {
    prisma.lead.findUnique.mockResolvedValue(row());
    await expect(svc.lockLeadTerms('l1', 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'COMMISSION_LOCKED' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('terms with no lines cannot be locked', async () => {
    prisma.lead.findUnique.mockResolvedValue(row({ commissionLockedAt: null }));
    prisma.leadCommissionLine.findMany.mockResolvedValue([]);
    await expect(svc.lockLeadTerms('l1', 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'NO_COMMISSION_LINES' } });
  });
  test('lines that are bigger than the fee cannot be locked', async () => {
    prisma.lead.findUnique.mockResolvedValue(row({ commissionLockedAt: null }));
    prisma.leadCommissionLine.findMany.mockResolvedValue([{ payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 80 }, { payeeRole: 'LISTING_AGENT', payeeUserId: 'p2', pct: 40 }]);
    await expect(svc.lockLeadTerms('l1', 'a1', 'ip')).rejects.toBeDefined();
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});

describe('setDealRate', () => {
  const lead = (over = {}) => ({ id: 'l1', refCode: 'RD-L-1', assignedPartnerId: 'p1', commissionLockedAt: null, commissionStatus: 'PENDING', partnerRatePct: 1, escrowTransactions: [], ...over });
  let setLeadTerms;
  beforeEach(() => { setLeadTerms = jest.spyOn(svc, 'setLeadTerms').mockResolvedValue({ ok: true }); });
  afterEach(() => setLeadTerms.mockRestore());

  test('an unknown lead is a 404; a deal with no partner cannot get a rate', async () => {
    prisma.lead.findUnique.mockResolvedValueOnce(null);
    await expect(svc.setDealRate('l1', { partnerRatePct: 1 }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 404 });
    prisma.lead.findUnique.mockResolvedValueOnce(lead({ assignedPartnerId: null }));
    await expect(svc.setDealRate('l1', { partnerRatePct: 1 }, 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'NO_ASSIGNED_PARTNER' } });
  });
  test.each([['a released escrow', { escrowTransactions: [{ status: 'RELEASED' }] }], ['a payout-failed escrow', { escrowTransactions: [{ status: 'HELD_PAYOUT_FAILED' }] }], ['an invoiced fee', { commissionStatus: 'INVOICED' }], ['a collected fee', { commissionStatus: 'COLLECTED' }]])('FROZEN: %s means the rate cannot change', async (_n, over) => {
    prisma.lead.findUnique.mockResolvedValue(lead(over));
    await expect(svc.setDealRate('l1', { partnerRatePct: 2, reason: 'because' }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'DEAL_RATE_FROZEN' } });
    expect(setLeadTerms).not.toHaveBeenCalled();
  });
  test.each([[0], [-1], [NaN], [undefined]])('a partner rate of %p is refused', async (partnerRatePct) => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await expect(svc.setDealRate('l1', { partnerRatePct }, 'a1', 'ip')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('a rate other than the default needs a reason of 5+ characters; the default needs none', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await expect(svc.setDealRate('l1', { partnerRatePct: 3 }, 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'RATE_REASON_REQUIRED' } });
    await expect(svc.setDealRate('l1', { partnerRatePct: 3, reason: ' abc ' }, 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'RATE_REASON_REQUIRED' } });
    await expect(svc.setDealRate('l1', { partnerRatePct: 1 }, 'a1', 'ip')).resolves.toBeTruthy();
    await expect(svc.setDealRate('l1', { partnerRatePct: 3, reason: 'big builder deal' }, 'a1', 'ip')).resolves.toBeTruthy();
  });
  test('the partner and platform percentages become one fee % and one closing line that carries the partner part', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await svc.setDealRate('l1', { partnerRatePct: 1, platformFeePct: 1 }, 'a1', 'ip');
    expect(setLeadTerms).toHaveBeenCalledWith('l1', expect.objectContaining({ feePct: 2, lines: [{ payeeRole: 'CLOSING_AGENT', pct: 50 }] }), 'a1', 'ip');
  });
});

describe('invoice -> collect -> dispute', () => {
  test('cannot invoice before the terms are locked, or twice', async () => {
    prisma.lead.findUnique.mockResolvedValue(row({ commissionLockedAt: null }));
    await expect(svc.invoiceLeadCommission('l1', 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'COMMISSION_NOT_LOCKED' } });
    prisma.lead.findUnique.mockResolvedValue(row({ commissionStatus: 'INVOICED' }));
    await expect(svc.invoiceLeadCommission('l1', 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'INVALID_COMMISSION_STATUS' } });
    expect(ledger.onBrokerageInvoiced).not.toHaveBeenCalled();
  });
  test('invoicing stores the receipt, moves to INVOICED, audits, and books the ledger once', async () => {
    leadIs({});
    await svc.invoiceLeadCommission('l1', 'a1', 'ip');
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ commissionStatus: 'INVOICED', invoiceUrl: 'https://bucket/receipts/r.pdf' });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'COMMISSION_INVOICED' }));
    expect(ledger.onBrokerageInvoiced).toHaveBeenCalledTimes(1);
    // 2,00,000 fee + 18% GST
    expect(ledger.onBrokerageInvoiced.mock.calls[0][1]).toMatchObject({ subtotalPaise: 20_000_000, gstPaise: 3_600_000, totalPaise: 23_600_000 });
  });
  test.each(['PENDING', 'COLLECTED', 'DISPUTED'])('cannot collect from %s', async (commissionStatus) => {
    prisma.lead.findUnique.mockResolvedValue(row({ commissionStatus }));
    await expect(svc.collectLeadCommission('l1', 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'INVALID_COMMISSION_STATUS' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test.each([[-1], [23_600_001], [1e12]])('TDS of %p rupees on a 2,36,000 invoice is refused before anything is marked collected', async (tds) => {
    leadIs({ commissionStatus: 'INVOICED' });
    await expect(svc.collectLeadCommission('l1', 'a1', 'ip', { tdsDeductedRupees: tds })).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(ledger.onBrokerageReceived).not.toHaveBeenCalled();
  });
  test('collecting with TDS books the receipt and the TDS receivable', async () => {
    leadIs({ commissionStatus: 'INVOICED' });
    await svc.collectLeadCommission('l1', 'a1', 'ip', { tdsDeductedRupees: 4000 });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ commissionStatus: 'COLLECTED' });
    expect(ledger.onBrokerageReceived.mock.calls[0][2]).toEqual({ adminId: 'a1', tdsDeductedPaise: 400000 });
    expect(ledger.recordSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'TDS_RECEIVABLE', grossPaise: 400000 }));
  });
  test('collecting with no TDS books no TDS receivable', async () => {
    leadIs({ commissionStatus: 'INVOICED' });
    await svc.collectLeadCommission('l1', 'a1', 'ip');
    expect(ledger.recordSafe).not.toHaveBeenCalled();
  });
  test.each(['COLLECTED', 'DISPUTED'])('a %s fee cannot be disputed (a settled payment is not silently reopened)', async (commissionStatus) => {
    prisma.lead.findUnique.mockResolvedValue(row({ commissionStatus }));
    await expect(svc.disputeLeadCommission('l1', 'why', 'a1', 'ip')).rejects.toMatchObject({ data: { code: 'INVALID_COMMISSION_STATUS' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test.each(['PENDING', 'INVOICED'])('a %s fee can be disputed; the reason is appended to the notes, not replacing them', async (commissionStatus) => {
    prisma.lead.findUnique.mockImplementation(async ({ select }) => (select?.adminNotes ? { adminNotes: 'earlier note' } : row({ commissionStatus })));
    await svc.disputeLeadCommission('l1', 'seller disagrees', 'a1', 'ip');
    expect(prisma.lead.update.mock.calls[0][0].data).toEqual({ commissionStatus: 'DISPUTED', adminNotes: 'earlier note | [Commission disputed] seller disagrees' });
  });
});
