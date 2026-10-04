const prisma = require('../../lib/prisma');
const { broadcastNotification, NOTIFICATION_CATEGORIES } = require('../../lib/notifications');

async function getMyNotifications(userId, skip, limit, category) {
  // B6.1 — `category` narrows to one chip. Rows created before the field
  // existed have category: null, so they only ever appear in the unfiltered
  // list; nothing is hidden by default.
  const where = { userId, ...(category && { category }) };
  const [data, total] = await prisma.$transaction([
    prisma.notification.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.notification.count({ where }),
  ]);
  return { data, total };
}

async function markRead(userId, notificationId) {
  return prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { isRead: true, readAt: new Date() },
  });
}

async function markAllRead(userId) {
  return prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
}

// B6.2 — exact totals, plus a per-category breakdown for the chip badges.
// One groupBy instead of a count per chip. Every category is present in the
// response even at zero, so the frontend doesn't have to defensively default.
async function getUnreadCount(userId) {
  const [count, grouped] = await Promise.all([
    prisma.notification.count({ where: { userId, isRead: false } }),
    prisma.notification.groupBy({
      by: ['category'],
      where: { userId, isRead: false },
      _count: { category: true },
    }),
  ]);

  const byCategory = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, 0]));
  let categorized = 0;
  for (const row of grouped) {
    if (row.category && row.category in byCategory) {
      byCategory[row.category] = row._count.category;
      categorized += row._count.category;
    }
  }

  // Derived from the total rather than from a null group in `grouped`:
  // notifications created before `category` existed have the field MISSING,
  // and Prisma's groupBy on Mongo doesn't return a bucket for those at all,
  // so counting them directly reported 0 while `count` said otherwise. This
  // keeps the invariant that the chips plus uncategorized sum to `count`.
  return { count, byCategory, uncategorized: count - categorized };
}

async function broadcast({ roles, title, message, type }) {
  const where = {};
  if (roles?.length) where.role = { in: roles };
  const users = await prisma.user.findMany({ where, select: { id: true } });
  return broadcastNotification({ userIds: users.map((u) => u.id), title, message, type });
}

module.exports = { getMyNotifications, markRead, markAllRead, getUnreadCount, broadcast };
