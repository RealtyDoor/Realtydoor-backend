const prisma = require('./prisma');

async function createPrivacyAuditLog({ userId, action, documentVersion, ipAddress, userAgent, metadata }) {
  return prisma.userPrivacyAuditLog.create({
    data: {
      userId,
      action,
      documentVersion: documentVersion || null,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

module.exports = { createPrivacyAuditLog };
