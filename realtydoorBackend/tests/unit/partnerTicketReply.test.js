jest.mock('../../src/lib/prisma', () => ({
  partnerSupportTicket: { findFirst: jest.fn(), update: jest.fn() },
  partnerSupportTicketMessage: { create: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), notifyAdmins: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { notifyAdmins } = require('../../src/lib/notifications');
const service = require('../../src/modules/partners/partners.service');
const { supportTicketReplySchema } = require('../../src/modules/partners/partners.validator');

beforeEach(() => { jest.clearAllMocks(); prisma.partnerSupportTicketMessage.create.mockResolvedValue({ id: 'm1' }); });

describe('partner follow-up on a support ticket (B73)', () => {
  test('is saved on the conversation and tells the admins', async () => {
    prisma.partnerSupportTicket.findFirst.mockResolvedValue({ id: 't1', ticketNo: 'SUP-0001', status: 'OPEN' });
    await service.replyToSupportTicket('p1', 't1', 'It still fails');
    expect(prisma.partnerSupportTicketMessage.create).toHaveBeenCalledWith({ data: { ticketId: 't1', authorType: 'PARTNER', authorId: 'p1', body: 'It still fails' } });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: 'PARTNER_TICKET_REPLY' }));
    expect(prisma.partnerSupportTicket.update).not.toHaveBeenCalled(); // already open
  });
  test.each(['ANSWERED', 'RESOLVED', 'IN_PROGRESS'])('reopens a %s ticket', async (status) => {
    prisma.partnerSupportTicket.findFirst.mockResolvedValue({ id: 't1', ticketNo: 'SUP-0001', status });
    await service.replyToSupportTicket('p1', 't1', 'Not fixed');
    expect(prisma.partnerSupportTicket.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'OPEN', resolvedAt: null } });
  });
  test('a closed ticket takes no reply, and another partner\'s ticket is a 404', async () => {
    prisma.partnerSupportTicket.findFirst.mockResolvedValue({ id: 't1', status: 'CLOSED' });
    await expect(service.replyToSupportTicket('p1', 't1', 'hello')).rejects.toMatchObject({ statusCode: 409 });
    prisma.partnerSupportTicket.findFirst.mockResolvedValue(null);
    await expect(service.replyToSupportTicket('p2', 't1', 'hello')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.partnerSupportTicketMessage.create).not.toHaveBeenCalled();
  });
  test('the message must have some text and not be huge', () => {
    expect(supportTicketReplySchema.safeParse({ message: ' ' }).success).toBe(false);
    expect(supportTicketReplySchema.safeParse({ message: 'x'.repeat(2001) }).success).toBe(false);
    expect(supportTicketReplySchema.safeParse({ message: 'Still broken' }).success).toBe(true);
  });
});
