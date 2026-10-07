const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');

async function postReview(userId, { propertyId, rating, title, body }) {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, publishStatus: 'APPROVED' },
    select: { id: true },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const existing = await prisma.propertyReview.findUnique({
    where: { userId_propertyId: { userId, propertyId } },
  });
  if (existing) throw new ApiError(409, 'You have already reviewed this property');

  return prisma.propertyReview.create({
    data: { userId, propertyId, rating, title, body },
  });
}

// Dev feedback, 2026-10-07 — PropertyReview.user is a required relation,
// but a review can outlive the user who wrote it (Mongo has no FK
// enforcement). include: { user } made admin.service.js's
// adminListDocuments throw on a whole page over exactly this shape —
// here that would take down the public property-detail reviews panel
// for every visitor, not just an admin list. Users loaded separately
// instead; selectFields lets the two callers below ask for only what
// they each need.
async function attachReviewAuthors(reviews, selectFields) {
  const userIds = [...new Set(reviews.map((r) => r.userId))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: selectFields })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return reviews.map((r) => ({ ...r, user: byId.get(r.userId) ?? null }));
}

async function getPropertyReviews(propertyId) {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, publishStatus: 'APPROVED' },
    select: { id: true },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const reviews = await prisma.propertyReview.findMany({
    where: { propertyId, isApproved: true },
    orderBy: { createdAt: 'desc' },
  });
  return attachReviewAuthors(reviews, { id: true, name: true, profileImageUrl: true });
}

// ─── Admin ────────────────────────────────────────────────────────────────────

async function adminListReviews(filters, skip, limit) {
  const where = {};
  if (filters.propertyId !== undefined) where.propertyId = filters.propertyId;
  if (filters.isApproved !== undefined) where.isApproved = filters.isApproved === 'true';

  const [reviews, total] = await Promise.all([
    prisma.propertyReview.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        property: { select: { id: true, title: true, slug: true } },
      },
    }),
    prisma.propertyReview.count({ where }),
  ]);
  const data = await attachReviewAuthors(reviews, { id: true, name: true, email: true });
  return { data, total };
}

async function adminModerateReview(reviewId, action, adminId) {
  const review = await prisma.propertyReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new ApiError(404, 'Review not found');

  const isApprove = action === 'APPROVE';
  return prisma.propertyReview.update({
    where: { id: reviewId },
    data: {
      isApproved:        isApprove,
      moderatedAt:       new Date(),
      moderatedByAdminId: adminId,
    },
  });
}

module.exports = { postReview, getPropertyReviews, adminListReviews, adminModerateReview };
