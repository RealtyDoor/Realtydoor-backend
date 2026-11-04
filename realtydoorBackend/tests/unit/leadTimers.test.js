jest.mock('../../src/lib/prisma', () => ({ lead: { findMany: jest.fn(), update: jest.fn() } }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { createNotification, notifyAdmins } = require('../../src/lib/notifications');
const { getConfigNumber } = require('../../src/modules/config/config.service');
const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
const t = require('../../src/lib/leadTimers');
const salesRules = require('../../src/lib/leadSales');
const job = require('../../src/jobs/leadHygiene');
const { JOB_MODULES } = require('../../src/jobs');

const NOW = new Date('2026-11-10T10:00:00Z');
const ago = (hours) => new Date(NOW.getTime() - hours * 3_600_000);
const day = (n) => ago(n * 24);

describe('partnerResponseAction: an assigned lead the partner has not started', () => {
  const lead = (over = {}) => ({ status: 'ASSIGNED', assignedPartnerId: 'P1', assignedAt: ago(10), createdAt: ago(80), ...over });
  test('off when the switch is 0 or missing', () => {
    expect(t.partnerResponseAction(lead({ assignedAt: ago(500) }), NOW, 0)).toBe('none');
    expect(t.partnerResponseAction(lead({ assignedAt: ago(500) }), NOW, undefined)).toBe('none');
  });
  test('quiet at first, a reminder at half the time, back to the pool at the full time', () => {
    expect(t.partnerResponseAction(lead({ assignedAt: ago(10) }), NOW, 48)).toBe('none');
    expect(t.partnerResponseAction(lead({ assignedAt: ago(25) }), NOW, 48)).toBe('remind');
    expect(t.partnerResponseAction(lead({ assignedAt: ago(25), responseReminderAt: ago(1) }), NOW, 48)).toBe('none'); // reminded once only
    expect(t.partnerResponseAction(lead({ assignedAt: ago(49) }), NOW, 48)).toBe('return');
    expect(t.partnerResponseAction(lead({ assignedAt: ago(49), responseReminderAt: ago(20) }), NOW, 48)).toBe('return');
  });
  test.each([
    ['a visit is booked', { siteVisitScheduledAt: ago(-5) }],
    ['the visit is verified', { isOtpVerified: true }],
    ['a token is held', { escrowTransactions: [{ status: 'HELD' }] }],
    ['it is not in the assigned state', { status: 'SITE_VISIT_SCHEDULED' }],
    ['nobody holds it', { assignedPartnerId: null }],
  ])('is never touched when %s', (_n, over) => expect(t.partnerResponseAction(lead({ assignedAt: ago(500), ...over }), NOW, 48)).toBe('none'));
  test('a refunded token does not protect the lead', () => {
    expect(t.partnerResponseAction(lead({ assignedAt: ago(500), escrowTransactions: [{ status: 'REFUNDED' }] }), NOW, 48)).toBe('return');
  });
});

describe('windowWarning: a partner\'s hold on the buyer is running out', () => {
  const lead = (over = {}) => ({ status: 'ASSIGNED', addedByPartnerId: 'A', createdAt: day(50), ...over });
  test('warns once, only when 15 days or fewer remain of the 60', () => {
    expect(t.windowWarning(lead({ createdAt: day(10) }), NOW, 60)).toBeNull();
    expect(t.windowWarning(lead({ createdAt: day(44) }), NOW, 60)).toBeNull();
    expect(t.windowWarning(lead({ createdAt: day(46) }), NOW, 60)).toBe(14);
    expect(t.windowWarning(lead({ createdAt: day(59) }), NOW, 60)).toBe(1);
    expect(t.windowWarning(lead({ createdAt: day(61) }), NOW, 60)).toBeNull(); // already lapsed: too late to warn
    expect(t.windowWarning(lead({ windowWarnedAt: day(1) }), NOW, 60)).toBeNull();
  });
  test('counts from the last real activity, not from creation', () => {
    expect(t.windowWarning(lead({ createdAt: day(100), siteVisitScheduledAt: day(5) }), NOW, 60)).toBeNull();
  });
  test('only for a partner\'s own registration that is still open, and only when the window is on', () => {
    expect(t.windowWarning(lead({ addedByPartnerId: null }), NOW, 60)).toBeNull();
    expect(t.windowWarning(lead({ status: 'CLOSED' }), NOW, 60)).toBeNull();
    expect(t.windowWarning(lead({ status: 'DROPPED' }), NOW, 60)).toBeNull();
    expect(t.windowWarning(lead(), NOW, 0)).toBeNull();
  });
});

describe('needsDecision: tried many times with no progress', () => {
  const lead = (over = {}) => ({ salesStage: 'CONTACTED', contactAttempts: 6, createdAt: day(20), ...over });
  test('five tries over two weeks, still open', () => {
    expect(t.needsDecision(lead(), NOW)).toBe(true);
    expect(t.needsDecision(lead({ salesStage: null }), NOW)).toBe(true);
    expect(t.needsDecision(lead({ contactAttempts: 4 }), NOW)).toBe(false);
    expect(t.needsDecision(lead({ contactAttempts: undefined }), NOW)).toBe(false);
    expect(t.needsDecision(lead({ createdAt: day(5) }), NOW)).toBe(false);
    expect(t.needsDecision(lead({ salesStage: 'QUALIFIED' }), NOW)).toBe(false);
    expect(t.needsDecision(lead({ salesStage: 'NOT_QUALIFIED' }), NOW)).toBe(false);
  });
  test('the pipeline filter asks for the same thing', () => {
    const w = salesRules.salesWhere({ decision: '1' }, 'me', NOW);
    expect(w.AND).toHaveLength(3);
    expect(w.AND[0]).toEqual({ contactAttempts: { gte: 5 } });
    expect(w.AND[1].createdAt.lt).toEqual(new Date(NOW.getTime() - 14 * 86_400_000));
    expect(salesRules.salesWhere({}, 'me', NOW)).toEqual({});
  });
});

describe('the hourly job', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getConfigNumber.mockResolvedValue(0);
    getMoneySettings.mockResolvedValue({ partnerLeadWindowDays: 60 });
    prisma.lead.findMany.mockResolvedValue([]);
    prisma.lead.update.mockResolvedValue({});
  });
  test('is registered with the other jobs', () => expect(JOB_MODULES).toContain('./leadHygiene'));
  test('with the response switch at 0 it never touches a partner\'s lead', async () => {
    const out = await job.runOnce(NOW);
    expect(out.returned).toBe(0);
    expect(prisma.lead.findMany.mock.calls.every(([a]) => !(a.where.status === 'ASSIGNED' && a.where.addedByPartnerId === undefined))).toBe(true);
  });
  test('with it on: reminds, then returns, and tells the partner and the admins', async () => {
    getConfigNumber.mockResolvedValue(48);
    prisma.lead.findMany.mockImplementation(async ({ where }) => (where.status === 'ASSIGNED' ? [
      { id: 'a', refCode: 'RD-L-A', status: 'ASSIGNED', assignedPartnerId: 'P1', assignedAt: ago(30), createdAt: ago(40), escrowTransactions: [] },
      { id: 'b', refCode: 'RD-L-B', status: 'ASSIGNED', assignedPartnerId: 'P2', assignedAt: ago(60), createdAt: ago(70), escrowTransactions: [] },
      { id: 'c', refCode: 'RD-L-C', status: 'ASSIGNED', assignedPartnerId: 'P3', assignedAt: ago(5), createdAt: ago(7), escrowTransactions: [] },
    ] : []));
    const out = await job.runOnce(NOW);
    expect(out).toMatchObject({ reminded: 1, returned: 1 });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'a' }, data: { responseReminderAt: NOW } });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'b' }, data: { assignedPartnerId: null, status: 'UNASSIGNED', assignedAt: null, responseReminderAt: null } });
    expect(createNotification.mock.calls.map((c) => c[0].userId).sort()).toEqual(['P1', 'P2']);
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });
  test('warns a partner whose hold is running out, once', async () => {
    prisma.lead.findMany.mockImplementation(async ({ where }) => (where.addedByPartnerId || where.OR ? [
      { id: 'w1', refCode: 'RD-L-W', buyerName: 'Asha', status: 'ASSIGNED', addedByPartnerId: 'A', createdAt: day(57), escrowTransactions: [] },
      { id: 'w2', status: 'ASSIGNED', addedByPartnerId: 'A', createdAt: day(5), escrowTransactions: [] },
    ] : []));
    const out = await job.runOnce(NOW);
    expect(out.warned).toBe(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({ userId: 'A', title: 'Your hold on a buyer is running out' });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { windowWarnedAt: NOW } });
    expect(prisma.lead.findMany.mock.calls.at(-1)[0].where.windowWarnedAt).toEqual({ isSet: false }); // already-warned ones are not read again
  });
  test('the hold warning is off when the window is 0', async () => {
    getMoneySettings.mockResolvedValue({ partnerLeadWindowDays: 0 });
    await job.runOnce(NOW);
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });
});
