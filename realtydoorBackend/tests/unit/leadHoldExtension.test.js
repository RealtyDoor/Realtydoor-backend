// A partner holds a registered buyer for 30 days. In the last 5 they are reminded, and may ask admin ONCE for up to 10 more days.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  user: { findFirst: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn(), notifyAdmins: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn() }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ partnerLeadWindowDays: 30, partnerLeadProofHours: 0 }) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(0) }));
jest.mock('../../src/lib/wati', () => new Proxy({}, { get: () => jest.fn() }));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/lib/refCode', () => ({ nextRefCode: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { createNotification, notifyAdmins } = require('../../src/lib/notifications');
const { createAuditLog } = require('../../src/lib/auditLog');
const t = require('../../src/lib/leadTimers');
const { decideBuyerOwnership } = require('../../src/lib/leadOwnership');
const leads = require('../../src/modules/leads/leads.service');
const job = require('../../src/jobs/leadHygiene');
const { requestHoldExtensionSchema } = require('../../src/modules/leads/leads.validator');
const salesRules = require('../../src/lib/leadSales');

const NOW = new Date('2026-11-04T10:00:00Z');
const day = (n) => new Date(NOW.getTime() - n * 86_400_000);
const lead = (over = {}) => ({ id: 'l1', refCode: 'RD-L-1', buyerName: 'Meena', status: 'ASSIGNED', addedByPartnerId: 'A', createdAt: day(26), escrowTransactions: [], ...over });

describe('the hold, with and without an extension', () => {
  test('an approved extension adds the days, at most 10', () => {
    expect(t.holdWindowDays(lead(), 30)).toBe(30);
    expect(t.holdWindowDays(lead({ holdExtensionApproved: true, holdExtensionDays: 10 }), 30)).toBe(40);
    expect(t.holdWindowDays(lead({ holdExtensionApproved: true, holdExtensionDays: 90 }), 30)).toBe(40); // never more than 10
    expect(t.holdWindowDays(lead({ holdExtensionApproved: true, holdExtensionDays: -5 }), 30)).toBe(30);
    expect(t.holdWindowDays(lead({ holdExtensionApproved: false, holdExtensionDays: 10 }), 30)).toBe(30); // declined adds nothing
  });
  test('the buyer stays the partner\'s through the extra days, then is free', () => {
    const base = { holdExtensionApproved: true, holdExtensionDays: 10, addedByPartnerId: 'A' };
    expect(decideBuyerOwnership({ priorLeads: [{ id: 'r', ...base, createdAt: day(38) }], partnerId: 'B', windowDays: 30, asOf: NOW }).reason).toBe('OTHER_PARTNER');
    expect(decideBuyerOwnership({ priorLeads: [{ id: 'r', ...base, createdAt: day(41) }], partnerId: 'B', windowDays: 30, asOf: NOW }).reason).toBe('NEW_BUYER');
    expect(decideBuyerOwnership({ priorLeads: [{ id: 'r', addedByPartnerId: 'A', createdAt: day(31) }], partnerId: 'B', windowDays: 30, asOf: NOW }).reason).toBe('NEW_BUYER');
  });
});

describe('holdInfo (what the partner sees)', () => {
  test('long before the end: nothing to ask yet', () => {
    const h = t.holdInfo(lead({ createdAt: day(5) }), NOW, 30);
    expect(h).toMatchObject({ state: 'NONE', canRequest: false, daysLeft: 25, extensionDays: 10 });
  });
  test('in the last 5 days you can ask, once', () => {
    expect(t.holdInfo(lead({ createdAt: day(26) }), NOW, 30)).toMatchObject({ canRequest: true, daysLeft: 4 });
    expect(t.holdInfo(lead({ createdAt: day(25) }), NOW, 30).canRequest).toBe(true);
    expect(t.holdInfo(lead({ createdAt: day(24) }), NOW, 30).canRequest).toBe(false); // 6 days left
  });
  test('not once it has ended, or the lead is closed, dropped or lapsed', () => {
    expect(t.holdInfo(lead({ createdAt: day(31) }), NOW, 30).canRequest).toBe(false);
    for (const status of ['CLOSED', 'DROPPED']) expect(t.holdInfo(lead({ status }), NOW, 30).canRequest).toBe(false);
    expect(t.holdInfo(lead({ registrationLapsedAt: day(1) }), NOW, 30).canRequest).toBe(false);
    expect(t.holdInfo(lead(), NOW, 0).canRequest).toBe(false); // holds switched off
  });
  test('the state follows the request: waiting, approved, declined; and it cannot be asked again', () => {
    const asked = { holdExtensionRequestedAt: day(1) };
    expect(t.holdInfo(lead(asked), NOW, 30)).toMatchObject({ state: 'REQUESTED', canRequest: false });
    expect(t.holdInfo(lead({ ...asked, holdExtensionDecidedAt: day(0), holdExtensionApproved: true, holdExtensionDays: 10 }), NOW, 30)).toMatchObject({ state: 'APPROVED', canRequest: false, daysLeft: 14 });
    expect(t.holdInfo(lead({ ...asked, holdExtensionDecidedAt: day(0), holdExtensionApproved: false }), NOW, 30)).toMatchObject({ state: 'DECLINED', canRequest: false });
  });
  test('activity on the buyer pushes the end out, as before', () => {
    expect(t.holdInfo(lead({ createdAt: day(26), siteVisitScheduledAt: day(2) }), NOW, 30)).toMatchObject({ daysLeft: 28, canRequest: false });
  });
});

describe('requestHoldExtension', () => {
  beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockResolvedValue({}); });
  test('in the last days: records it, tells admin, once', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ createdAt: day(26) }));
    const out = await leads.requestHoldExtension('l1', 'A', 'Buyer travelling, back next week');
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'l1', OR: [{ addedByPartnerId: 'A' }, { assignedPartnerId: 'A', addedByPartnerId: { isSet: false } }] });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { holdExtensionRequestedAt: expect.any(Date), holdExtensionNote: 'Buyer travelling, back next week' } });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ linkUrl: '/admin/leads/l1', message: expect.stringContaining('10 more days') }));
    expect(out.message).toMatch(/10 more days/);
  });
  test('too early is refused', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ createdAt: day(10) }));
    await expect(leads.requestHoldExtension('l1', 'A', 'need time')).rejects.toMatchObject({ statusCode: 400, data: { code: 'EXTENSION_NOT_AVAILABLE' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('a second request is refused, even after a decline', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ createdAt: day(26), holdExtensionRequestedAt: day(1), holdExtensionDecidedAt: day(0), holdExtensionApproved: false }));
    await expect(leads.requestHoldExtension('l1', 'A', 'please')).rejects.toMatchObject({ statusCode: 409, data: { code: 'EXTENSION_ALREADY_ASKED' } });
  });
  test('only the partner who registered the buyer can ask', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(leads.requestHoldExtension('l1', 'B', 'please')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('the reason is needed: 5 to 500 characters', () => {
    expect(requestHoldExtensionSchema.safeParse({ note: 'no' }).success).toBe(false);
    expect(requestHoldExtensionSchema.safeParse({ note: 'Buyer is abroad until Monday' }).success).toBe(true);
    expect(requestHoldExtensionSchema.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
    expect(requestHoldExtensionSchema.safeParse({}).success).toBe(false);
  });
});

describe('admin decides', () => {
  beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockResolvedValue({}); });
  const pending = () => lead({ holdExtensionRequestedAt: day(1) });
  test('approve: 10 days are added, the partner is told, it is recorded', async () => {
    prisma.lead.findUnique.mockResolvedValue(pending());
    expect(await leads.adminDecideHoldExtension('l1', true, 'adm', 'ip')).toEqual({ approved: true });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { holdExtensionDecidedAt: expect.any(Date), holdExtensionApproved: true, holdExtensionDays: 10 } });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'A', title: 'More time approved' }));
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'HOLD_EXTENSION_APPROVED' }));
  });
  test('decline: nothing is added', async () => {
    prisma.lead.findUnique.mockResolvedValue(pending());
    await leads.adminDecideHoldExtension('l1', false, 'adm', 'ip');
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { holdExtensionDecidedAt: expect.any(Date), holdExtensionApproved: false } });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'More time declined' }));
  });
  test('nothing to decide, or already decided, is refused', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await expect(leads.adminDecideHoldExtension('l1', true, 'adm', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    prisma.lead.findUnique.mockResolvedValue(lead({ holdExtensionRequestedAt: day(2), holdExtensionDecidedAt: day(1), holdExtensionApproved: true }));
    await expect(leads.adminDecideHoldExtension('l1', false, 'adm', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    prisma.lead.findUnique.mockResolvedValue(null);
    await expect(leads.adminDecideHoldExtension('nope', true, 'adm', 'ip')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('the admin list can show only the pending requests', () => {
    expect(salesRules.salesWhere({ holdExtension: '1' }, 'me', NOW)).toEqual({ AND: [{ holdExtensionRequestedAt: { isSet: true } }, { holdExtensionDecidedAt: { isSet: false } }] });
    expect(salesRules.salesWhere({ holdExtension: '0' }, 'me', NOW)).toEqual({});
  });
});

describe('the reminder', () => {
  beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockResolvedValue({}); });
  const run = async (row) => {
    prisma.lead.findMany.mockImplementation(async ({ where }) => (where.windowWarnedAt ? [row] : []));
    return job.runOnce(NOW);
  };
  test('in the last 5 days: one reminder that says they can ask for 10 more days', async () => {
    const out = await run(lead({ createdAt: day(26) }));
    expect(out.warned).toBe(1);
    expect(createNotification.mock.calls[0][0].message).toMatch(/up to 10 more days, once/);
  });
  test('not before then', async () => {
    expect((await run(lead({ createdAt: day(20) }))).warned).toBe(0);
  });
  test('if they already asked, the reminder does not offer it again', async () => {
    await run(lead({ createdAt: day(26), holdExtensionRequestedAt: day(1) }));
    expect(createNotification.mock.calls[0][0].message).not.toMatch(/more days, once/);
  });
  test('an approved extension moves the reminder out by 10 days', async () => {
    expect((await run(lead({ createdAt: day(26), holdExtensionApproved: true, holdExtensionDays: 10, holdExtensionRequestedAt: day(2), holdExtensionDecidedAt: day(1) }))).warned).toBe(0);
  });
});

describe('the partner\'s lead list carries the hold', () => {
  const { getMoneySettings } = require('../../src/modules/money/moneyConfig');
  const row = (over = {}) => ({ id: 'l1', refCode: 'RD-L-1', status: 'ASSIGNED', buyerName: 'Meena', buyerPhone: '+919000000001', buyerEmail: '', assignedPartnerId: 'A', addedByPartnerId: 'A', createdAt: day(26), isOtpVerified: false, escrowTransactions: [], property: { title: 'X' }, buyer: null, ...over });
  beforeEach(() => { jest.clearAllMocks(); getMoneySettings.mockResolvedValue({ partnerLeadWindowDays: 30, partnerLeadProofHours: 0 }); });
  test('for a buyer the partner registered, with the end date and whether they can ask; a company-given lead shows it too; nothing for a lead someone else brought', async () => {
    prisma.lead.findMany.mockResolvedValue([row(), row({ id: 'l2', addedByPartnerId: null }), row({ id: 'l3', addedByPartnerId: 'Z' })]);
    const out = await leads.getPartnerLeads('A');
    expect(out[0].hold).toMatchObject({ state: 'NONE', canRequest: true, extensionDays: 10 });
    expect(out[1].hold).toMatchObject({ state: 'NONE', canRequest: true });
    expect(out[2].hold).toBeUndefined();
  });
  test('if the settings cannot be read the partner still gets their leads, just without the hold', async () => {
    getMoneySettings.mockRejectedValue(new Error('config down'));
    prisma.lead.findMany.mockResolvedValue([row()]);
    const out = await leads.getPartnerLeads('A');
    expect(out).toHaveLength(1);
    expect(out[0].hold.canRequest).toBe(false);
  });
});
