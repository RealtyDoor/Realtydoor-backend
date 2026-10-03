const prisma = require('../../lib/prisma');
const { broadcastNotification } = require('../../lib/notifications');

async function getMyNotifications(userId, skip, limit) {
  const [data, total] = await prisma.$transaction([
    prisma.notification.findMany({ where: { userId }, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.notification.count({ where: { userId } }),
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

async function getUnreadCount(userId) {
  const count = await prisma.notification.count({ where: { userId, isRead: false } });
  return { count };
}

async function broadcast({ roles, title, message, type }) {
  const where = {};
  if (roles?.length) where.role = { in: roles };
  const users = await prisma.user.findMany({ where, select: { id: true } });
  return broadcastNotification({ userIds: users.map((u) => u.id), title, message, type });
}

module.exports = { getMyNotifications, markRead, markAllRead, getUnreadCount, broadcast };
