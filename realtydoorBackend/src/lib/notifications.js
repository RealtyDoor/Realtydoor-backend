const prisma = require('./prisma');

async function createNotification({ userId, title, message, type, linkUrl }) {
  return prisma.notification.create({
    data: { userId, title, message, type, linkUrl: linkUrl || null },
  });
}

async function broadcastNotification({ userIds, title, message, type, linkUrl }) {
  return prisma.notification.createMany({
    data: userIds.map((userId) => ({ userId, title, message, type, linkUrl: linkUrl || null })),
  });
}

module.exports = { createNotification, broadcastNotification };
