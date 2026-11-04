// Automatic assignment: only the company's campaign leads, never a partner's own, in rotation.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), update: jest.fn() },
  user: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  routingRule: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ partnerLeadWindowDays: 60 }) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(5) }));
jest.mock('../../src/lib/wati', () => new Proxy({}, { get: () => jest.fn() }));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));

const prisma = require('../../src/lib/prisma');
const admin = require('../../src/modules/admin/admin.service');

const base = { id: 'l1', status: 'UNASSIGNED', assignedPartnerId: null, property: { city: 'Bengaluru', locality: 'Whitefield', propertyType: 'APARTMENT' } };
beforeEach(() => { jest.clearAllMocks(); });

describe('autoAssignLead refuses what must not be auto-assigned', () => {
  test('a lead a partner added', async () => {
    prisma.lead.findUnique.mockResolvedValue({ ...base, addedByPartnerId: 'p9', source: 'PARTNER', campaign: 'Diwali' });
    await expect(admin.autoAssignLead('l1', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'PARTNER_LEAD' } });
  });
  test('a lead marked as from a partner even without an adder', async () => {
    prisma.lead.findUnique.mockResolvedValue({ ...base, source: 'PARTNER' });
    await expect(admin.autoAssignLead('l1', 'adm', 'ip')).rejects.toMatchObject({ data: { code: 'PARTNER_LEAD' } });
  });
  test('a website inquiry (no campaign)', async () => {
    prisma.lead.findUnique.mockResolvedValue({ ...base, source: 'WEBSITE' });
    await expect(admin.autoAssignLead('l1', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'NOT_CAMPAIGN_LEAD' } });
  });
  test('a lead with a blank campaign', async () => {
    prisma.lead.findUnique.mockResolvedValue({ ...base, source: 'PHONE', campaign: '  ' });
    await expect(admin.autoAssignLead('l1', 'adm', 'ip')).rejects.toMatchObject({ data: { code: 'NOT_CAMPAIGN_LEAD' } });
  });
  test('a lead that already has a partner, or is closed', async () => {
    prisma.lead.findUnique.mockResolvedValue({ ...base, campaign: 'Diwali', assignedPartnerId: 'p1' });
    await expect(admin.autoAssignLead('l1', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 409 });
    prisma.lead.findUnique.mockResolvedValue({ ...base, campaign: 'Diwali', status: 'CLOSED' });
    await expect(admin.autoAssignLead('l1', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('a campaign lead with no eligible partner says so', async () => {
    prisma.lead.findUnique.mockResolvedValue({ ...base, source: 'PHONE', campaign: 'Diwali' });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(admin.autoAssignLead('l1', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('autoAssignUnassignedLeads only looks at campaign leads nobody holds', () => {
  test('the batch query excludes partner-brought leads and anything without a campaign', async () => {
    prisma.lead.findMany.mockResolvedValue([]);
    const out = await admin.autoAssignUnassignedLeads({}, 'adm', 'ip');
    expect(out).toMatchObject({ totalConsidered: 0, assignedCount: 0 });
    expect(prisma.lead.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'UNASSIGNED', assignedPartnerId: { isSet: false }, addedByPartnerId: { isSet: false }, source: { not: 'PARTNER' }, campaign: { isSet: true },
    });
  });
});
