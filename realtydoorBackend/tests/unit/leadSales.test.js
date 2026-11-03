jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  leadNote: { create: jest.fn(), findMany: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));

const ExcelJS = require('exceljs');
const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const { requirePermission } = require('../../src/middleware/requirePermission');
const { DEFAULT_PERMISSIONS_BY_STAFF_ROLE } = require('../../src/utils/adminPermissions');
const f = require('../../src/lib/leadSales');
const service = require('../../src/modules/leadSales/leadSales.service');
const { updateSalesSchema, addNoteSchema } = require('../../src/modules/leadSales/leadSales.validator');

const OID = (n) => String(n).padStart(24, '0');
const BDE = { id: OID(1), name: 'Bhavya', role: 'ADMIN', staffRole: 'BDE', adminPermissions: ['SALES'] };
const BDE2 = { id: OID(2), name: 'Chetan', role: 'ADMIN', staffRole: 'BDE', adminPermissions: ['SALES'] };
const MANAGER = { id: OID(9), name: 'Meera', role: 'ADMIN', staffRole: 'CRM_MANAGER', adminPermissions: ['LEADS', 'SALES'] };
const OWNER_ADMIN = { id: OID(8), name: 'Owner', role: 'ADMIN', staffRole: null, adminPermissions: [] };
const FINANCE = { id: OID(7), name: 'Fin', role: 'ADMIN', staffRole: 'FINANCE_STAFF', adminPermissions: ['FINANCE'] };
const lead = (over = {}) => ({ id: OID(100), buyerName: 'Asha', buyerPhone: '+919000000001', buyerEmail: 'a@x.in', status: 'UNASSIGNED', source: 'WEBSITE', createdAt: new Date('2026-11-01T05:00:00Z'), ownerStaffId: OID(1), salesStage: null, ...over });

describe('who can do what', () => {
  test('manager, BDE, and everyone else', () => {
    expect(f.salesAccess(OWNER_ADMIN)).toMatchObject({ manager: true, bde: false, canWork: true });
    expect(f.salesAccess(MANAGER)).toMatchObject({ manager: true, bde: false });
    expect(f.salesAccess(BDE)).toMatchObject({ manager: false, bde: true, canWork: true });
    expect(f.salesAccess(FINANCE)).toMatchObject({ manager: false, bde: false, canWork: false });
  });
  test('only a BDE is limited to their own leads', () => {
    expect(f.leadScope(BDE)).toEqual({ ownerStaffId: OID(1) });
    expect(f.leadScope(MANAGER)).toEqual({});
    expect(f.leadScope(OWNER_ADMIN)).toEqual({});
    expect(f.leadScope(FINANCE)).toEqual({});
  });
  test('the BDE role holds SALES only: passes the sales gate, fails the manager gate', () => {
    expect(DEFAULT_PERMISSIONS_BY_STAFF_ROLE.BDE).toEqual(['SALES']);
    const verdict = (scope) => { let r = 'allowed'; requirePermission(scope)({ user: BDE }, {}, (e) => { if (e) r = e.statusCode; }); return r; };
    expect(verdict(['LEADS', 'SALES'])).toBe('allowed');
    expect(verdict('LEADS')).toBe(403);
    expect(verdict('FINANCE')).toBe(403);
  });
});

describe('follow-up days are India days', () => {
  test('today runs from 00:00 to 24:00 IST', () => {
    const { start, end } = f.istDayRange(new Date('2026-11-03T20:00:00Z')); // 01:30 on 4 Nov in India
    expect(start.toISOString()).toBe('2026-11-03T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-11-04T18:30:00.000Z');
    expect(f.istDayRange(new Date('2026-11-03T10:00:00Z')).start.toISOString()).toBe('2026-11-02T18:30:00.000Z');
  });
});

describe('salesWhere', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  test('nothing asked, nothing added', () => expect(f.salesWhere({}, OID(1), now)).toEqual({}));
  test('NEW also catches leads that never had a stage', () => {
    expect(f.salesWhere({ salesStage: 'NEW' }, OID(1), now).AND[0].OR).toHaveLength(3);
    expect(f.salesWhere({ salesStage: 'QUALIFIED' }, OID(1), now)).toEqual({ AND: [{ salesStage: 'QUALIFIED' }] });
  });
  test('owner: me, none, an id', () => {
    expect(f.salesWhere({ owner: 'me' }, OID(1), now)).toEqual({ AND: [{ ownerStaffId: OID(1) }] });
    expect(f.salesWhere({ owner: 'none' }, OID(1), now).AND[0].OR).toHaveLength(2);
    expect(f.salesWhere({ owner: OID(2) }, OID(1), now)).toEqual({ AND: [{ ownerStaffId: OID(2) }] });
  });
  test('follow-up buckets use IST days and skip finished leads', () => {
    const { start, end } = f.istDayRange(now);
    expect(f.salesWhere({ followUp: 'overdue' }, OID(1), now).AND).toEqual([{ nextFollowUpAt: { lt: start } }, { salesStage: { notIn: ['QUALIFIED', 'NOT_QUALIFIED'] } }]);
    expect(f.salesWhere({ followUp: 'today' }, OID(1), now).AND[0]).toEqual({ nextFollowUpAt: { gte: start, lt: end } });
    expect(f.salesWhere({ followUp: 'upcoming' }, OID(1), now).AND[0]).toEqual({ nextFollowUpAt: { gte: end } });
  });
  test('dates: "to" includes the whole last day', () => {
    const w = f.salesWhere({ from: '2026-11-01', to: '2026-11-02' }, OID(1), now);
    expect(w.AND[0].createdAt.gte).toEqual(new Date('2026-11-01'));
    expect(w.AND[0].createdAt.lt).toEqual(new Date('2026-11-03'));
  });
  test.each([[{ salesStage: 'X' }], [{ temperature: 'LUKEWARM' }], [{ owner: 'bob' }], [{ followUp: 'soon' }]])('refuses %j', (q) => expect(() => f.salesWhere(q, OID(1))).toThrow());
});

describe('planSalesChange', () => {
  const mgr = f.salesAccess(MANAGER); const bde = f.salesAccess(BDE);
  test('qualifying stamps the time, clears the follow-up and says so', () => {
    const { data, said } = f.planSalesChange(lead({ salesStage: 'FOLLOW_UP', nextFollowUpAt: new Date() }), { salesStage: 'QUALIFIED' }, bde);
    expect(data).toMatchObject({ salesStage: 'QUALIFIED', nextFollowUpAt: null, notQualifiedReason: null });
    expect(data.qualifiedAt).toBeInstanceOf(Date);
    expect(said).toContain('Stage: Follow-up → Qualified');
  });
  test('not qualified needs a reason', () => {
    expect(() => f.planSalesChange(lead(), { salesStage: 'NOT_QUALIFIED' }, bde)).toThrow(/why/);
    expect(f.planSalesChange(lead(), { salesStage: 'NOT_QUALIFIED', notQualifiedReason: ' budget too low ' }, bde).data.notQualifiedReason).toBe('budget too low');
  });
  test('follow-up stage needs a date', () => {
    expect(() => f.planSalesChange(lead(), { salesStage: 'FOLLOW_UP' }, bde)).toThrow(/next follow-up/);
    expect(f.planSalesChange(lead(), { salesStage: 'FOLLOW_UP', nextFollowUpAt: '2026-11-05T04:30:00.000Z' }, bde).data.nextFollowUpAt).toEqual(new Date('2026-11-05T04:30:00.000Z'));
  });
  test('reopening a finished lead clears what qualification carried', () => {
    const { data } = f.planSalesChange(lead({ salesStage: 'NOT_QUALIFIED', notQualifiedReason: 'x', qualifiedAt: null }), { salesStage: 'CONTACTED' }, bde);
    expect(data).toMatchObject({ salesStage: 'CONTACTED', notQualifiedReason: null, qualifiedAt: null });
  });
  test('only a manager changes the owner', () => {
    expect(() => f.planSalesChange(lead(), { ownerStaffId: OID(2) }, bde)).toThrow(/manager/);
    const { data } = f.planSalesChange(lead(), { ownerStaffId: OID(2) }, mgr);
    expect(data.ownerStaffId).toBe(OID(2));
    expect(data.ownerAssignedAt).toBeInstanceOf(Date);
  });
  test('nothing changed, nothing planned', () => {
    expect(f.planSalesChange(lead({ temperature: 'HOT' }), { temperature: 'HOT' }, bde).data).toEqual({});
  });
  test('a bad date or temperature is refused', () => {
    expect(() => f.planSalesChange(lead(), { nextFollowUpAt: 'soon' }, bde)).toThrow(/not valid/);
    expect(() => f.planSalesChange(lead(), { temperature: 'LUKEWARM' }, bde)).toThrow();
  });
});

describe('input validation', () => {
  test('sales update', () => {
    expect(updateSalesSchema.parse({ salesStage: 'CONTACTED', temperature: null }).temperature).toBeNull();
    expect(() => updateSalesSchema.parse({ salesStage: 'WON' })).toThrow();
    expect(() => updateSalesSchema.parse({ ownerStaffId: 'abc' })).toThrow();
    expect(() => updateSalesSchema.parse({ nextFollowUpAt: 'tomorrow' })).toThrow();
  });
  test('notes', () => {
    expect(addNoteSchema.parse({ text: '  Called, will visit Sat ' })).toEqual({ kind: 'NOTE', text: 'Called, will visit Sat' });
    expect(() => addNoteSchema.parse({ text: '   ' })).toThrow();
    expect(() => addNoteSchema.parse({ kind: 'SYSTEM', text: 'x' })).toThrow(); // only the system writes SYSTEM notes
    expect(() => addNoteSchema.parse({ text: 'x'.repeat(2001) })).toThrow();
  });
});

describe('service', () => {
  beforeEach(() => { jest.clearAllMocks(); prisma.user.findMany.mockResolvedValue([]); prisma.lead.update.mockImplementation(async ({ data }) => ({ ...lead(), ...data })); prisma.leadNote.create.mockImplementation(async ({ data }) => ({ id: 'n1', createdAt: new Date(), ...data })); });

  test('a BDE cannot open or change another BDE\'s lead, and is told nothing about it', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead({ ownerStaffId: OID(2) }));
    await expect(service.updateSales(BDE, OID(100), { temperature: 'HOT' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.addNote(BDE, OID(100), { kind: 'NOTE', text: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.listNotes(BDE, OID(100))).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.leadNote.create).not.toHaveBeenCalled();
  });
  test('a manager can work any lead', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead({ ownerStaffId: OID(2) }));
    await expect(service.updateSales(MANAGER, OID(100), { temperature: 'HOT' })).resolves.toMatchObject({ temperature: 'HOT' });
  });
  test('someone outside sales is refused', async () => {
    await expect(service.updateSales(FINANCE, OID(100), { temperature: 'HOT' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.salesSummary(FINANCE)).rejects.toMatchObject({ statusCode: 403 });
  });
  test('once the lead is with a partner, the BDE can no longer change it (notes still work)', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead({ status: 'ASSIGNED' }));
    await expect(service.updateSales(BDE, OID(100), { temperature: 'HOT' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'LEAD_HANDED_OVER' } });
    await expect(service.addNote(BDE, OID(100), { kind: 'NOTE', text: 'FYI' })).resolves.toBeTruthy();
  });
  test('a change writes a system note naming what changed, and an audit row', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await service.updateSales(BDE, OID(100), { salesStage: 'NOT_QUALIFIED', notQualifiedReason: 'Wants a rental' }, '1.1.1.1');
    const note = prisma.leadNote.create.mock.calls[0][0].data;
    expect(note).toMatchObject({ kind: 'SYSTEM', authorName: 'Bhavya' });
    expect(note.text).toContain('Stage: New → Not qualified');
    expect(note.text).toContain('Reason: Wants a rental');
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEAD_SALES_UPDATED', adminId: BDE.id }));
  });
  test('the new owner must be a staff account', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.updateSales(MANAGER, OID(100), { ownerStaffId: OID(2) })).rejects.toMatchObject({ data: { code: 'OWNER_INVALID' } });
    prisma.user.findFirst.mockResolvedValue({ id: OID(2) });
    await expect(service.updateSales(MANAGER, OID(100), { ownerStaffId: OID(2) })).resolves.toBeTruthy();
  });
  test('logging a call stamps last-contacted and moves a new lead to Contacted; a note with a date moves it to Follow-up', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await service.addNote(BDE, OID(100), { kind: 'CALL', text: 'Picked up, wants 2BHK' });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ salesStage: 'CONTACTED' });
    expect(prisma.lead.update.mock.calls[0][0].data.lastContactedAt).toBeInstanceOf(Date);
    prisma.lead.update.mockClear();
    await service.addNote(BDE, OID(100), { kind: 'CALL', text: 'Call back Thursday', nextFollowUpAt: '2026-11-06T04:30:00.000Z' });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ salesStage: 'FOLLOW_UP', nextFollowUpAt: new Date('2026-11-06T04:30:00.000Z') });
  });
  test('a plain note changes nothing on the lead; a finished lead keeps its stage', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await service.addNote(BDE, OID(100), { kind: 'NOTE', text: 'Thinking about it' });
    expect(prisma.lead.update).not.toHaveBeenCalled();
    prisma.lead.findUnique.mockResolvedValue(lead({ salesStage: 'QUALIFIED' }));
    await service.addNote(BDE, OID(100), { kind: 'CALL', text: 'x', nextFollowUpAt: '2026-11-06T04:30:00.000Z' });
    expect(prisma.lead.update.mock.calls[0][0].data.salesStage).toBeUndefined();
  });
  test('the old single note is returned beside the new history', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead({ adminNotes: 'old note' }));
    prisma.leadNote.findMany.mockResolvedValue([{ id: 'n1', text: 'new' }]);
    const r = await service.listNotes(BDE, OID(100));
    expect(r.legacyNote).toBe('old note');
    expect(r.notes).toHaveLength(1);
  });
  test('summary is scoped to the BDE and hides the unowned count from them', async () => {
    prisma.lead.count.mockResolvedValue(3);
    const s = await service.salesSummary(BDE);
    expect(s.unowned).toBeNull();
    expect(s.stages).toMatchObject({ NEW: 3, QUALIFIED: 3 });
    for (const call of prisma.lead.count.mock.calls) expect(call[0].where.ownerStaffId).toBe(BDE.id);
    expect((await service.salesSummary(MANAGER)).unowned).toBe(3);
  });
  test('owners lists the BDEs by name', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: OID(1), name: 'Bhavya', email: 'b@x', staffRole: 'BDE' }, { id: OID(2), name: null, email: 'c@x', staffRole: 'BDE' }]);
    expect(await service.owners(MANAGER)).toEqual([{ id: OID(1), name: 'Bhavya', staffRole: 'BDE' }, { id: OID(2), name: 'c@x', staffRole: 'BDE' }]);
  });
});

describe('Excel export', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const row = (over = {}) => lead({ refCode: 'RD-L-000101', city: 'Bengaluru', salesStage: 'FOLLOW_UP', temperature: 'HOT', ownerStaffId: OID(1), nextFollowUpAt: new Date('2026-11-05T04:30:00Z'), property: { title: 'Green Park', city: 'Chintamani' }, assignedPartner: null, ...over });

  test('builds a sheet with a header, the leads, their owner and the latest notes; and records the export', async () => {
    prisma.lead.count.mockResolvedValue(2);
    prisma.lead.findMany.mockResolvedValue([row(), row({ id: OID(101), refCode: 'RD-L-000102', buyerName: '=HYPERLINK("http://evil","x")', salesStage: null, temperature: null, ownerStaffId: null })]);
    prisma.leadNote.findMany.mockResolvedValue([
      { leadId: OID(100), createdAt: new Date('2026-11-02T05:00:00Z'), authorName: 'Bhavya', kind: 'CALL', text: 'Wants a 3BHK' },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: OID(1), name: 'Bhavya', email: 'b@x' }]);
    const { buffer, rows } = await service.exportLeads(MANAGER, { salesStage: 'FOLLOW_UP' }, '1.1.1.1');
    expect(rows).toBe(2);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Leads');
    expect(ws.getRow(1).values.slice(1, 4)).toEqual(['Reference', 'Received', 'Buyer']);
    expect(ws.rowCount).toBe(3);
    const first = ws.getRow(2);
    expect(first.getCell(1).value).toBe('RD-L-000101');
    expect(first.getCell(10).value).toBe('Follow-up');
    expect(first.getCell(11).value).toBe('Hot');
    expect(first.getCell(12).value).toBe('Bhavya');
    expect(first.getCell(19).value).toContain('Bhavya (call): Wants a 3BHK');
    // a buyer name that looks like a formula is stored as text, never as a formula
    const evil = ws.getRow(3).getCell(3).value;
    expect(typeof evil).toBe('string');
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEADS_EXPORTED', adminId: MANAGER.id, metadata: { rows: 2, filters: ['salesStage'] } }));
  });
  test('refuses a file bigger than the cap and says how to shrink it', async () => {
    prisma.lead.count.mockResolvedValue(service.EXPORT_MAX + 1);
    await expect(service.exportLeads(MANAGER, {}, '1.1.1.1')).rejects.toMatchObject({ statusCode: 400, data: { code: 'EXPORT_TOO_LARGE' } });
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });
  test('uses the same filters as the list, including the BDE scope', () => {
    const w = service.listWhere({ status: 'UNASSIGNED', owner: 'me', temperature: 'HOT' }, BDE);
    expect(w).toMatchObject({ status: 'UNASSIGNED', ownerStaffId: BDE.id });
    expect(w.AND).toHaveLength(2);
  });
});
