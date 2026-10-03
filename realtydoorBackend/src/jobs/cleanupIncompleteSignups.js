const cron = require('node-cron');
const { createClerkClient } = require('@clerk/clerk-sdk-node');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const INCOMPLETE_SIGNUP_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_OTP_AGE_MS = 24 * 60 * 60 * 1000;

// Runs hourly. Two independent cleanups (B10):
//  1. USER accounts stuck mid-onboarding (Google sign-in never completed the
//     phone step) for 24h+ — delete the Clerk identity, then the DB stub.
//     Scoped to role: USER + phoneVerified: false, which only ever matches
//     these onboarding stubs (see B7 — the webhook no longer creates full rows).
//  2. Stale PhoneOtp rows well past expiry.
function start() {
  cron.schedule('0 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - INCOMPLETE_SIGNUP_AGE_MS);
      const stuck = await prisma.user.findMany({
        where: { role: 'USER', phoneVerified: false, createdAt: { lte: cutoff } },
        select: { id: true, clerkId: true, email: true },
      });

      let deleted = 0;
      for (const user of stuck) {
        try {
          await clerk.users.deleteUser(user.clerkId);
        } catch (err) {
          // 404 means it's already gone from Clerk — fine, proceed to drop the DB row.
          if (err.status !== 404) {
            logger.warn('[CleanupIncompleteSignups] Clerk delete failed — will retry next run', {
              userId: user.id, clerkId: user.clerkId, error: err.message,
            });
            continue;
          }
        }
        await prisma.user.delete({ where: { id: user.id } }).catch((err) => {
          logger.error('[CleanupIncompleteSignups] DB delete failed after Clerk delete', {
            userId: user.id, error: err.message,
          });
        });
        deleted += 1;
      }

      const otpCutoff = new Date(Date.now() - STALE_OTP_AGE_MS);
      const { count: otpsCleared } = await prisma.phoneOtp.deleteMany({
        where: { expiresAt: { lte: otpCutoff } },
      });

      if (deleted > 0 || otpsCleared > 0) {
        logger.info('[CleanupIncompleteSignups] Cleanup complete', {
          incompleteSignupsDeleted: deleted,
          staleOtpsCleared: otpsCleared,
        });
      }
    } catch (err) {
      logger.error('[CleanupIncompleteSignups] Job failed', { error: err.message, stack: err.stack });
    }
  });

  logger.info('[Jobs] Incomplete-signup cleanup job scheduled (hourly)');
}

module.exports = { start };
