// Found live on 25 Oct 2026: when a buyer verified a fix or reopened a ticket, admin heard nothing in the app.
jest.mock('../../src/lib/prisma', () => ({
  serviceTicket: { findFirst: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/modules/escrow/escrow.service', () => ({ refund: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const { notifyAdmins } = require('../../src/lib/notifications');
const users = require('../../src/modules/users/users.service');

const resolved = { id: 't1', userId: 'u1', status: 'RESOLVED', subject: 'Leaking tap', shortId: 'TKT-521D' };
beforeEach(() => {
  jest.clearAllMocks();
  prisma.serviceTicket.findFirst.mockResolvedValue(resolved);
  prisma.serviceTicket.update.mockImplementation(async ({ data }) => ({ ...resolved, ...data }));
  notifyAdmins.mockResolvedValue();
});

describe('buyer verifies or reopens a ticket', () => {
  test('verifying tells the admins, with the rating, and still returns the updated ticket', async () => {
    const out = await users.verifyTicket('u1', 't1', { vendorRating: 5 });
    expect(out.status).toBe('VERIFIED_BY_USER');
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: 'TICKET_VERIFIED', linkUrl: '/admin/tickets/t1' }));
    expect(notifyAdmins.mock.calls[0][0].message).toContain('Leaking tap');
    expect(notifyAdmins.mock.calls[0][0].message).toContain('5');
  });
  test('reopening tells the admins with the reason', async () => {
    const out = await users.reopenTicket('u1', 't1', 'Still dripping');
    expect(out.status).toBe('IN_PROGRESS');
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: 'TICKET_REOPENED', linkUrl: '/admin/tickets/t1' }));
    expect(notifyAdmins.mock.calls[0][0].message).toContain('Still dripping');
  });
  test('a ticket that is not resolved is refused and nobody is notified', async () => {
    prisma.serviceTicket.findFirst.mockResolvedValue({ ...resolved, status: 'OPEN' });
    await expect(users.verifyTicket('u1', 't1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(users.reopenTicket('u1', 't1', 'x')).rejects.toMatchObject({ statusCode: 400 });
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
  test('a failing notice never fails the buyer\'s action', async () => {
    notifyAdmins.mockRejectedValue(new Error('down'));
    await expect(users.verifyTicket('u1', 't1')).resolves.toMatchObject({ status: 'VERIFIED_BY_USER' });
  });
});
