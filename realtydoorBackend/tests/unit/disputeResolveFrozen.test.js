// Resolving or closing an escrow dispute does not unfreeze the escrow (a person decides whether to release, refund or unfreeze), so the
// admins are reminded when the escrow is still FROZEN. Nothing else about resolving a dispute changes.
jest.mock('../../src/lib/prisma', () => ({
  dispute: { findUnique: jest.fn(), update: jest.fn() },
  escrowTransaction: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(), notifyAdmins: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendDisputeUpdate: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const { createNotification, notifyAdmins } = require('../../src/lib/notifications');
const { createAuditLog } = require('../../src/lib/auditLog');
const { sendDisputeUpdate } = require('../../src/lib/email');
const svc = require('../../src/modules/disputes/disputes.service');
const flush = () => new Promise((r) => setImmediate(r));

const dispute = (extra = {}) => ({ id: 'd1', userId: 'b1', type: 'ESCROW', referenceId: 'e1', status: 'OPEN', ...extra });
beforeEach(() => {
  jest.resetAllMocks();
  notifyAdmins.mockResolvedValue();
  createNotification.mockResolvedValue();
  createAuditLog.mockResolvedValue();
  sendDisputeUpdate.mockResolvedValue();
  prisma.user.findUnique.mockResolvedValue({ email: 'b@x.co' });
});
const resolveAs = (status, d = dispute()) => {
  prisma.dispute.findUnique.mockResolvedValue(d);
  prisma.dispute.update.mockResolvedValue({ ...d, status });
  return svc.adminResolveDispute('d1', { status, adminNote: 'Checked with both sides' }, 'a1');
};

test.each(['RESOLVED', 'CLOSED'])('%s with the escrow still frozen reminds the admins, with a link to the escrow list', async (status) => {
  prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1', status: 'FROZEN' });
  await resolveAs(status);
  await flush();
  expect(notifyAdmins).toHaveBeenCalledTimes(1);
  expect(notifyAdmins.mock.calls[0][0]).toMatchObject({ title: 'Dispute resolved, token still frozen', linkUrl: '/admin/escrow' });
  expect(notifyAdmins.mock.calls[0][0].message).toMatch(/unfreeze, release or refund/);
});
test('no reminder when the escrow is no longer frozen', async () => {
  prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1', status: 'HELD' });
  await resolveAs('RESOLVED');
  await flush();
  expect(notifyAdmins).not.toHaveBeenCalled();
});
test('no reminder while the dispute is only moving along (not resolved or closed)', async () => {
  prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1', status: 'FROZEN' });
  await resolveAs('UNDER_REVIEW');
  await flush();
  expect(notifyAdmins).not.toHaveBeenCalled();
});
test('a dispute that is not about an escrow never looks one up', async () => {
  await resolveAs('RESOLVED', dispute({ type: 'SERVICE' }));
  await flush();
  expect(prisma.escrowTransaction.findUnique).not.toHaveBeenCalled();
});
test('a failing reminder never fails the resolve', async () => {
  prisma.escrowTransaction.findUnique.mockRejectedValue(new Error('db'));
  await expect(resolveAs('RESOLVED')).resolves.toMatchObject({ status: 'RESOLVED' });
});
