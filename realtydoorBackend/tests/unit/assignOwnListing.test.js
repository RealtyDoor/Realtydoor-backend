// BUG-039: assigning a lead to the partner who owns the listing used to work, then the commission lock failed at release time.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), update: jest.fn() },
  user: { findFirst: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn(), sendLeadAssignedNotice: jest.fn().mockResolvedValue(undefined), sendSiteVisitOtp: jest.fn(), sendTicketVendorDispatched: jest.fn() }));
jest.mock('../../src/modules/partners/dataAck.service', () => ({ checkLeadDataHandlingGate: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/lib/accountDeletion', () => ({ assertLeadNotPaused: jest.fn().mockResolvedValue(undefined) }));

const prisma = require('../../src/lib/prisma');
const admin = require('../../src/modules/admin/admin.service');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findFirst.mockResolvedValue({ id: 'p1', name: 'Dev One', phone: '+919000000001' });
});

test('refuses the partner who owns the listing, before anything is written', async () => {
  prisma.lead.findUnique.mockResolvedValue({ id: 'l1', status: 'UNASSIGNED', assignedPartnerId: null, property: { title: 'Villa', partnerId: 'p1' } });
  await expect(admin.assignLead('l1', 'p1', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 400, data: { code: 'PARTNER_OWNS_LISTING' } });
  expect(prisma.lead.update).not.toHaveBeenCalled();
});

test('a different partner is fine', async () => {
  prisma.lead.findUnique.mockResolvedValue({ id: 'l1', status: 'UNASSIGNED', assignedPartnerId: null, refCode: 'RD-L-1', buyerName: 'Asha', buyerPhone: '+919000000009', property: { title: 'Villa', partnerId: 'someone-else' } });
  prisma.lead.update.mockResolvedValue({ id: 'l1', status: 'ASSIGNED' });
  await expect(admin.assignLead('l1', 'p1', 'a1', '1.1.1.1')).resolves.toBeTruthy();
});
