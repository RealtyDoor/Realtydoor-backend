// The buyer asks not to be contacted, a partner contests a credit, and a property that stops being available.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  property: { findUnique: jest.fn(), update: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn(), notifyAdmins: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn(), sendSiteVisitOtp: jest.fn(), sendLeadAssignedNotice: jest.fn().mockResolvedValue(undefined), sendTicketVendorDispatched: jest.fn() }));
jest.mock('../../src/modules/partners/dataAck.service', () => ({ checkLeadDataHandlingGate: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/lib/accountDeletion', () => ({ assertLeadNotPaused: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ partnerLeadWindowDays: 60 }) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(5) }));

const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const { createNotification, notifyAdmins } = require('../../src/lib/notifications');
const { notifyOpenLeadsPropertyUnavailable } = require('../../src/lib/propertyUnavailable');
const admin = require('../../src/modules/admin/admin.service');
const leads = require('../../src/modules/leads/leads.service');
const { contestCreditSchema } = require('../../src/modules/leads/leads.validator');

beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockResolvedValue({}); });

describe('do not contact', () => {
  test('applies to every lead on the buyer\'s number, and is recorded', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', buyerPhone: '+919000000001', refCode: 'RD-L-1' });
    prisma.lead.updateMany.mockResolvedValue({ count: 3 });
    const out = await admin.setDoNotContact('l1', true, 'admin1', 'ip');
    expect(out).toEqual({ doNotContact: true, leadsChanged: 3 });
    const call = prisma.lead.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ buyerPhone: '+919000000001' });
    expect(call.data.doNotContactAt).toBeInstanceOf(Date);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEAD_DO_NOT_CONTACT_SET' }));
  });
  test('can be undone, and a lead with no phone only affects itself', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', buyerPhone: '' });
    prisma.lead.updateMany.mockResolvedValue({ count: 1 });
    await admin.setDoNotContact('l1', false, 'admin1', 'ip');
    expect(prisma.lead.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'l1' }, data: { doNotContactAt: null } });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEAD_DO_NOT_CONTACT_CLEARED' }));
    prisma.lead.findUnique.mockResolvedValue(null);
    await expect(admin.setDoNotContact('zz', true, 'a', 'ip')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('a partner can neither book a visit nor verify the OTP (which reveals the number) on such a lead', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1', status: 'ASSIGNED', assignedPartnerId: 'P1', doNotContactAt: new Date(), siteVisitOTP: '1234' });
    await expect(leads.scheduleVisit('l1', 'P1', new Date(Date.now() + 86_400_000))).rejects.toMatchObject({ statusCode: 409, data: { code: 'DO_NOT_CONTACT' } });
    await expect(leads.verifyOtp('l1', 'P1', '1234', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'DO_NOT_CONTACT' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});

describe('a partner contests a credit', () => {
  const lead = (over = {}) => ({ id: 'l1', refCode: 'RD-L-1', buyerName: 'Asha', status: 'UNASSIGNED', addedByPartnerId: 'P1', ...over });
  test('asks the admin, once, and only for a lead the partner brought that is in the pool', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead());
    await expect(leads.contestCredit('l1', 'P1', 'I met the buyer at the site on 2 Nov')).resolves.toMatchObject({ message: expect.stringMatching(/review/) });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'l1', addedByPartnerId: 'P1' });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ creditContestNote: 'I met the buyer at the site on 2 Nov' });
    expect(notifyAdmins.mock.calls[0][0].message).toContain('I met the buyer');
    prisma.lead.findFirst.mockResolvedValue(lead({ creditContestedAt: new Date() }));
    await expect(leads.contestCredit('l1', 'P1', 'again please')).rejects.toMatchObject({ data: { code: 'ALREADY_CONTESTED' } });
    prisma.lead.findFirst.mockResolvedValue(lead({ status: 'ASSIGNED' }));
    await expect(leads.contestCredit('l1', 'P1', 'this is mine')).rejects.toMatchObject({ data: { code: 'NOT_IN_POOL' } });
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(leads.contestCredit('l1', 'P2', 'not mine at all')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('the note is required and short', () => {
    expect(() => contestCreditSchema.parse({ note: 'no' })).toThrow();
    expect(() => contestCreditSchema.parse({ note: 'x'.repeat(501) })).toThrow();
    expect(contestCreditSchema.parse({ note: '  I met them  ' }).note).toBe('I met them');
  });
  test('assigning the lead to anyone settles the contest', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', refCode: 'RD-L-1', status: 'UNASSIGNED', assignedPartnerId: null, creditContestedAt: new Date(), property: { title: 'V', partnerId: 'X' }, escrowTransactions: [] });
    prisma.user.findFirst.mockResolvedValue({ id: 'P1', name: 'Ravi', email: 'r@x.in' });
    prisma.lead.update.mockImplementation(async ({ data }) => ({ id: 'l1', ...data }));
    await admin.assignLead('l1', 'P1', 'admin1', 'ip');
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ assignedPartnerId: 'P1', creditContestedAt: null });
  });
});

describe('a property stops being available while leads on it are open', () => {
  test('the partner, the linked buyer and the admins are told; nothing is dropped', async () => {
    prisma.lead.findMany.mockResolvedValue([
      { id: 'a', refCode: 'RD-L-A', status: 'ASSIGNED', buyerId: 'B1', assignedPartnerId: 'P1' },
      { id: 'b', refCode: 'RD-L-B', status: 'UNASSIGNED', buyerId: null, assignedPartnerId: null },
    ]);
    expect(await notifyOpenLeadsPropertyUnavailable({ id: 'prop1', title: 'Green Villa' }, 'sold')).toBe(2);
    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({ propertyId: 'prop1', status: { notIn: ['CLOSED', 'DROPPED'] } });
    expect(createNotification.mock.calls.map((c) => c[0].userId).sort()).toEqual(['B1', 'P1']);
    expect(notifyAdmins.mock.calls[0][0].message).toContain('RD-L-A, RD-L-B');
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('no open leads, nobody is bothered; a failure never breaks the caller', async () => {
    prisma.lead.findMany.mockResolvedValue([]);
    expect(await notifyOpenLeadsPropertyUnavailable({ id: 'p', title: 'X' }, 'sold')).toBe(0);
    expect(notifyAdmins).not.toHaveBeenCalled();
    prisma.lead.findMany.mockRejectedValue(new Error('db down'));
    expect(await notifyOpenLeadsPropertyUnavailable({ id: 'p', title: 'X' }, 'sold')).toBe(0);
  });
  test('rejecting a live listing triggers it; rejecting one that was never live does not', async () => {
    prisma.lead.findMany.mockResolvedValue([{ id: 'a', refCode: 'RD-L-A', status: 'ASSIGNED', buyerId: null, assignedPartnerId: 'P1' }]);
    prisma.property.findUnique.mockResolvedValue({ id: 'prop1', title: 'Green Villa', partnerId: 'P9', publishStatus: 'APPROVED', city: 'B', locality: 'L', partner: null });
    prisma.property.update.mockResolvedValue({ id: 'prop1' });
    await admin.rejectProperty('prop1', 'Papers do not match', 'admin1', 'ip');
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    notifyAdmins.mockClear();
    prisma.property.findUnique.mockResolvedValue({ id: 'prop2', title: 'New', partnerId: 'P9', publishStatus: 'PENDING_APPROVAL', city: 'B', locality: 'L', partner: null });
    await admin.rejectProperty('prop2', 'Papers do not match', 'admin1', 'ip');
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});
