jest.mock('../../src/lib/prisma', () => ({
  user: { findMany: jest.fn() },
  notification: { createMany: jest.fn() },
}));

const prisma = require('../../src/lib/prisma');
const { notifyAdmins, categoryFor } = require('../../src/lib/notifications');

describe('notifyAdmins', () => {
  test('creates one notification per admin who has push enabled', async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }])
      .mockResolvedValueOnce([{ id: 'a1', notifPush: true }, { id: 'a2', notifPush: false }]);
    prisma.notification.createMany.mockResolvedValue({ count: 1 });

    await notifyAdmins({ title: 'T', message: 'M', type: 'TICKET_NEW', linkUrl: '/admin/tickets/1' });

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'a1', title: 'T', message: 'M', type: 'TICKET_NEW', category: 'SERVICES', linkUrl: '/admin/tickets/1' }],
    });
  });

  test('does nothing when there are no admins', async () => {
    prisma.user.findMany.mockResolvedValueOnce([]);
    expect(await notifyAdmins({ title: 'T', message: 'M', type: 'TICKET_NEW' })).toEqual({ count: 0 });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  test('never throws when the database call fails', async () => {
    prisma.user.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(notifyAdmins({ title: 'T', message: 'M', type: 'TICKET_NEW' })).resolves.toEqual({ count: 0 });
  });

  test('ticket event types land under the Services chip', () => {
    expect(categoryFor('TICKET_NEW')).toBe('SERVICES');
    expect(categoryFor('TICKET_USER_NOTE')).toBe('SERVICES');
  });
});
