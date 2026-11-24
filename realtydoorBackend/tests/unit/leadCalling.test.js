// The pool calling list: take the next batch, see it, tap an outcome.
jest.mock('../../src/lib/prisma', () => ({
  lead: { count: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  leadNote: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));

const prisma = require('../../src/lib/prisma');
const svc = require('../../src/modules/admin/leadCalling.service');
const { ALLOWED } = require('../../src/middleware/salesOnly');

const OID = (n) => String(n).padStart(24, '0');
const BDE = { id: OID(1), name: 'Bhavya', role: 'ADMIN', staffRole: 'BDE', adminPermissions: ['SALES'] };
const FINANCE = { id: OID(7), name: 'Fin', role: 'ADMIN', staffRole: 'FINANCE_STAFF', adminPermissions: ['FINANCE'] };
const NOW = new Date('2026-11-24T06:00:00Z'); // 11:30 IST
const pooled = (over = {}) => ({ id: OID(100), buyerPhone: '+919000000001', status: 'UNASSIGNED', ownerStaffId: OID(1), salesStage: null, poolBatch: 'b1', poolReleasedAt: null, poolGroup: 'B', contactAttempts: 0, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.lead.count.mockResolvedValue(0);
  prisma.lead.findMany.mockResolvedValue([]);
  prisma.lead.updateMany.mockResolvedValue({ count: 0 });
  prisma.lead.update.mockImplementation(async ({ data }) => ({ ...pooled(), ...data }));
  prisma.leadNote.create.mockResolvedValue({});
});

describe('take the next batch', () => {
  test('a BDE takes up to 50 unowned, contactable leads of one group, and the claim cannot steal an owned lead', async () => {
    prisma.lead.findMany.mockResolvedValueOnce([{ id: OID(11) }, { id: OID(12) }]).mockResolvedValueOnce([{ id: OID(11) }, { id: OID(12) }]);
    const out = await svc.takeNext(BDE, {}, '1.1.1.1', NOW);
    expect(out).toEqual({ taken: 2 });
    const find = prisma.lead.findMany.mock.calls[0][0];
    expect(find.take).toBe(50);
    expect(find.where).toMatchObject({ poolBatch: { isSet: true }, poolReleasedAt: { isSet: false }, poolGroup: 'B' });
    expect(JSON.stringify(find.where)).toContain('doNotContactAt');
    const claim = prisma.lead.updateMany.mock.calls[0][0];
    expect(JSON.stringify(claim.where)).toContain('ownerStaffId');
    expect(claim.data).toMatchObject({ ownerStaffId: BDE.id, ownerAssignedAt: NOW });
    expect(prisma.leadNote.createMany.mock.calls[0][0].data).toHaveLength(2);
  });
  test('only tops the batch up to 50 of waiting work', async () => {
    prisma.lead.count.mockResolvedValue(30);
    prisma.lead.findMany.mockResolvedValue([]);
    await svc.takeNext(BDE, {}, null, NOW);
    expect(prisma.lead.findMany.mock.calls[0][0].take).toBe(20);
  });
  test('a full batch is refused in plain words', async () => {
    prisma.lead.count.mockResolvedValue(50);
    await expect(svc.takeNext(BDE, {}, null, NOW)).rejects.toMatchObject({ statusCode: 409, data: { code: 'BATCH_FULL' } });
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });
  test('the archive group cannot be taken, and staff without sales access are refused', async () => {
    await expect(svc.takeNext(BDE, { group: 'C' }, null, NOW)).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.takeNext(FINANCE, {}, null, NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
  test('asking for fewer takes fewer, and never more than 50', async () => {
    await svc.takeNext(BDE, { count: 10 }, null, NOW);
    expect(prisma.lead.findMany.mock.calls[0][0].take).toBe(10);
    prisma.lead.findMany.mockClear();
    await svc.takeNext(BDE, { count: 5000 }, null, NOW);
    expect(prisma.lead.findMany.mock.calls[0][0].take).toBe(50);
  });
});

describe('my calling list', () => {
  test('due follow-ups first, then leads never called (newest old date first), then later follow-ups', async () => {
    prisma.lead.findMany.mockResolvedValue([
      { id: 'later', nextFollowUpAt: new Date('2026-11-30T05:00:00Z'), originalLeadAt: new Date('2026-01-01') },
      { id: 'newOld', originalLeadAt: new Date('2026-03-01') },
      { id: 'newNew', originalLeadAt: new Date('2026-09-01') },
      { id: 'due', nextFollowUpAt: new Date('2026-11-24T04:00:00Z'), originalLeadAt: new Date('2026-01-01') },
      { id: 'overdue', nextFollowUpAt: new Date('2026-11-20T04:00:00Z'), originalLeadAt: new Date('2026-01-01') },
    ]);
    prisma.lead.count.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    const out = await svc.myBatch(BDE, NOW);
    expect(out.leads.map((l) => l.id)).toEqual(['overdue', 'due', 'newNew', 'newOld', 'later']);
    expect(out.summary).toMatchObject({ waiting: 3, dueToday: 2, later: 1, calledToday: 7, batchSize: 50, room: 47 });
    expect(prisma.lead.findMany.mock.calls[0][0].where).toMatchObject({ ownerStaffId: BDE.id, poolBatch: { isSet: true }, poolReleasedAt: { isSet: false } });
  });
});

describe('one-tap outcomes', () => {
  const run = (outcome, extra = {}, leadOver = {}) => {
    prisma.lead.findUnique.mockResolvedValue(pooled(leadOver));
    return svc.recordOutcome(BDE, OID(100), { outcome, ...extra }, '1.1.1.1', NOW);
  };
  const updates = () => prisma.lead.update.mock.calls.map((c) => c[0].data);

  test('no answer: counts the attempt and sets tomorrow 10:30 India time as the next call', async () => {
    const out = await run('NO_ANSWER');
    expect(out.nextFollowUpAt.toISOString()).toBe('2026-11-25T05:00:00.000Z');
    expect(updates()[0]).toMatchObject({ contactAttempts: 1, salesStage: 'FOLLOW_UP' });
    expect(prisma.leadNote.create.mock.calls[0][0].data).toMatchObject({ kind: 'CALL' });
  });
  test('call later needs a date, and not one years away', async () => {
    await expect(run('CALL_LATER')).rejects.toMatchObject({ data: { code: 'FOLLOW_UP_REQUIRED' } });
    await expect(run('CALL_LATER', { followUpAt: '2027-06-01T05:00:00Z' })).rejects.toMatchObject({ data: { code: 'FOLLOW_UP_INVALID' } });
    const out = await run('CALL_LATER', { followUpAt: '2026-11-27T05:00:00Z' });
    expect(out.nextFollowUpAt.toISOString()).toBe('2026-11-27T05:00:00.000Z');
  });
  test('interested qualifies the lead (warm) and releases it from the pool; hot sets hot', async () => {
    prisma.lead.findUnique.mockResolvedValue(pooled({ salesStage: 'CONTACTED' }));
    const out = await run('INTERESTED', {}, { salesStage: 'CONTACTED' });
    expect(out.released).toBe(true);
    const qual = updates().find((d) => d.salesStage === 'QUALIFIED');
    expect(qual).toMatchObject({ temperature: 'WARM', poolReleasedAt: expect.any(Date) });
    prisma.lead.update.mockClear();
    await run('HOT', {}, { salesStage: 'CONTACTED' });
    expect(updates().find((d) => d.salesStage === 'QUALIFIED')).toMatchObject({ temperature: 'HOT' });
  });
  test('not interested and wrong number end the chase with a reason and move the lead to the archive group', async () => {
    for (const [outcome, reason] of [['NOT_INTERESTED', 'Not interested'], ['WRONG_NUMBER', 'Wrong number']]) {
      prisma.lead.update.mockClear();
      const out = await run(outcome, {}, { salesStage: 'CONTACTED' });
      expect(out.released).toBe(false);
      expect(updates().find((d) => d.salesStage === 'NOT_QUALIFIED')).toMatchObject({ notQualifiedReason: reason, poolGroup: 'C' });
    }
  });
  test('asked not to be called also marks the number do-not-contact everywhere', async () => {
    await run('DO_NOT_CALL', {}, { salesStage: 'CONTACTED' });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { buyerPhone: '+919000000001' }, data: { doNotContactAt: NOW } });
  });
  test('a lead that is not in the pool, a lead that is not yours, and a made-up outcome are all refused', async () => {
    await expect(run('INTERESTED', {}, { poolReleasedAt: new Date() })).rejects.toMatchObject({ data: { code: 'NOT_IN_POOL' } });
    await expect(run('INTERESTED', {}, { ownerStaffId: OID(2) })).rejects.toMatchObject({ statusCode: 404 });
    await expect(run('SOLD')).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.recordOutcome(FINANCE, OID(100), { outcome: 'NO_ANSWER' }, null, NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('a BDE may reach the calling list routes, and nothing next to them', () => {
  const allowed = (method, path) => ALLOWED.some(([m, re]) => m === method && re.test(path));
  test('the three calling routes', () => {
    expect(allowed('GET', '/leads/pool/my-batch')).toBe(true);
    expect(allowed('POST', '/leads/pool/take')).toBe(true);
    expect(allowed('POST', `/leads/${OID(5)}/pool/outcome`)).toBe(true);
  });
  test('not the manager pool routes', () => {
    expect(allowed('POST', '/leads/pool/release')).toBe(false);
    expect(allowed('POST', '/leads/pool/move')).toBe(false);
    expect(allowed('GET', '/leads/pool-summary')).toBe(false);
  });
});
