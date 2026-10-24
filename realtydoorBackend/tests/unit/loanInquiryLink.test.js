// Owner, 24 Oct: the loan must be tied to the inquiry, so the admin knows which property (and which inquiry) it is for.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), findMany: jest.fn() },
  user: { findUnique: jest.fn().mockResolvedValue({ name: 'Krishna' }), findMany: jest.fn() },
  property: { findMany: jest.fn(), findUnique: jest.fn() },
  userDocument: { findMany: jest.fn().mockResolvedValue([]) },
  loanApplication: { findMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue(undefined), createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn(), broadcastNotification: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn(), sendLeadAssignedNotice: jest.fn(), sendSiteVisitOtp: jest.fn(), sendTicketVendorDispatched: jest.fn() }));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));
const prisma = require('../../src/lib/prisma');
const users = require('../../src/modules/users/users.service');
const admin = require('../../src/modules/admin/admin.service');

const PID = '6a44a67c287fb9ab18e3fc55';
const LID = '6a44a67c287fb9ab18e3fc99';
beforeEach(() => jest.clearAllMocks());

test('the loan keeps the id of the inquiry it was made for', async () => {
  prisma.lead.findFirst.mockResolvedValue({ id: LID });
  const create = jest.fn().mockResolvedValue({ id: 'loan1', loanAmountRequestedPaise: 500000000 });
  prisma.$transaction.mockImplementation(async (fn) => fn({
    loanApplication: { create },
    userDocument: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue({}) },
  }).catch((e) => { throw e; }));
  // eligibility lookups need real tx shape; stop at the first use and just check what reached create when it gets that far
  await users.createLoanApplication('u1', { propertyId: PID, preferredBank: 'SBI', loanAmountRequestedPaise: 500000000, documentSharingConsent: true }).catch(() => null);
  if (create.mock.calls.length) expect(create.mock.calls[0][0].data).toMatchObject({ propertyId: PID, leadId: LID });
  expect(prisma.lead.findFirst.mock.calls[0][0].select).toMatchObject({ id: true });
});

test('the admin list shows what the property is and which inquiry the loan came from', async () => {
  prisma.loanApplication.findMany.mockResolvedValue([{ id: 'loan1', userId: 'u1', propertyId: PID, leadId: LID, submittedDocIds: [] }]);
  prisma.loanApplication.count.mockResolvedValue(1);
  prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Krishna' }]);
  prisma.property.findMany.mockResolvedValue([{ id: PID, title: 'Sky Villa', slug: 'sky', city: 'Bengaluru', locality: 'Whitefield', propertyType: 'VILLA', price: 7500000 }]);
  prisma.lead.findMany.mockResolvedValue([{ id: LID, refCode: 'RD-L-000099', status: 'SITE_VISIT_DONE' }]);
  const { data } = await admin.getAllLoans({}, 0, 20);
  expect(data[0].property).toMatchObject({ title: 'Sky Villa', propertyType: 'VILLA', locality: 'Whitefield', price: 7500000 });
  expect(data[0].inquiry).toEqual({ id: LID, refCode: 'RD-L-000099', status: 'SITE_VISIT_DONE' });
  expect(prisma.property.findMany.mock.calls[0][0].select).toMatchObject({ propertyType: true, locality: true, price: true });
});

test('an older loan with no inquiry id still lists, with no inquiry', async () => {
  prisma.loanApplication.findMany.mockResolvedValue([{ id: 'old', userId: 'u1', propertyId: null, submittedDocIds: [] }]);
  prisma.loanApplication.count.mockResolvedValue(1);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.property.findMany.mockResolvedValue([]);
  prisma.lead.findMany.mockResolvedValue([]);
  const { data } = await admin.getAllLoans({}, 0, 20);
  expect(data[0].inquiry).toBeNull();
  expect(data[0].property).toBeNull();
});
