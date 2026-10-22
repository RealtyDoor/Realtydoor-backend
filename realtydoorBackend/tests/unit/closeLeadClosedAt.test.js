jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), update: jest.fn() },
  user: { findMany: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const leads = require('../../src/modules/leads/leads.service');

beforeEach(() => { jest.clearAllMocks(); prisma.user.findMany.mockResolvedValue([]); });

describe('closeLead stamps closedAt (T16)', () => {
  const lead = { id: 'l1', status: 'SITE_VISIT_DONE', allocationLetterUrl: 'u', escrowTransactions: [{ status: 'HELD', razorpayPaymentId: 'pay_1' }] };
  test('sets closedAt with the status', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead);
    await leads.closeLead('l1', 'p1');
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED', closedAt: expect.any(Date) });
  });
  test('refuses without a captured token, and without the letter', async () => {
    prisma.lead.findFirst.mockResolvedValue({ ...lead, escrowTransactions: [] });
    await expect(leads.closeLead('l1', 'p1')).rejects.toMatchObject({ statusCode: 400 });
    prisma.lead.findFirst.mockResolvedValue({ ...lead, allocationLetterUrl: null });
    await expect(leads.closeLead('l1', 'p1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});
