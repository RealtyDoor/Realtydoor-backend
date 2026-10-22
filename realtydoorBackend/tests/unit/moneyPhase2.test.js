// Money model phase 2: ledger, audit trail, tax invoice gate, voucher, TDS ledger, job. Prisma mocked.

jest.mock('../../src/lib/prisma', () => {
  const m = () => ({ findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn(), count: jest.fn() });
  return {
    lead: m(), user: m(), platformConfig: m(), escrowTransaction: m(), leadCommissionLine: m(), tdsEntry: m(),
    partnerTaxInvoice: m(), commissionVoucher: m(), moneyLedgerEntry: m(), auditLog: m(), counter: m(),
  };
});
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), notifyAdmins: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ sendVoucherOtp: jest.fn().mockResolvedValue({}), notifyUser: jest.fn(), sendPhoneVerificationOtp: jest.fn() }));
jest.mock('../../src/lib/razorpay', () => ({
  razorpay: {}, createEscrowOrder: jest.fn(), createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(),
  createPayout: jest.fn(), validateFundAccountOrWarn: jest.fn(), refundPayment: jest.fn(),
}));
jest.mock('../../src/lib/email', () => ({ sendEscrowRefunded: jest.fn(), sendEscrowHeld: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const razorpay = require('../../src/lib/razorpay');
const { createNotification } = require('../../src/lib/notifications');
const money = require('../../src/lib/moneyModel');
const audit = require('../../src/lib/auditLog');
const { extension, TDS_EDITABLE } = require('../../src/lib/immutability');
const ledger = require('../../src/modules/money/ledger.service');
const tax = require('../../src/modules/money/partnerTax.service');
const tds = require('../../src/modules/money/tds.service');
const escrow = require('../../src/modules/escrow/escrow.service');
const configService = require('../../src/modules/config/config.service');
const { parseSettings, isMoneyKey } = require('../../src/modules/money/moneyConfig');

const S = parseSettings([]);
const rs = (r) => Math.round(r * 100);
const GSTIN = '29ABCDE1234F1Z5';
const OURS = '29AAACR1234A1Z9';

beforeEach(() => {
  jest.resetAllMocks();
  createNotification.mockResolvedValue({});
  require('../../src/lib/notifications').notifyAdmins.mockResolvedValue({});
  prisma.platformConfig.findMany.mockResolvedValue([]);
  prisma.platformConfig.findUnique.mockResolvedValue(null);
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockImplementation(async ({ data }) => ({ id: 'a1', ...data }));
  prisma.moneyLedgerEntry.findUnique.mockResolvedValue(null);
  prisma.moneyLedgerEntry.create.mockImplementation(async ({ data }) => ({ id: `l${Math.random()}`, ...data }));
});

const lastAudit = () => prisma.auditLog.create.mock.calls.at(-1)[0].data;
const auditActions = () => prisma.auditLog.create.mock.calls.map((c) => c[0].data.action);

// ─── Append-only guards ──────────────────────────────────────────────────────
describe('append-only guards (lib/immutability)', () => {
  const q = extension.query;
  test.each(['update', 'updateMany', 'delete', 'deleteMany', 'upsert'])('auditLog.%s is refused', (op) => {
    expect(() => q.auditLog[op]({ args: {}, query: jest.fn() })).toThrow(/append-only/);
  });
  test.each(['update', 'updateMany', 'delete', 'deleteMany', 'upsert'])('moneyLedgerEntry.%s is refused', (op) => {
    expect(() => q.moneyLedgerEntry[op]({ args: {}, query: jest.fn() })).toThrow(/append-only/);
  });
  test('tdsEntry: only the deposit / return / certificate fields may change', () => {
    const next = jest.fn((a) => a);
    expect(q.tdsEntry.update({ args: { data: { depositedAt: new Date(), challanNumber: 'C1' } }, query: next })).toBeDefined();
    expect(next).toHaveBeenCalled();
    expect(() => q.tdsEntry.update({ args: { data: { tdsPaise: 0 } }, query: next })).toThrow(/tdsPaise/);
    expect(() => q.tdsEntry.delete({ args: {}, query: next })).toThrow(/append-only/);
    expect(TDS_EDITABLE).not.toContain('tdsPaise');
  });
  test('no source file edits or deletes audit or ledger rows', () => {
    const { execSync } = require('child_process');
    const out = execSync("grep -rnE \"(auditLog|moneyLedgerEntry)\\.(update|updateMany|delete|deleteMany|upsert)\" src scripts || true", { cwd: require('path').join(__dirname, '../..') }).toString();
    expect(out.trim()).toBe('');
  });
});

// ─── Audit trail ─────────────────────────────────────────────────────────────
describe('audit trail', () => {
  test('rows are signed and chained to the previous row', async () => {
    prisma.auditLog.findFirst.mockResolvedValue({ hash: 'prevhash' });
    const row = await audit.createAuditLog({ adminId: 'a', actorRole: 'ADMIN', action: 'X', targetType: 'T', targetId: '1', before: { a: 1 }, after: { a: 2 }, reason: 'why' });
    expect(row.prevHash).toBe('prevhash');
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.reason).toBe('why');
    expect(audit.computeHash(row)).toBe(row.hash);
  });
  test('system actors have no admin id', async () => {
    const row = await audit.createAuditLog({ actorRole: 'WEBHOOK', action: 'PAYOUT_FAILED', targetType: 'E', targetId: '1' });
    expect(row.adminId).toBeNull();
  });
  test('verifyAuditChain finds an edited row', async () => {
    const mk = (id, prevHash, extra = {}) => { const r = { id, adminId: 'a', actorRole: 'ADMIN', action: 'X', targetType: 'T', targetId: id, before: null, after: '{"v":1}', reason: null, ipAddress: null, metadata: null, prevHash, createdAt: new Date(2026, 9, 22, 10, +id) }; r.hash = audit.computeHash(r); return { ...r, ...extra }; };
    const r1 = mk('1', null); const r2 = mk('2', r1.hash); const r3 = mk('3', r2.hash, { after: '{"v":999}' }); // edited after signing
    prisma.auditLog.findMany.mockResolvedValue([r1, r2, r3]);
    const res = await audit.verifyAuditChain();
    expect(res).toMatchObject({ checked: 3, signed: 3, ok: false, tampered: ['3'] });
  });
  test('verifyAuditChain: clean chain, and old unsigned rows are counted not failed', async () => {
    const r1 = { id: '0', action: 'OLD', targetType: 'T', targetId: '0', createdAt: new Date(2026, 9, 1), hash: null };
    const a = { id: '1', adminId: 'a', actorRole: null, action: 'X', targetType: 'T', targetId: '1', before: null, after: null, reason: null, ipAddress: null, metadata: null, prevHash: null, createdAt: new Date(2026, 9, 2) };
    a.hash = audit.computeHash(a);
    prisma.auditLog.findMany.mockResolvedValue([r1, a]);
    expect(await audit.verifyAuditChain()).toMatchObject({ unsigned: 1, signed: 1, ok: true, tampered: [] });
  });
});

describe('money settings need a reason and are audited with old and new value', () => {
  test('isMoneyKey', () => {
    for (const k of ['default_partner_rate_pct', 'tds_rate_pct', 'cancellation_charge_rupees', 'processing_fee_gateway_pct', 'commission_gateway_collection_pct', 'escrow_platform_fee_pct', 'default_fee_pct']) expect(isMoneyKey(k)).toBe(true);
    expect(isMoneyKey('telecaller_phone')).toBe(false);
  });
  test('refused without a reason', async () => {
    await expect(configService.adminUpsertConfig('tds_rate_pct', { value: '2' }, 'admin1', '::1')).rejects.toMatchObject({ statusCode: 400, data: { code: 'REASON_REQUIRED' } });
  });
  test('saved with a reason: audit has old, new and reason', async () => {
    prisma.platformConfig.findUnique.mockResolvedValue({ key: 'tds_rate_pct', value: '5' });
    prisma.platformConfig.upsert = jest.fn().mockResolvedValue({ key: 'tds_rate_pct', value: '2' });
    await configService.adminUpsertConfig('tds_rate_pct', { value: '2', reason: 'Finance Act 2024 rate' }, 'admin1', '::1');
    expect(lastAudit()).toMatchObject({ action: 'MONEY_SETTING_CHANGED', targetId: 'tds_rate_pct', reason: 'Finance Act 2024 rate', adminId: 'admin1' });
    expect(JSON.parse(lastAudit().before)).toEqual({ value: '5' });
    expect(JSON.parse(lastAudit().after)).toEqual({ value: '2' });
  });
  test('a non-money key needs no reason', async () => {
    prisma.platformConfig.upsert = jest.fn().mockResolvedValue({});
    await configService.adminUpsertConfig('telecaller_phone', { value: '+919800000000' }, 'admin1');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ─── Ledger ──────────────────────────────────────────────────────────────────
describe('ledger', () => {
  const base = { type: 'TOKEN_IN', direction: 'IN', partyType: 'BUYER', grossPaise: 5000000, netPaise: 5000000, idempotencyKey: 'k1', createdByType: 'SYSTEM' };
  test('records integer paise once per idempotency key', async () => {
    const first = await ledger.record(base);
    expect(first.status).toBe('RECORDED');
    prisma.moneyLedgerEntry.findUnique.mockResolvedValue({ id: 'existing' });
    expect(await ledger.record(base)).toEqual({ id: 'existing' });
    expect(prisma.moneyLedgerEntry.create).toHaveBeenCalledTimes(1);
  });
  test('refuses rupee floats, unknown types and a reasonless ADJUSTMENT', async () => {
    await expect(ledger.record({ ...base, grossPaise: 50000.5 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(ledger.record({ ...base, type: 'MADE_UP' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(ledger.record({ ...base, type: 'ADJUSTMENT' })).rejects.toMatchObject({ data: { code: 'REASON_REQUIRED' } });
  });
  test('recordSafe never throws into a money flow', async () => {
    prisma.moneyLedgerEntry.create.mockRejectedValue(new Error('db down'));
    await expect(ledger.recordSafe(base)).resolves.toBeNull();
  });
  test('all spec entry types exist, plus the three added', () => {
    for (const t of ['TOKEN_IN', 'PROCESSING_FEE_IN', 'GATEWAY_FEE', 'SETTLEMENT_IN', 'SELLER_PAYOUT', 'PARTNER_COMMISSION', 'TDS_WITHHELD', 'TDS_DEPOSITED', 'TDS_RECEIVABLE', 'CANCELLATION_CHARGE', 'COMMISSION_VOUCHER', 'GST_INPUT_PENDING', 'GST_OUTPUT', 'GST_INPUT', 'BROKERAGE_INVOICED', 'BROKERAGE_RECEIVED', 'REFUND', 'PAYOUT_FEE', 'SERVICE_REVENUE', 'VENDOR_PAYMENT', 'ADJUSTMENT']) {
      expect(ledger.LEDGER_TYPES).toContain(t);
    }
  });
  test('token and processing fee: two lines, GST inside the fee', async () => {
    await ledger.onPaymentCaptured({ id: 'e1', leadId: 'l1', buyerId: 'b1', amount: 50000, processingFeePaise: 120900, razorpayPaymentId: 'pay_1' });
    const rows = prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data);
    expect(rows.map((r) => r.type)).toEqual(['TOKEN_IN', 'PROCESSING_FEE_IN']);
    expect(rows[0]).toMatchObject({ grossPaise: 5000000, direction: 'IN' });
    expect(rows[1].gstPaise).toBe(120900 - Math.round(120900 / 1.18));
    expect(rows[1].netPaise + rows[1].gstPaise).toBe(120900);
  });
  test('refund after 48 h: REFUND out and a CANCELLATION_CHARGE line', async () => {
    const quote = money.refundQuote({ reason: 'BUYER_CANCEL', tokenPaise: 5000000, feePaise: 120900, paidAt: new Date(Date.now() - 72 * 3600e3), settings: S.refund });
    await ledger.onRefund({ id: 'e1', leadId: 'l1', buyerId: 'b1', razorpayPaymentId: 'p' }, quote, { refundId: 'rfnd_1', actor: { createdByType: 'BUYER', createdById: 'b1' } });
    const rows = prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data);
    expect(rows.map((r) => r.type)).toEqual(['REFUND', 'CANCELLATION_CHARGE']);
    expect(rows[0]).toMatchObject({ grossPaise: 4700100, direction: 'OUT', createdByType: 'BUYER' });
    expect(rows[1].grossPaise).toBe(299900);
  });
  test('partner credit: commission, TDS withheld and, for a registered partner, GST pending', async () => {
    const c = { partnerId: 'p1', partnerName: 'Asha', commissionPaise: 7500000, tdsPaise: 150000, tdsRatePct: 2, tdsSection: '194H', gstRegistered: true, gstPendingPaise: 1350000 };
    await ledger.onPartnerCredit({ id: 'e1', leadId: 'l1' }, c, { tdsEntryId: 't1', taxInvoiceId: 'i1', invoiceNumber: 'INV-1', payoutId: 'pout_1' });
    const rows = prisma.moneyLedgerEntry.create.mock.calls.map((x) => x[0].data);
    expect(rows.map((r) => r.type)).toEqual(['PARTNER_COMMISSION', 'TDS_WITHHELD', 'GST_INPUT_PENDING']);
    expect(rows[0]).toMatchObject({ grossPaise: 7500000, tdsPaise: 150000, netPaise: 7350000, taxInvoiceId: 'i1', razorpayPayoutId: 'pout_1' });
    expect(rows[2]).toMatchObject({ status: 'PENDING_INVOICE', grossPaise: 1350000 });
  });
  test('unregistered partner: the payout line is a COMMISSION_VOUCHER, no GST line', async () => {
    const c = { partnerId: 'p1', commissionPaise: 7500000, tdsPaise: 150000, tdsRatePct: 2, tdsSection: '194H', gstRegistered: false, gstPendingPaise: 0 };
    await ledger.onPartnerCredit({ id: 'e1', leadId: 'l1' }, c, { voucherId: 'v1' });
    expect(prisma.moneyLedgerEntry.create.mock.calls.map((x) => x[0].data.type)).toEqual(['COMMISSION_VOUCHER', 'TDS_WITHHELD']);
  });
  test('a payout that was paid is a NEW row pointing at the original; a reversal likewise', async () => {
    prisma.moneyLedgerEntry.findFirst.mockResolvedValue({ id: 'orig', leadId: 'l1', escrowId: 'e1', type: 'PARTNER_COMMISSION', partyType: 'PARTNER', grossPaise: 7500000, tdsPaise: 150000, netPaise: 7350000 });
    await ledger.onPayoutStatus({ escrowId: 'e1', payoutId: 'pout_1', status: 'processed', utr: 'UTR1' });
    expect(prisma.moneyLedgerEntry.create.mock.calls.at(-1)[0].data).toMatchObject({ status: 'PAID', relatedEntryId: 'orig', utr: 'UTR1', createdByType: 'WEBHOOK' });
    await ledger.onPayoutStatus({ escrowId: 'e1', payoutId: 'pout_1', status: 'reversed', reason: 'bank returned it' });
    expect(prisma.moneyLedgerEntry.create.mock.calls.at(-1)[0].data).toMatchObject({ status: 'REVERSED', relatedEntryId: 'orig', direction: 'NONE' });
  });
  test('withCurrentStatus: the newest same-type child decides; a TDS line is not a status child', () => {
    const rows = [
      { id: 'a', type: 'PARTNER_COMMISSION', status: 'DUE', entryDate: new Date(1) },
      { id: 'b', type: 'PARTNER_COMMISSION', status: 'PAID', relatedEntryId: 'a', entryDate: new Date(2) },
      { id: 'c', type: 'TDS_WITHHELD', status: 'DUE', relatedEntryId: 'a', entryDate: new Date(3) },
    ];
    expect(ledger.withCurrentStatus(rows).find((r) => r.id === 'a').currentStatus).toBe('PAID');
  });
  test('manual lines: only allowed types, a reason, and one reversal per entry', async () => {
    await expect(ledger.addManual({ type: 'REFUND', direction: 'OUT', partyType: 'BUYER', grossPaise: 1 }, 'a')).rejects.toMatchObject({ statusCode: 400 });
    await expect(ledger.addManual({ type: 'ADJUSTMENT', direction: 'NONE', partyType: 'REALTYDOOR', grossPaise: 100 }, 'a')).rejects.toMatchObject({ data: { code: 'REASON_REQUIRED' } });
    prisma.moneyLedgerEntry.findUnique.mockResolvedValueOnce({ id: 'orig', leadId: 'l1' });
    prisma.moneyLedgerEntry.findFirst.mockResolvedValueOnce({ id: 'already' });
    await expect(ledger.addManual({ type: 'ADJUSTMENT', direction: 'NONE', partyType: 'REALTYDOOR', grossPaise: 100, reason: 'fix', reversesEntryId: 'orig' }, 'a')).rejects.toMatchObject({ statusCode: 409 });
    prisma.moneyLedgerEntry.findUnique.mockReset().mockResolvedValueOnce({ id: 'orig', leadId: 'l1' }).mockResolvedValue(null);
    prisma.moneyLedgerEntry.findFirst.mockReset().mockResolvedValue(null);
    const e = await ledger.addManual({ type: 'ADJUSTMENT', direction: 'NONE', partyType: 'REALTYDOOR', grossPaise: -100, reason: 'duplicate line', reversesEntryId: 'orig' }, 'admin1');
    expect(e).toMatchObject({ reversesEntryId: 'orig', reason: 'duplicate line', createdByType: 'ADMIN', leadId: 'l1' });
  });
  test('CSV cells cannot run as formulas and quote commas', () => {
    expect(ledger.csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(ledger.csvCell('+91 98')).toBe("'+91 98");
    expect(ledger.csvCell('a,b')).toBe('"a,b"');
    expect(ledger.csvCell(null)).toBe('');
  });
  test('monthly range is the IST month; bad month refused', () => {
    const { from, to } = ledger.monthRange('2026-10');
    expect(from.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(to.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(() => ledger.monthRange('2026-13')).toThrow();
  });
  test('ledger CSV: rupees with two decimals, header row', async () => {
    prisma.moneyLedgerEntry.findMany.mockResolvedValue([{ entryDate: new Date('2026-10-22T05:00:00Z'), id: 'x', type: 'TOKEN_IN', leadId: 'l1', partyType: 'BUYER', direction: 'IN', grossPaise: 5000000, gstPaise: 0, tdsPaise: 0, feePaise: 0, netPaise: 5000000, status: 'RECORDED' }]);
    const csv = await ledger.monthlyCsv('ledger', '2026-10');
    const [head, row] = csv.split('\r\n');
    expect(head.split(',')[0]).toBe('Date');
    expect(row).toContain('2026-10-22,x,TOKEN_IN,l1,BUYER');
    expect(row).toContain('50000.00');
  });
  test('reconcile: a missing ledger line shows as a difference', async () => {
    prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'e1', leadId: 'l1', amount: 50000, amountPaise: 5000000, processingFeePaise: 120900, status: 'HELD' }]);
    prisma.moneyLedgerEntry.findMany.mockResolvedValue([{ escrowId: 'e1', type: 'TOKEN_IN', grossPaise: 5000000 }]);
    const r = await ledger.reconcile();
    expect(r.tallied).toBe(false);
    expect(r.differences).toEqual([{ escrowId: 'e1', leadId: 'l1', what: 'PROCESSING_FEE_IN', expectedPaise: 120900, ledgerPaise: 0 }]);
    prisma.moneyLedgerEntry.findMany.mockResolvedValue([{ escrowId: 'e1', type: 'TOKEN_IN', grossPaise: 5000000 }, { escrowId: 'e1', type: 'PROCESSING_FEE_IN', grossPaise: 120900 }]);
    expect((await ledger.reconcile()).tallied).toBe(true);
  });
  test('payables: TDS overdue and partner GST held until matched', async () => {
    prisma.moneyLedgerEntry.findMany.mockImplementation(async ({ where }) => {
      const t = where.type;
      if (t?.in?.includes('PARTNER_COMMISSION')) return [{ id: 'c1', type: 'PARTNER_COMMISSION', status: 'DUE', netPaise: 7350000, entryDate: new Date(1) }];
      if (t === 'GST_INPUT_PENDING') return [{ id: 'g1', type: 'GST_INPUT_PENDING', status: 'PENDING_INVOICE', netPaise: 1350000, entryDate: new Date(1) }];
      return [];
    });
    prisma.tdsEntry.findMany.mockResolvedValue([{ tdsPaise: 150000, depositDueDate: new Date('2026-09-07') }]);
    prisma.escrowTransaction.findMany.mockResolvedValue([{ amount: 50000 }]);
    const p = await ledger.payablesReceivables(new Date('2026-10-22'));
    expect(p.payables).toMatchObject({ partnerCommissionPaise: 7350000, partnerGstAwaitingInvoicePaise: 1350000, tdsToDepositPaise: 150000, tdsOverduePaise: 150000, tdsOverdueCount: 1 });
    expect(p.heldForOthers.tokensInEscrowPaise).toBe(5000000);
  });
});

// ─── Tax invoice (GST-registered partner) ────────────────────────────────────
describe('tax invoice validation', () => {
  const good = { supplierGstin: GSTIN, recipientGstin: OURS, invoiceNumber: 'INV-7', invoiceDate: '2026-10-20', sacCode: '997221', placeOfSupply: 'Karnataka', taxableValuePaise: rs(75000), cgstPaise: rs(6750), sgstPaise: rs(6750), igstPaise: 0, totalPaise: rs(88500) };
  const settings = { ...S, company: { gstin: OURS, sacCode: '997221', legalName: 'Realtydoor' } };
  const check = (inv) => money.validateTaxInvoice(inv, { commissionPaise: rs(75000), partnerGstin: GSTIN, settings, now: new Date('2026-10-22') }).map((e) => e.code);
  test('a matching invoice passes (CGST + SGST)', () => expect(check(good)).toEqual([]));
  test('IGST instead of CGST + SGST also passes', () => expect(check({ ...good, cgstPaise: 0, sgstPaise: 0, igstPaise: rs(13500) })).toEqual([]));
  test.each([
    ['wrong taxable value', { taxableValuePaise: rs(74000), totalPaise: rs(87320) }, 'TAXABLE_MISMATCH'],
    ['supplier GSTIN not the profile one', { supplierGstin: '27ABCDE1234F1Z5' }, 'SUPPLIER_GSTIN_MISMATCH'],
    ['addressed to someone else', { recipientGstin: '29ZZZZZ9999Z1Z1' }, 'RECIPIENT_GSTIN_MISMATCH'],
    ['wrong GST', { cgstPaise: rs(5000), sgstPaise: rs(5000), totalPaise: rs(85000) }, 'GST_AMOUNT'],
    ['CGST and IGST both', { igstPaise: 1, totalPaise: rs(88500) + 1 }, 'GST_SPLIT'],
    ['total does not add up', { totalPaise: rs(90000) }, 'TOTAL_MISMATCH'],
    ['future date', { invoiceDate: '2026-12-01' }, 'FUTURE_DATE'],
    ['wrong SAC', { sacCode: '999999' }, 'SAC_MISMATCH'],
    ['no invoice number', { invoiceNumber: '  ' }, 'NO_INVOICE_NUMBER'],
  ])('%s is refused', (_n, patch, code) => expect(check({ ...good, ...patch })).toContain(code));
  test('a partner with no GSTIN cannot use a tax invoice', () => {
    expect(money.validateTaxInvoice(good, { commissionPaise: rs(75000), partnerGstin: null, settings }).map((e) => e.code)).toContain('PARTNER_NOT_REGISTERED');
  });
});

describe('tax invoice upload and review', () => {
  const fields = { supplierGstin: GSTIN, recipientGstin: OURS, invoiceNumber: 'INV-7', invoiceDate: '2026-10-20', sacCode: '997221', placeOfSupply: 'Karnataka', taxableValue: 75000, cgst: 6750, sgst: 6750, igst: 0, total: 88500 };
  const setup = () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', refCode: 'RD1', assignedPartnerId: 'p1', feePct: 2, dealPriceAtLock: 7500000, commissionLockedAt: new Date(), commissionVersion: 1, property: { price: 7500000, title: 'Plot' } });
    prisma.leadCommissionLine.findMany.mockResolvedValue([{ payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50 }]);
    prisma.user.findUnique.mockResolvedValue({ gstin: GSTIN });
    prisma.partnerTaxInvoice.findFirst.mockResolvedValue(null);
    prisma.partnerTaxInvoice.create.mockImplementation(async ({ data }) => ({ id: 'inv1', ...data }));
  };
  test('stores the file and all fields, linked to the deal, and audits the upload', async () => {
    setup();
    const inv = await tax.uploadInvoice('p1', 'l1', fields, 'https://s3/inv.pdf', '::1');
    expect(prisma.partnerTaxInvoice.create.mock.calls[0][0].data).toMatchObject({
      partnerId: 'p1', leadId: 'l1', status: 'UPLOADED', fileUrl: 'https://s3/inv.pdf', supplierGstin: GSTIN, invoiceNumber: 'INV-7',
      recipientGstin: OURS, sacCode: '997221', placeOfSupply: 'Karnataka', taxableValuePaise: 7500000, cgstPaise: 675000, sgstPaise: 675000, totalPaise: 8850000,
    });
    expect(inv.id).toBe('inv1');
    expect(auditActions()).toContain('TAX_INVOICE_UPLOADED');
    expect(lastAudit()).toMatchObject({ actorRole: 'PARTNER', adminId: 'p1' });
  });
  test('the wrong amount is refused with the reason', async () => {
    setup();
    await expect(tax.uploadInvoice('p1', 'l1', { ...fields, taxableValue: 70000, total: 82600 }, 'u', '::1')).rejects.toMatchObject({ statusCode: 400, data: { code: 'INVOICE_INVALID' } });
    expect(prisma.partnerTaxInvoice.create).not.toHaveBeenCalled();
  });
  test('a file is required, and a second live invoice is refused', async () => {
    setup();
    await expect(tax.uploadInvoice('p1', 'l1', fields, null, '::1')).rejects.toMatchObject({ data: { code: 'FILE_REQUIRED' } });
    prisma.partnerTaxInvoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-1', status: 'ACCEPTED' });
    await expect(tax.uploadInvoice('p1', 'l1', fields, 'u', '::1')).rejects.toMatchObject({ statusCode: 409, data: { code: 'INVOICE_EXISTS' } });
  });
  test('another partner cannot upload for this deal', async () => {
    setup();
    await expect(tax.uploadInvoice('p2', 'l1', fields, 'u', '::1')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('admin accepts: status, audit, partner told; rejects only with a reason', async () => {
    prisma.partnerTaxInvoice.findUnique.mockResolvedValue({ id: 'inv1', partnerId: 'p1', status: 'UPLOADED', invoiceNumber: 'INV-7' });
    prisma.partnerTaxInvoice.updateMany.mockResolvedValue({ count: 1 });
    await tax.reviewInvoice('inv1', 'ACCEPTED', {}, 'admin1', '::1');
    expect(lastAudit()).toMatchObject({ action: 'TAX_INVOICE_ACCEPTED', adminId: 'admin1', actorRole: 'ADMIN' });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'p1', type: 'TAX_INVOICE_ACCEPTED' }));
    await expect(tax.reviewInvoice('inv1', 'REJECTED', {}, 'admin1', '::1')).rejects.toMatchObject({ data: { code: 'REASON_REQUIRED' } });
    await tax.reviewInvoice('inv1', 'REJECTED', { reason: 'Wrong GSTIN' }, 'admin1', '::1');
    expect(lastAudit()).toMatchObject({ action: 'TAX_INVOICE_REJECTED', reason: 'Wrong GSTIN' });
  });
  test('only an uploaded invoice can be reviewed; only an accepted one can be matched', async () => {
    prisma.partnerTaxInvoice.findUnique.mockResolvedValue({ id: 'inv1', status: 'ACCEPTED' });
    await expect(tax.reviewInvoice('inv1', 'ACCEPTED', {}, 'a', 'ip')).rejects.toMatchObject({ statusCode: 409 });
    prisma.partnerTaxInvoice.findUnique.mockResolvedValue({ id: 'inv1', status: 'UPLOADED' });
    await expect(tax.markInvoiceMatched('inv1', {}, 'a', 'ip')).rejects.toMatchObject({ data: { code: 'INVOICE_NOT_ACCEPTED' } });
  });
  test('matched in GSTR-2B: GST input line written, audited', async () => {
    const inv = { id: 'inv1', partnerId: 'p1', leadId: 'l1', invoiceNumber: 'INV-7', cgstPaise: 675000, sgstPaise: 675000, igstPaise: 0, status: 'MATCHED', gstr2bPeriod: '2026-11' };
    prisma.partnerTaxInvoice.findUnique.mockResolvedValueOnce({ ...inv, status: 'ACCEPTED' }).mockResolvedValueOnce(inv);
    prisma.partnerTaxInvoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.moneyLedgerEntry.findFirst.mockResolvedValue({ id: 'pend', leadId: 'l1', type: 'GST_INPUT_PENDING', partyType: 'PARTNER', grossPaise: 1350000, gstPaise: 1350000, netPaise: 1350000 });
    await tax.markInvoiceMatched('inv1', { period: '2026-11' }, 'admin1', '::1');
    const rows = prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data);
    expect(rows.map((r) => r.type)).toEqual(['GST_INPUT', 'GST_INPUT_PENDING']);
    expect(rows[1]).toMatchObject({ status: 'MATCHED', relatedEntryId: 'pend' });
    expect(auditActions()).toContain('TAX_INVOICE_MATCHED');
  });
});

// ─── The gate: a registered partner is not paid without an accepted invoice ──
describe('registered-partner payout is blocked without an accepted tax invoice', () => {
  const setupRelease = ({ gstin, invoiceStatus, pan = 'ABCDE1234F', account = true }) => {
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'esc1', leadId: 'lead1', buyerId: 'b1', amount: 50000, status: 'HELD', razorpayPaymentId: 'pay_1', heldAt: new Date() });
    prisma.escrowTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.escrowTransaction.update.mockImplementation(async ({ data }) => ({ id: 'esc1', leadId: 'lead1', amount: 50000, ...data }));
    prisma.lead.findUnique.mockResolvedValue({
      id: 'lead1', refCode: 'RD1', feePct: 2, dealPriceAtLock: 7500000, commissionLockedAt: new Date(), commissionVersion: 1, allocationLetterUrl: 'x', buyerFeedbackStatus: 'VERIFIED_CLOSED',
      status: 'SITE_VISIT_DONE', assignedPartnerId: 'p1', property: { price: 7500000, title: 'Plot' }, dealPriceAtLock2: null,
      assignedPartner: { id: 'p1', name: 'Asha', payoutAccountStatus: account ? 'ACTIVE' : null, razorpayFundAccountId: account ? 'fa_1' : null },
    });
    prisma.leadCommissionLine.findMany.mockResolvedValue([{ payeeRole: 'CLOSING_AGENT', payeeUserId: 'p1', pct: 50 }]);
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', name: 'Asha', panNumber: pan, gstin, razorpayFundAccountId: account ? 'fa_1' : null, payoutAccountStatus: account ? 'ACTIVE' : null, billingAddress: 'x' });
    prisma.tdsEntry.findMany.mockResolvedValue([]);
    prisma.tdsEntry.upsert.mockImplementation(async ({ create }) => ({ id: 't1', ...create }));
    prisma.partnerTaxInvoice.findFirst.mockResolvedValue(invoiceStatus ? { id: 'inv1', status: invoiceStatus, invoiceNumber: 'INV-7' } : null);
    prisma.counter.upsert.mockResolvedValue({ seq: 12 });
    prisma.commissionVoucher.findUnique.mockResolvedValue(null);
    prisma.commissionVoucher.create.mockImplementation(async ({ data }) => ({ id: 'v1', ...data }));
    razorpay.createPayout.mockResolvedValue({ id: 'pout_p', status: 'processing' });
  };
  const releaseBody = { manualTransferConfirmed: true, note: 'seller paid by NEFT' };

  test('NO invoice: seller is released, partner leg is NOT paid, nothing credited, claim is marked deferred', async () => {
    setupRelease({ gstin: GSTIN, invoiceStatus: null });
    const out = await escrow.release('esc1', 'admin1', releaseBody, '::1');
    expect(razorpay.createPayout).not.toHaveBeenCalled();
    expect(out.partnerPayoutDeferred).toBe('TAX_INVOICE_REQUIRED');
    const claim = prisma.escrowTransaction.updateMany.mock.calls[0][0].data;
    expect(claim).toMatchObject({ status: 'RELEASED', partnerPayoutStatus: 'deferred', netAmount: 50000 });
    expect(claim.partnerSharePaise).toBeUndefined();
    expect(prisma.tdsEntry.upsert).not.toHaveBeenCalled();
    expect(prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data.type)).toEqual(['SELLER_PAYOUT']);
  });
  test('invoice only UPLOADED (not accepted) is still blocked; REJECTED is as good as none', async () => {
    setupRelease({ gstin: GSTIN, invoiceStatus: 'UPLOADED' });
    expect((await escrow.release('esc1', 'admin1', releaseBody, '::1')).partnerPayoutDeferred).toBe('TAX_INVOICE_REQUIRED');
    expect(razorpay.createPayout).not.toHaveBeenCalled();
  });
  test('the block cannot be overridden, not even with overrideConditions or payPartner', async () => {
    setupRelease({ gstin: GSTIN, invoiceStatus: null });
    const out = await escrow.release('esc1', 'admin1', { ...releaseBody, overrideConditions: true, overrideReason: 'urgent', payPartner: true, partnerShare: 99999 }, '::1');
    expect(out.partnerPayoutDeferred).toBe('TAX_INVOICE_REQUIRED');
    expect(razorpay.createPayout).not.toHaveBeenCalled();
  });
  test('ACCEPTED invoice: partner paid 73,500 (commission less TDS), TDS entry, no voucher, ledger lines incl. GST pending', async () => {
    setupRelease({ gstin: GSTIN, invoiceStatus: 'ACCEPTED' });
    const out = await escrow.release('esc1', 'admin1', releaseBody, '::1');
    expect(out.partnerPayoutDeferred).toBeNull();
    expect(razorpay.createPayout).toHaveBeenCalledTimes(1);
    expect(razorpay.createPayout.mock.calls[0][1]).toBe(7350000);
    expect(prisma.tdsEntry.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.commissionVoucher.create).not.toHaveBeenCalled();
    expect(prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data.type)).toEqual(['SELLER_PAYOUT', 'PARTNER_COMMISSION', 'TDS_WITHHELD', 'GST_INPUT_PENDING']);
    expect(auditActions()).toEqual(expect.arrayContaining(['PARTNER_COMMISSION_CREDITED', 'ESCROW_RELEASED']));
  });
  test('unregistered partner: no invoice needed; paid, voucher issued, COMMISSION_VOUCHER line', async () => {
    setupRelease({ gstin: null, invoiceStatus: null });
    await escrow.release('esc1', 'admin1', releaseBody, '::1');
    expect(razorpay.createPayout.mock.calls[0][1]).toBe(7350000);
    expect(prisma.commissionVoucher.create.mock.calls[0][0].data).toMatchObject({ voucherNumber: expect.stringMatching(/^CV\/\d{4}-\d{2}\/000012$/), commissionPaise: 7500000, tdsPaise: 150000, netPaise: 7350000, partnerPan: 'ABCDE1234F' });
    expect(prisma.moneyLedgerEntry.create.mock.calls.map((c) => c[0].data.type)).toEqual(['SELLER_PAYOUT', 'COMMISSION_VOUCHER', 'TDS_WITHHELD']);
  });

  describe('paying a held commission later', () => {
    const deferred = { id: 'esc1', leadId: 'lead1', buyerId: 'b1', amount: 50000, status: 'RELEASED', partnerPayoutStatus: 'deferred', payoutAttempt: 0 };
    test('still no invoice: refused with 409 TAX_INVOICE_REQUIRED, no payout', async () => {
      setupRelease({ gstin: GSTIN, invoiceStatus: null });
      prisma.escrowTransaction.findUnique.mockResolvedValue(deferred);
      await expect(escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1')).rejects.toMatchObject({ statusCode: 409, data: { code: 'TAX_INVOICE_REQUIRED' } });
      expect(razorpay.createPayout).not.toHaveBeenCalled();
      expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
    });
    test('invoice uploaded but not accepted: refused', async () => {
      setupRelease({ gstin: GSTIN, invoiceStatus: 'UPLOADED' });
      prisma.escrowTransaction.findUnique.mockResolvedValue(deferred);
      await expect(escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1')).rejects.toMatchObject({ data: { code: 'TAX_INVOICE_REQUIRED' } });
    });
    test('invoice accepted: paid once, TDS and ledger written, audited', async () => {
      setupRelease({ gstin: GSTIN, invoiceStatus: 'ACCEPTED' });
      prisma.escrowTransaction.findUnique.mockResolvedValue(deferred);
      await escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1');
      expect(razorpay.createPayout).toHaveBeenCalledTimes(1);
      expect(razorpay.createPayout.mock.calls[0][1]).toBe(7350000);
      expect(prisma.tdsEntry.upsert).toHaveBeenCalled();
      expect(auditActions()).toContain('PARTNER_PAYOUT_RELEASED');
    });
    test('a failed payout puts it back to deferred and records nothing', async () => {
      setupRelease({ gstin: GSTIN, invoiceStatus: 'ACCEPTED' });
      prisma.escrowTransaction.findUnique.mockResolvedValue(deferred);
      razorpay.createPayout.mockRejectedValue({ statusCode: 400, error: { description: 'insufficient balance' } });
      await expect(escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1')).rejects.toMatchObject({ statusCode: 502 });
      expect(prisma.escrowTransaction.update.mock.calls.at(-1)[0].data).toEqual({ partnerPayoutStatus: 'deferred' });
      expect(prisma.tdsEntry.upsert).not.toHaveBeenCalled();
    });
    test('nothing held: refused', async () => {
      setupRelease({ gstin: GSTIN, invoiceStatus: 'ACCEPTED' });
      prisma.escrowTransaction.findUnique.mockResolvedValue({ ...deferred, partnerPayoutStatus: 'processed' });
      await expect(escrow.payDeferredPartnerCommission('esc1', 'admin1', '::1')).rejects.toMatchObject({ data: { code: 'NO_DEFERRED_PAYOUT' } });
    });
  });
});

// ─── Commission voucher (unregistered partner) ───────────────────────────────
describe('commission voucher OTP', () => {
  const voucher = (over = {}) => ({ id: 'v1', partnerId: 'p1', status: 'ISSUED', voucherNumber: 'CV/2026-27/000001', netPaise: 7350000, otpHash: null, otpAttempts: 0, otpSentAt: null, ...over });
  test('sends a 6-digit code to the verified phone, stores only its hash, audits', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher());
    prisma.user.findUnique.mockResolvedValue({ phone: '+919800000000', phoneVerified: true });
    const { sendVoucherOtp } = require('../../src/lib/wati');
    await tax.requestVoucherOtp('p1', 'v1', '::1');
    const code = sendVoucherOtp.mock.calls[0][1];
    expect(code).toMatch(/^\d{6}$/);
    const stored = prisma.commissionVoucher.update.mock.calls[0][0].data;
    expect(stored.otpHash).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(auditActions()).toContain('COMMISSION_VOUCHER_OTP_SENT');
  });
  test('needs a verified phone; resend is rate limited', async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher());
    prisma.user.findUnique.mockResolvedValue({ phone: null, phoneVerified: false });
    await expect(tax.requestVoucherOtp('p1', 'v1', 'ip')).rejects.toMatchObject({ data: { code: 'PHONE_NOT_VERIFIED' } });
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpSentAt: new Date() }));
    await expect(tax.requestVoucherOtp('p1', 'v1', 'ip')).rejects.toMatchObject({ statusCode: 429 });
  });
  test('right code accepts and audits; wrong code counts attempts; expired and locked are refused', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHmac('sha256', process.env.OTP_HASH_SECRET || 'unset').update('123456').digest('hex');
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpHash: hash, otpExpiresAt: new Date(Date.now() + 60000) }));
    prisma.commissionVoucher.updateMany.mockResolvedValue({ count: 1 });
    prisma.commissionVoucher.findUnique.mockResolvedValue(voucher({ status: 'ACCEPTED' }));
    await expect(tax.acceptVoucher('p1', 'v1', '000000', '::1')).rejects.toMatchObject({ data: { code: 'OTP_WRONG' } });
    expect(prisma.commissionVoucher.update.mock.calls.at(-1)[0].data).toEqual({ otpAttempts: { increment: 1 } });
    const ok = await tax.acceptVoucher('p1', 'v1', '123456', '::1');
    expect(ok.status).toBe('ACCEPTED');
    expect(lastAudit()).toMatchObject({ action: 'COMMISSION_VOUCHER_ACCEPTED', actorRole: 'PARTNER' });
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpHash: hash, otpExpiresAt: new Date(Date.now() - 1000) }));
    await expect(tax.acceptVoucher('p1', 'v1', '123456', 'ip')).rejects.toMatchObject({ data: { code: 'OTP_EXPIRED' } });
    prisma.commissionVoucher.findFirst.mockResolvedValue(voucher({ otpHash: hash, otpExpiresAt: new Date(Date.now() + 1000), otpAttempts: 5 }));
    await expect(tax.acceptVoucher('p1', 'v1', '123456', 'ip')).rejects.toMatchObject({ statusCode: 429 });
  });
  test('the partner list never exposes the code hash', async () => {
    prisma.commissionVoucher.findMany.mockResolvedValue([voucher({ otpHash: 'abc', otpAttempts: 2 })]);
    const [v] = await tax.listVouchersForPartner('p1');
    expect(v.otpHash).toBeUndefined();
    expect(v.otpAttempts).toBeUndefined();
  });
  test("another partner's voucher is not found", async () => {
    prisma.commissionVoucher.findFirst.mockResolvedValue(null);
    await expect(tax.acceptVoucher('p2', 'v1', '123456', 'ip')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ─── TDS ledger ──────────────────────────────────────────────────────────────
describe('TDS ledger', () => {
  const entry = (o = {}) => ({ id: 't1', partnerId: 'p1', escrowId: 'e1', leadId: 'l1', tdsPaise: 150000, commissionBasePaise: 7500000, depositedAt: null, depositDueDate: new Date('2026-11-07'), panAtDeduction: 'ABCDE1234F', ...o });
  test('status: pending, overdue, deposited, none', () => {
    const now = new Date('2026-11-20');
    expect(tds.statusOf(entry({ depositDueDate: new Date('2026-12-07') }), now)).toBe('PENDING_DEPOSIT');
    expect(tds.statusOf(entry(), now)).toBe('OVERDUE');
    expect(tds.statusOf(entry({ depositedAt: new Date() }), now)).toBe('DEPOSITED');
    expect(tds.statusOf(entry({ tdsPaise: 0 }), now)).toBe('NO_TDS');
  });
  test('PAN is masked on screen', () => expect(tds.maskPan('ABCDE1234F')).toBe('XXXXXX234F'));
  test('deposit needs challan and BSR, writes a TDS_DEPOSITED ledger line and an audit entry', async () => {
    await expect(tds.recordDeposit(['t1'], { challanNumber: '', bsrCode: '' }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    prisma.tdsEntry.findUnique.mockResolvedValue(entry());
    prisma.tdsEntry.update.mockImplementation(async ({ data }) => entry(data));
    await tds.recordDeposit(['t1'], { challanNumber: 'CH123', bsrCode: '0510308', depositedAt: '2026-10-21T00:00:00Z' }, 'admin1', '::1');
    expect(prisma.tdsEntry.update.mock.calls[0][0].data).toEqual({ depositedAt: new Date('2026-10-21T00:00:00Z'), challanNumber: 'CH123', bsrCode: '0510308' });
    expect(prisma.moneyLedgerEntry.create.mock.calls.at(-1)[0].data).toMatchObject({ type: 'TDS_DEPOSITED', grossPaise: 150000, direction: 'OUT' });
    expect(lastAudit()).toMatchObject({ action: 'TDS_DEPOSITED', adminId: 'admin1' });
  });
  test('cannot deposit twice, or deposit a zero-TDS row', async () => {
    prisma.tdsEntry.findUnique.mockResolvedValue(entry({ depositedAt: new Date() }));
    await expect(tds.recordDeposit(['t1'], { challanNumber: 'C', bsrCode: 'B' + '1'.repeat(6) }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 409 });
    prisma.tdsEntry.findUnique.mockResolvedValue(entry({ tdsPaise: 0 }));
    await expect(tds.recordDeposit(['t1'], { challanNumber: 'CHALLAN', bsrCode: 'BSR1234' }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('the return needs the deposit first; Form 16A needs the return', async () => {
    prisma.tdsEntry.findUnique.mockResolvedValue(entry());
    await expect(tds.recordReturn(['t1'], { returnQuarter: '2026-27 Q3' }, 'a', 'ip')).rejects.toMatchObject({ data: { code: 'NOT_DEPOSITED' } });
    prisma.tdsEntry.findUnique.mockResolvedValue(entry({ depositedAt: new Date() }));
    await expect(tds.recordForm16a(['t1'], {}, 'a', 'ip')).rejects.toMatchObject({ data: { code: 'RETURN_NOT_FILED' } });
  });
  test('summary per partner and quarter', async () => {
    prisma.tdsEntry.findMany.mockResolvedValue([entry({ financialYear: '2026-27', quarter: 3 }), entry({ id: 't2', financialYear: '2026-27', quarter: 3, depositedAt: new Date(), tdsPaise: 50000, commissionBasePaise: 2500000, returnFiledAt: new Date() })]);
    const [g] = await tds.summary({});
    expect(g).toMatchObject({ commissionPaise: 10000000, tdsPaise: 200000, depositedPaise: 50000, outstandingPaise: 150000, returnFiled: false });
  });
});

// ─── 30-day escrow job ───────────────────────────────────────────────────────
describe('escrow hold-expiry job', () => {
  test('is registered in JOB_MODULES', () => {
    expect(require('../../src/jobs').JOB_MODULES).toContain('./escrowHoldExpiry');
    expect(typeof require('../../src/jobs/escrowHoldExpiry').start).toBe('function');
  });
  test('automatic refund is OFF by default: it only alerts', async () => {
    const job = require('../../src/jobs/escrowHoldExpiry');
    prisma.escrowTransaction.findMany.mockResolvedValue([{ id: 'e1', amount: 50000, leadId: 'l1' }]);
    const r = await job.runOnce();
    expect(r).toMatchObject({ due: 1, alerted: 1, refunded: 0, auto: false });
    expect(prisma.escrowTransaction.updateMany).not.toHaveBeenCalled();
  });
  test('looks for tokens held longer than escrow_hold_days (30)', async () => {
    const job = require('../../src/jobs/escrowHoldExpiry');
    prisma.escrowTransaction.findMany.mockResolvedValue([]);
    const now = new Date('2026-11-30T00:00:00Z');
    await job.runOnce({ now });
    expect(prisma.escrowTransaction.findMany.mock.calls[0][0].where).toEqual({ status: 'HELD', heldAt: { lte: new Date('2026-10-31T00:00:00Z') } });
  });
});
