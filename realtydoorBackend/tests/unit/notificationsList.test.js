// Found live on 25 Oct 2026: the admin Notifications page counted "Unread" only within the first 50 rows, while the bell showed the real total.
jest.mock('../../src/lib/prisma', () => ({
  notification: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
}));
const prisma = require('../../src/lib/prisma');
const service = require('../../src/modules/notifications/notifications.service');

beforeEach(() => jest.clearAllMocks());

describe('getMyNotifications filters', () => {
  test('no filter: every notification of the user', async () => {
    await service.getMyNotifications('u1', 0, 50);
    expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual({ userId: 'u1' });
  });
  test('unreadOnly narrows to unread, in the same query as the total', async () => {
    await service.getMyNotifications('u1', 0, 50, undefined, true);
    expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual({ userId: 'u1', isRead: false });
    expect(prisma.notification.count.mock.calls[0][0].where).toEqual({ userId: 'u1', isRead: false });
  });
  test('category and unread combine', async () => {
    await service.getMyNotifications('u1', 0, 50, 'ESCROW', true);
    expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual({ userId: 'u1', category: 'ESCROW', isRead: false });
  });
});
