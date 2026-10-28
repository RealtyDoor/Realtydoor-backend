const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');

// Runs every 30 minutes.
// Clears OTPs whose expiry has passed and unlocks leads whose lock window has expired.
function start() {
  cron.schedule('*/30 * * * *', async () => {
    const now = new Date();

    try {
      const expiredLeads = await prisma.lead.findMany({
        where: { siteVisitOTP: { not: null }, otpExpiresAt: { lte: now }, isOtpVerified: false },
        select: { id: true },
      });
      await Promise.all(
        expiredLeads.map((l) => prisma.lead.update({ where: { id: l.id }, data: { siteVisitOTP: null, otpAttempts: 0 } }))
      );

      const lockedLeads = await prisma.lead.findMany({
        // `not: null` matters: on MongoDB a lead with no lock (null) also satisfies `lte now`, so every lead used to be
        // "unlocked" and updated every 30 minutes, which kept moving its updatedAt (wrong ages and last-activity dates).
        where: { otpLockedUntil: { not: null, lte: now } },
        select: { id: true },
      });
      await Promise.all(
        lockedLeads.map((l) => prisma.lead.update({ where: { id: l.id }, data: { otpLockedUntil: null, otpAttempts: 0 } }))
      );

      if (expiredLeads.length > 0 || lockedLeads.length > 0) {
        logger.info('[OtpCleanupJob] Cleanup complete', {
          expiredOtpsCleared: expiredLeads.length,
          locksReleased: lockedLeads.length,
        });
      }
    } catch (err) {
      logger.error('[OtpCleanupJob] DB update failed', {
        error: err.message,
        stack: err.stack,
      });
    }
  });

  logger.info('[Jobs] OTP cleanup job scheduled (every 30 min)');
}

module.exports = { start };
