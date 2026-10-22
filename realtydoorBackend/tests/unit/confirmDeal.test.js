jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), update: jest.fn() },
  escrowTransaction: { findFirst: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { notifyAdmins } = require('../../src/lib/notifications');
const users = require('../../src/modules/users/users.service');

beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockResolvedValue({}); });

describe('confirmDeal (B29)', () => {
  const lead = { id: 'l1', refCode: 'RD-L-1', status: 'SITE_VISIT_DONE', buyerFeedbackStatus: null };
  test('a buyer who paid the token can confirm: same status the WhatsApp yes sets, admins told', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead);
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1' });
    expect(await users.confirmDeal('b1', 'l1')).toEqual({ confirmed: true, alreadyConfirmed: false });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ buyerFeedbackStatus: 'VERIFIED_CLOSED', feedbackReceivedAt: expect.any(Date) });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: 'BUYER_CONFIRMED_DEAL' }));
  });
  test('only on their own lead', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(users.confirmDeal('b2', 'l1')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'l1', buyerId: 'b2' });
  });
  test('not before the token is paid', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead);
    prisma.escrowTransaction.findFirst.mockResolvedValue(null);
    await expect(users.confirmDeal('b1', 'l1')).rejects.toMatchObject({ statusCode: 400, data: expect.objectContaining({ code: 'TOKEN_NOT_PAID' }) });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('not on a dropped inquiry', async () => {
    prisma.lead.findFirst.mockResolvedValue({ ...lead, status: 'DROPPED' });
    await expect(users.confirmDeal('b1', 'l1')).rejects.toMatchObject({ statusCode: 400 });
  });
  test('a second confirmation changes and notifies nothing', async () => {
    prisma.lead.findFirst.mockResolvedValue({ ...lead, buyerFeedbackStatus: 'VERIFIED_CLOSED' });
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1' });
    expect(await users.confirmDeal('b1', 'l1')).toEqual({ confirmed: true, alreadyConfirmed: true });
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});
