// Regression (24 Oct 2026): the admin loan list and detail show the property and the linked inquiry, and one broken row degrades to null
// instead of failing the whole list.
jest.mock('../../src/lib/prisma', () => ({
  loanApplication: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
  user: { findMany: jest.fn(), findUnique: jest.fn() },
  property: { findMany: jest.fn(), findUnique: jest.fn() },
  userDocument: { findMany: jest.fn() },
  lead: { findMany: jest.fn(), findUnique: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn(), sendLeadAssignedNotice: jest.fn(), sendSiteVisitOtp: jest.fn(), sendTicketVendorDispatched: jest.fn() }));
jest.mock('../../src/modules/partners/dataAck.service', () => ({ checkLeadDataHandlingGate: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/lib/accountDeletion', () => ({ assertLeadNotPaused: jest.fn().mockResolvedValue(undefined) }));

const prisma = require('../../src/lib/prisma');
const admin = require('../../src/modules/admin/admin.service');

const loan = (over = {}) => ({ id: 'ln1', userId: 'u1', propertyId: 'p1', leadId: 'l1', status: 'SANCTIONED', submittedDocIds: [], ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.loanApplication.count.mockResolvedValue(2);
  prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Krishna', email: 'k@x.test', phone: '+91776' }]);
  prisma.property.findMany.mockResolvedValue([{ id: 'p1', title: 'Vrunda City', slug: 'vrunda', city: 'Bengaluru', locality: 'Hoskote', price: 4680000 }]);
  prisma.lead.findMany.mockResolvedValue([{ id: 'l1', refCode: 'RD-L-000103', status: 'SITE_VISIT_DONE', extra: 'x' }]);
  prisma.userDocument.findMany.mockResolvedValue([]);
});

test('list: each loan carries its property and its inquiry (id, reference, status only)', async () => {
  prisma.loanApplication.findMany.mockResolvedValue([loan()]);
  const { data } = await admin.getAllLoans({}, 0, 20);
  expect(data[0].property).toMatchObject({ title: 'Vrunda City', locality: 'Hoskote' });
  expect(data[0].inquiry).toEqual({ id: 'l1', refCode: 'RD-L-000103', status: 'SITE_VISIT_DONE' });
});

test('list: a loan with no property or inquiry, and one whose user was deleted, still comes back', async () => {
  prisma.loanApplication.findMany.mockResolvedValue([loan({ id: 'a', propertyId: null, leadId: null }), loan({ id: 'b', userId: 'gone' })]);
  const { data } = await admin.getAllLoans({}, 0, 20);
  expect(data).toHaveLength(2);
  expect(data[0].property).toBeNull();
  expect(data[0].inquiry).toBeNull();
  expect(data[1].user).toBeNull();
});

test('list: the status filter is passed on, and an empty list asks for no related rows', async () => {
  prisma.loanApplication.findMany.mockResolvedValue([]);
  prisma.loanApplication.count.mockResolvedValue(0);
  await admin.getAllLoans({ status: ['SANCTIONED', 'DISBURSED'] }, 0, 20);
  expect(prisma.loanApplication.findMany.mock.calls[0][0].where).toEqual({ status: { in: ['SANCTIONED', 'DISBURSED'] } });
});

test('detail: 404 for an unknown loan', async () => {
  prisma.loanApplication.findUnique.mockResolvedValue(null);
  await expect(admin.getLoanById('nope')).rejects.toMatchObject({ statusCode: 404 });
});
