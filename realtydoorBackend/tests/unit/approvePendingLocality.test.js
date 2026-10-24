// A listing in a locality a partner just added (no details yet) must not go live until the admin has filled it in or corrected it.
jest.mock('../../src/lib/prisma', () => ({
  property: { findUnique: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn() },
  localitySuggestion: { findFirst: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn(),
}));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn(), sendLeadAssignedNotice: jest.fn(), sendSiteVisitOtp: jest.fn(), sendTicketVendorDispatched: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const admin = require('../../src/modules/admin/admin.service');

const listing = { id: 'p1', partnerId: 'u1', title: 'Villa', slug: 'villa', city: 'Bengaluru', locality: 'Kabban Park', images: ['a.jpg'], publishStatus: 'PENDING' };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.property.findUnique.mockResolvedValue(listing);
  prisma.user.findUnique.mockResolvedValue({ email: 'p@x.com', notifEmail: false });
  prisma.property.update.mockResolvedValue({ ...listing, publishStatus: 'APPROVED', isSearchable: true, isFeatured: false });
});

test('approval is refused while the locality is still pending, and says where to fix it', async () => {
  prisma.localitySuggestion.findFirst.mockResolvedValue({ id: 's1', city: 'Bengaluru', locality: 'Kabban Park' });
  await expect(admin.approveProperty('p1', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 409, data: { code: 'LOCALITY_NOT_SET_UP', locality: 'Kabban Park' } });
  expect(prisma.localitySuggestion.findFirst.mock.calls[0][0].where).toMatchObject({ status: 'PENDING', key: 'bengaluru|kabban park' });
  expect(prisma.property.update).not.toHaveBeenCalled();
});

test('once the locality is filled in or corrected, the same listing approves', async () => {
  prisma.localitySuggestion.findFirst.mockResolvedValue(null);
  await expect(admin.approveProperty('p1', 'a1', '1.1.1.1')).resolves.toMatchObject({ publishStatus: 'APPROVED' });
});
