jest.mock('../../src/lib/prisma', () => ({
  lead: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  property: { findFirst: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn() },
  // the per-buyer-and-property lock (lib/keyLock.js)
  counter: { create: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({}), findUnique: jest.fn(), updateMany: jest.fn() },
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
    expect(out.ownership).toEqual({ credited: false, reason: 'OTHER_PARTNER' }); // never the other partner's id
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

describe('partnerAddLead does not leak other people\'s leads', () => {
  test('a duplicate that is another partner\'s lead reports the conflict without its id, reference or status', async () => {
    prisma.lead.findFirst.mockResolvedValueOnce({ id: 'other1', refCode: 'RD-L-000009', status: 'ASSIGNED', addedByPartnerId: 'B', assignedPartnerId: 'B' });
    const err = await leads.partnerAddLead('A', data).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, data: { code: 'DUPLICATE_LEAD' } });
    expect(err.data.lead).toBeUndefined();
  });

  test('a duplicate that is the partner\'s own lead still shows which lead it is', async () => {
    prisma.lead.findFirst.mockResolvedValueOnce({ id: 'mine1', refCode: 'RD-L-000010', status: 'ASSIGNED', addedByPartnerId: 'A', assignedPartnerId: 'A' });
    const err = await leads.partnerAddLead('A', data).catch((e) => e);
    expect(err.data.lead).toEqual({ id: 'mine1', refCode: 'RD-L-000010', status: 'ASSIGNED' });
  });

  test('the "related lead" is shown only when it is the partner\'s own, though the link is still saved for the admin', async () => {
    const earlier = { id: 'e1', refCode: 'RD-L-000002', addedByPartnerId: 'B', assignedPartnerId: 'B' };
    prisma.lead.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(earlier);
    const out = await leads.partnerAddLead('A', data);
    expect(out.relatedLead).toBeNull();
    expect(out.isRepeatBuyer).toBe(true);
    expect(prisma.lead.create.mock.calls[0][0].data.relatedLeadId).toBe('e1');

    prisma.lead.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...earlier, addedByPartnerId: 'A', assignedPartnerId: 'A' });
    const own = await leads.partnerAddLead('A', data);
    expect(own.relatedLead).toEqual({ id: 'e1', refCode: 'RD-L-000002' });
  });
});

describe('partnerAddLead: any live listing (28 Oct 2026, owner decision)', () => {
  test('looks the property up among all approved listings, not only the partner\'s own', async () => {
    await leads.partnerAddLead('A', data);
    const where = prisma.property.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: 'prop1', publishStatus: 'APPROVED' });
    expect(where).not.toHaveProperty('partnerId');
  });
  test('a listing that is not approved is still refused', async () => {
    prisma.property.findFirst.mockResolvedValue(null);
    const err = await leads.partnerAddLead('A', data).catch((e) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Property not found among live listings');
  });
});
