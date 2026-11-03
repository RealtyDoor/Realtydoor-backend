// A buyer who enquires on their own after a partner registered them, and the admin's confirm step around it.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), count: jest.fn(), create: jest.fn() },
  property: { findUnique: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn(), notifyAdmins: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ partnerLeadWindowDays: 60 }) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(5) }));
jest.mock('../../src/lib/refCode', () => ({ nextRefCode: jest.fn().mockResolvedValue('RD-L-000999') }));
jest.mock('../../src/lib/wati', () => ({ sendSiteVisitOtp: jest.fn() }));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));

const prisma = require('../../src/lib/prisma');
const { createNotification, notifyAdmins } = require('../../src/lib/notifications');
const { createAuditLog } = require('../../src/lib/auditLog');
const leads = require('../../src/modules/leads/leads.service');
const admin = require('../../src/modules/admin/admin.service');

const day = (n) => new Date(Date.now() - n * 86_400_000);
const BUYER = { id: 'u1', name: 'Asha', email: 'a@x.in', phone: '+919000000001', role: 'USER', phoneVerified: true };
const PROP = { id: 'prop1', title: 'Green Villa', publishStatus: 'APPROVED' };

describe('a buyer enquires on their own, after a partner registered them for the same property', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.property.findUnique.mockResolvedValue(PROP);
    prisma.lead.count.mockResolvedValue(0);
    prisma.lead.create.mockImplementation(async ({ data }) => ({ id: 'new', ...data }));
    prisma.lead.update.mockImplementation(async ({ data, where }) => ({ id: where.id, refCode: 'RD-L-000001', buyerName: 'Asha', status: 'ASSIGNED', ...data }));
    prisma.user.findMany.mockResolvedValue([{ id: 'adm' }]);
  });
  const findFirstFor = (registered) => prisma.lead.findFirst.mockImplementation(async ({ where }) => (where.addedByPartnerId ? registered : null));

  test('while the partner\'s lead waits for review: no second lead, the admin is told, the buyer is told it was received', async () => {
    findFirstFor({ id: 'p1', refCode: 'RD-L-000001', status: 'AWAITING_ADMIN', buyerName: 'Asha', buyerId: null, addedByPartnerId: 'A' });
    const out = await leads.submitLead({ propertyId: 'prop1' }, BUYER);
    expect(out).toMatchObject({ merged: true, pendingReview: true, refCode: 'RD-L-000001' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ linkUrl: '/admin/leads/p1' }));
  });

  test('once the partner\'s lead is confirmed but not yet linked to an account: the buyer\'s account is attached to it, still one lead', async () => {
    findFirstFor({ id: 'p1', refCode: 'RD-L-000001', status: 'ASSIGNED', buyerName: 'Asha', buyerPhone: '+919000000001', buyerId: null, addedByPartnerId: 'A' });
    const out = await leads.submitLead({ propertyId: 'prop1' }, BUYER);
    expect(out.merged).toBe(true);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { buyerId: 'u1' } });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  test('an enquiry nobody registered is made as before', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    const out = await leads.submitLead({ propertyId: 'prop1' }, BUYER);
    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
    expect(out.merged).toBeUndefined();
  });

  test('the check looks only for a live partner registration of this phone for this property', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await leads.submitLead({ propertyId: 'prop1' }, BUYER);
    const call = prisma.lead.findFirst.mock.calls.find(([a]) => a.where.addedByPartnerId);
    expect(call[0].where).toMatchObject({ propertyId: 'prop1', buyerPhone: '+919000000001', status: { notIn: ['CLOSED', 'DROPPED'] } });
  });
});

describe('admin confirm of a partner-added lead', () => {
  const awaiting = { id: 'l1', refCode: 'RD-L-000001', status: 'AWAITING_ADMIN', buyerName: 'Asha', buyerPhone: '+919000000001', buyerId: null, propertyId: 'prop1', addedByPartnerId: 'A', createdAt: day(2), property: { title: 'Green Villa' } };
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.lead.findUnique.mockResolvedValue(awaiting);
    prisma.lead.findMany.mockResolvedValue([]);
    prisma.lead.update.mockImplementation(async ({ data, where }) => ({ ...awaiting, id: where.id, ...data }));
    prisma.user.findFirst.mockImplementation(async ({ where }) => (where.role === 'PARTNER' ? { id: where.id } : null));
  });

  test('the buyer\'s own duplicate enquiry is dropped as a merge, with a reason code; one with a token on it is left alone', async () => {
    const dupe = { id: 'd1', refCode: 'RD-L-000002', propertyId: 'prop1', buyerPhone: '+919000000001', addedByPartnerId: null, status: 'UNASSIGNED', createdAt: day(1), escrowTransactions: [] };
    const paid = { ...dupe, id: 'd2', refCode: 'RD-L-000003', escrowTransactions: [{ id: 'e1' }] };
    prisma.lead.findMany.mockImplementation(async (a) => (a.include?.escrowTransactions ? [dupe, paid] : []));
    const out = await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    const drops = prisma.lead.update.mock.calls.filter(([a]) => a.data.status === 'DROPPED');
    expect(drops).toHaveLength(1);
    expect(drops[0][0]).toMatchObject({ where: { id: 'd1' }, data: { droppedReasonCode: 'DUPLICATE', droppedByAdminId: 'admin1' } });
    expect(drops[0][0].data.droppedReason).toContain('Merged into RD-L-000001');
    expect(out.mergedDuplicates).toEqual(['RD-L-000002']);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEAD_MERGED_DUPLICATE', targetId: 'd1' }));
  });

  test('a credited partner who is not KYC verified: the lead goes to the pool and the partner is told why, and so is the admin', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const out = await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    expect(out.status).toBe('UNASSIGNED');
    expect(out.warning).toMatch(/not KYC verified/);
    const note = createNotification.mock.calls.map((c) => c[0]).find((n) => n.userId === 'A' && /KYC/.test(n.message));
    expect(note).toMatchObject({ title: 'Lead went to the pool', linkUrl: '/partners/kyc' });
  });

  test('a normal confirm carries no warning and no merge', async () => {
    const out = await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    expect(out.warning).toBeUndefined();
    expect(out.mergedDuplicates).toBeUndefined();
  });
});

describe('getRelatedLeads: everything for the same mobile number', () => {
  test('lists the other leads and marks partner-added ones', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', buyerPhone: '+919000000001' });
    prisma.lead.findMany.mockResolvedValue([
      { id: 'a', refCode: 'RD-L-1', addedByPartner: { name: 'Ravi' }, assignedPartner: null },
      { id: 'b', refCode: 'RD-L-2', addedByPartner: null, assignedPartner: { name: 'Meera' } },
    ]);
    const out = await admin.getRelatedLeads('l1');
    expect(out.map((r) => r.kind)).toEqual(['PARTNER_ADDED', 'COMPANY']);
    expect(prisma.lead.findMany.mock.calls.at(-1)[0].where).toEqual({ buyerPhone: '+919000000001', id: { not: 'l1' } });
  });
  test('no phone, nothing to match; unknown lead is a 404', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', buyerPhone: '' });
    expect(await admin.getRelatedLeads('l1')).toEqual([]);
    prisma.lead.findUnique.mockResolvedValue(null);
    await expect(admin.getRelatedLeads('zz')).rejects.toMatchObject({ statusCode: 404 });
  });
});
