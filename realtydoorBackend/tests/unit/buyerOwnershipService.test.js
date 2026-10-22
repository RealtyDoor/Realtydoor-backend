jest.mock('../../src/lib/prisma', () => ({
  lead: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  property: { findFirst: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/refCode', () => ({ nextRefCode: jest.fn().mockResolvedValue('RD-L-000001') }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ partnerLeadWindowDays: 60 }) }));

const prisma = require('../../src/lib/prisma');
const { createNotification } = require('../../src/lib/notifications');
const leads = require('../../src/modules/leads/leads.service');

const PHONE = '+919000000099';
const data = { buyerName: 'Asha', buyerPhone: PHONE, propertyId: 'prop1', consent: true };
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.property.findFirst.mockResolvedValue({ id: 'prop1', title: 'Green Villa' });
  prisma.lead.findFirst.mockResolvedValue(null); // no active duplicate, no earlier lead
  prisma.lead.findMany.mockResolvedValue([]);
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([{ id: 'admin1' }]);
  prisma.lead.create.mockImplementation(async ({ data: d }) => ({ id: 'l1', ...d }));
});

describe('partnerAddLead: one mobile number is one buyer', () => {
  test('a new number is credited and the admin is told so', async () => {
    const out = await leads.partnerAddLead('A', data);
    expect(out.ownership).toMatchObject({ credited: true, reason: 'NEW_BUYER' });
    expect(createNotification.mock.calls[0][0].message).toContain('New buyer, credited to the partner.');
  });

  test('a number that already has a registered buyer account is ours and not credited', async () => {
    prisma.user.findFirst.mockResolvedValue({ createdAt: daysAgo(400) });
    const out = await leads.partnerAddLead('A', data);
    expect(out.ownership).toMatchObject({ credited: false, reason: 'EXISTING_BUYER' });
    expect(createNotification.mock.calls[0][0].message).toContain('counted as our lead');
  });

  test('another partner holding a valid registration is reported, and the lead is still recorded for the admin', async () => {
    prisma.lead.findMany.mockResolvedValue([{ id: 'old', addedByPartnerId: 'B', createdAt: daysAgo(10) }]);
    const out = await leads.partnerAddLead('A', data);
    expect(out.ownership).toMatchObject({ credited: false, reason: 'OTHER_PARTNER', holderPartnerId: 'B' });
    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
  });

  test('the same partner coming back for another project is still credited', async () => {
    prisma.lead.findMany.mockResolvedValue([{ id: 'old', addedByPartnerId: 'A', createdAt: daysAgo(30), status: 'DROPPED' }]);
    const out = await leads.partnerAddLead('A', data);
    expect(out.ownership).toMatchObject({ credited: true, reason: 'OWN_REGISTRATION' });
  });

  test('the Confirm step re-checks only what existed before the lead', async () => {
    await leads.evaluateBuyerOwnership(PHONE, 'A', { excludeLeadId: 'l9', before: daysAgo(1) });
    const where = prisma.lead.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ buyerPhone: PHONE, id: { not: 'l9' }, createdAt: { lt: expect.any(Date) } });
  });
});
