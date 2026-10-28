// 29 Oct 2026: found live: the buyer's "Email alerts" switch was ignored for the ticket reply email, because the caller did not pass the buyer's
// preferences to the email function (no user in scope means no switch to respect). Turning email off must stop the email.
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'm1', accepted: ['a@b.c'] });
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: (...a) => mockSendMail(...a) }) }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/prisma', () => ({
  serviceTicket: { findUnique: jest.fn() },
  ticketComment: { create: jest.fn() },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn(), sendLeadAssignedNotice: jest.fn(), sendSiteVisitOtp: jest.fn(), sendTicketVendorDispatched: jest.fn() }));
jest.mock('../../src/modules/partners/dataAck.service', () => ({ checkLeadDataHandlingGate: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/lib/accountDeletion', () => ({ assertLeadNotPaused: jest.fn().mockResolvedValue(undefined) }));

const prisma = require('../../src/lib/prisma');
const admin = require('../../src/modules/admin/admin.service');
const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  jest.clearAllMocks();
  prisma.serviceTicket.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', subject: 'Tap leak' });
  prisma.ticketComment.create.mockResolvedValue({ id: 'c1' });
});

test('email alerts off: the ticket reply email is not sent', async () => {
  prisma.user.findUnique.mockResolvedValue({ email: 'k@x.test', notifEmail: false, notifWhatsapp: true, marketingOptIn: false });
  await admin.addAdminTicketComment('t1', 'a1', { text: 'Hello' }, '1.1.1.1');
  await flush();
  expect(mockSendMail).not.toHaveBeenCalled();
});

test('email alerts on (or never set): the email is sent', async () => {
  prisma.user.findUnique.mockResolvedValue({ email: 'k@x.test', notifEmail: true, notifWhatsapp: true, marketingOptIn: false });
  await admin.addAdminTicketComment('t1', 'a1', { text: 'Hello' }, '1.1.1.1');
  await flush();
  expect(mockSendMail).toHaveBeenCalledTimes(1);
  expect(mockSendMail.mock.calls[0][0].to).toBe('k@x.test');
});

test('the buyer lookup asks for the preference fields', async () => {
  prisma.user.findUnique.mockResolvedValue({ email: 'k@x.test', notifEmail: true });
  await admin.addAdminTicketComment('t1', 'a1', { text: 'Hello' }, '1.1.1.1');
  await flush();
  const select = prisma.user.findUnique.mock.calls[0][0].select;
  expect(select).toMatchObject({ email: true, notifEmail: true, notifWhatsapp: true, marketingOptIn: true });
});
