jest.mock('../../src/lib/prisma', () => ({ lead: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() } }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn(), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const users = require('../../src/modules/users/users.service');

const DAY = 24 * 3600e3;
const now = new Date('2026-10-22T10:00:00Z');
const ratedAgo = (days) => new Date(now.getTime() - days * DAY);
beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockImplementation(async ({ data }) => ({ id: 'l1', ...data })); });

describe('updateLeadRating (B88)', () => {
  test('changes the rating inside the 7 days and records when', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1', buyerRating: 3, buyerRatedAt: ratedAgo(2) });
    await users.updateLeadRating('b1', 'l1', { rating: 5, comment: 'Much better after the call' }, now);
    expect(prisma.lead.update.mock.calls[0][0].data).toEqual({ buyerRating: 5, buyerRatingComment: 'Much better after the call', buyerRatingEditedAt: now });
  });
  test('is closed after 7 days', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1', buyerRating: 3, buyerRatedAt: ratedAgo(7) });
    await expect(users.updateLeadRating('b1', 'l1', { rating: 5 }, now)).rejects.toMatchObject({ statusCode: 409, data: expect.objectContaining({ code: 'RATING_EDIT_WINDOW_CLOSED' }) });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('needs an existing rating, and only on the buyer\'s own lead', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1', buyerRating: null, buyerRatedAt: null });
    await expect(users.updateLeadRating('b1', 'l1', { rating: 4 }, now)).rejects.toMatchObject({ statusCode: 400 });
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(users.updateLeadRating('b2', 'l1', { rating: 4 }, now)).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.lead.findFirst.mock.calls[1][0].where).toEqual({ id: 'l1', buyerId: 'b2' });
  });
});

describe('getMyRatings (B88)', () => {
  test('lists the buyer\'s ratings with whether each can still be changed', async () => {
    prisma.lead.findMany.mockResolvedValue([
      { id: 'l1', refCode: 'RD-L-1', buyerRating: 4, buyerRatingComment: 'Good', buyerRatedAt: ratedAgo(1), buyerRatingEditedAt: null, property: { title: 'Flat A', city: 'Bengaluru' }, assignedPartner: { name: 'Ravi' } },
      { id: 'l2', refCode: 'RD-L-2', buyerRating: 2, buyerRatingComment: null, buyerRatedAt: ratedAgo(30), buyerRatingEditedAt: null, property: null, assignedPartner: null },
    ]);
    const r = await users.getMyRatings('b1', now);
    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({ buyerId: 'b1', buyerRating: { not: null } });
    expect(r[0]).toMatchObject({ leadId: 'l1', partnerName: 'Ravi', rating: 4, canEdit: true });
    expect(r[1]).toMatchObject({ leadId: 'l2', partnerName: null, propertyTitle: null, canEdit: false });
  });
});
