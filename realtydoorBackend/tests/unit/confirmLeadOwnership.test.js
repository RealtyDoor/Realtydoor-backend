// Admin Confirm on a partner-added lead: the adding partner gets it only when credited (one mobile number is one buyer).
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn().mockResolvedValue({}),
  broadcastNotification: jest.fn(), notifyAdmins: jest.fn(),
}));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ partnerLeadWindowDays: 60 }) }));

const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const { createNotification } = require('../../src/lib/notifications');
const admin = require('../../src/modules/admin/admin.service');

const PHONE = '+919000000099';
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const awaiting = { id: 'l1', refCode: 'RD-L-000001', status: 'AWAITING_ADMIN', buyerName: 'Asha', buyerPhone: PHONE, buyerId: null,
  addedByPartnerId: 'A', createdAt: daysAgo(1), property: { title: 'Green Villa' } };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.lead.findUnique.mockResolvedValue(awaiting);
  prisma.lead.findMany.mockResolvedValue([]);
  prisma.lead.update.mockImplementation(async ({ data }) => ({ ...awaiting, ...data }));
  // The partner lookup (role PARTNER) succeeds; every buyer-account lookup (role USER) finds nobody unless a test says so.
  prisma.user.findFirst.mockImplementation(async ({ where }) => (where.role === 'PARTNER' ? { id: where.id } : null));
});

describe('confirmLead and one mobile number, one buyer', () => {
  test('a new buyer is assigned to the partner who added it', async () => {
    const out = await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    expect(out).toMatchObject({ status: 'ASSIGNED', assignedPartnerId: 'A' });
    expect(createNotification.mock.calls.at(-1)[0].message).toContain('is confirmed and assigned to you');
    expect(createAuditLog.mock.calls[0][0].after).toMatchObject({ buyerOwnership: 'NEW_BUYER' });
  });

  test('a number the platform already had goes to the queue, uncredited, and the partner is told', async () => {
    prisma.lead.findMany.mockResolvedValue([{ id: 'old', addedByPartnerId: null, createdAt: daysAgo(100) }]);
    const out = await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    expect(out).toMatchObject({ status: 'UNASSIGNED' });
    expect(out.assignedPartnerId).toBeUndefined();
    const note = createNotification.mock.calls.find((c) => c[0].userId === 'A')[0];
    expect(note.message).toContain('counted as our lead');
    expect(createAuditLog.mock.calls[0][0].after).toMatchObject({ status: 'UNASSIGNED', buyerOwnership: 'EXISTING_BUYER' });
  });

  test('a registered buyer account with no earlier lead also makes it ours', async () => {
    prisma.user.findFirst.mockImplementation(async ({ where }) => {
      if (where.role === 'PARTNER') return { id: where.id };
      return where.phoneVerified ? null : { createdAt: daysAgo(400) };
    });
    const out = await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    expect(out.status).toBe('UNASSIGNED');
    expect(createAuditLog.mock.calls[0][0].after.buyerOwnership).toBe('EXISTING_BUYER');
  });

  test('another partner holding a valid registration keeps it, and this partner is not credited', async () => {
    prisma.lead.findMany.mockResolvedValue([{ id: 'old', addedByPartnerId: 'B', createdAt: daysAgo(10) }]);
    const out = await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    expect(out.status).toBe('UNASSIGNED');
    expect(createAuditLog.mock.calls[0][0].after.buyerOwnership).toBe('OTHER_PARTNER');
  });

  test('the same partner coming back inside the window is still credited', async () => {
    prisma.lead.findMany.mockResolvedValue([{ id: 'old', addedByPartnerId: 'A', createdAt: daysAgo(30) }]);
    const out = await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    expect(out).toMatchObject({ status: 'ASSIGNED', assignedPartnerId: 'A' });
  });

  test('an explicit partner chosen by the admin always stands, even for an existing buyer', async () => {
    prisma.lead.findMany.mockResolvedValue([{ id: 'old', addedByPartnerId: null, createdAt: daysAgo(100) }]);
    const out = await admin.confirmLead('l1', 'C', 'admin1', '1.1.1.1');
    expect(out).toMatchObject({ status: 'ASSIGNED', assignedPartnerId: 'C' });
  });

  test('the check only looks at what existed before this lead, and not at the lead itself', async () => {
    await admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1');
    expect(prisma.lead.findMany.mock.calls[0][0].where).toMatchObject({ buyerPhone: PHONE, id: { not: 'l1' }, createdAt: { lt: awaiting.createdAt } });
  });

  test('only a lead awaiting review can be confirmed', async () => {
    prisma.lead.findUnique.mockResolvedValue({ ...awaiting, status: 'ASSIGNED' });
    await expect(admin.confirmLead('l1', undefined, 'admin1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});

describe('review queue list carries the decision per lead', () => {
  test('an existing buyer is flagged with a note, a new buyer is credited, and non-queue leads are untouched', async () => {
    const queued = (id, phone) => ({ ...awaiting, id, buyerPhone: phone, buyer: null });
    // First findMany call is the queue itself; the later ones are the per-lead history lookups.
    prisma.lead.findMany
      .mockResolvedValueOnce([queued('l1', PHONE), queued('l2', '+919000000088'), { ...queued('l3', PHONE), status: 'ASSIGNED' }])
      .mockResolvedValueOnce([{ id: 'old', addedByPartnerId: null, createdAt: daysAgo(100) }])
      .mockResolvedValueOnce([]);
    prisma.lead.count.mockResolvedValue(3);
    const { data } = await admin.getAllLeads({ status: 'AWAITING_ADMIN' }, 0, 50);
    expect(data.find((l) => l.id === 'l1').ownership).toMatchObject({ credited: false, reason: 'EXISTING_BUYER', note: expect.stringContaining('counted as our lead') });
    expect(data.find((l) => l.id === 'l2').ownership).toMatchObject({ credited: true, reason: 'NEW_BUYER' });
    expect(data.find((l) => l.id === 'l3').ownership).toBeUndefined();
  });
});
