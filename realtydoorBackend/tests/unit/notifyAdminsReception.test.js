// 23 Nov 2026: a receptionist-only account is an ADMIN-role account but must not receive every admin alert (buyer names, payments, KYC).
jest.mock('../../src/lib/prisma', () => ({ user: { findMany: jest.fn() }, notification: { createMany: jest.fn() } }));
const prisma = require('../../src/lib/prisma');
const { notifyAdmins } = require('../../src/lib/notifications');

test('notifyAdmins leaves out receptionist-only accounts and keeps everyone else', async () => {
  prisma.user.findMany
    .mockResolvedValueOnce([
      { id: 'owner', staffRole: null, adminPermissions: [] },
      { id: 'recep', staffRole: 'RECEPTION', adminPermissions: ['RECEPTION'] },
      { id: 'support', staffRole: 'SUPPORT', adminPermissions: ['LEADS'] },
      { id: 'super', staffRole: 'SUPER_ADMIN', adminPermissions: ['RECEPTION'] },
      { id: 'mixed', staffRole: 'RECEPTION', adminPermissions: ['RECEPTION', 'LEADS'] },
    ])
    .mockImplementationOnce(async ({ where }) => where.id.in.map((id) => ({ id, notifPush: true })));
  prisma.notification.createMany.mockResolvedValue({ count: 4 });

  await notifyAdmins({ title: 't', message: 'm', type: 'LEAD_NEW' });

  expect(prisma.user.findMany.mock.calls[1][0].where.id.in).toEqual(['owner', 'support', 'super', 'mixed']);
  const sentTo = prisma.notification.createMany.mock.calls[0][0].data.map((d) => d.userId);
  expect(sentTo).not.toContain('recep');
});
