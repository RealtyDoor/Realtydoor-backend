const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { hasMoneyInFlight, anonymizeUser } = require('../lib/accountDeletion');
const { createPrivacyAuditLog } = require('../lib/privacyAuditLog');

// Runs nightly. Finds every account whose 30-day deletion grace period
// (users.service.js::requestAccountDeletion) has expired and anonymizes it.
//
// The query below is deliberately broad (same reasoning as
// escrowAutoEscalate.js's own comment on this) — Mongo's null-vs-missing
// field semantics aren't trustworthy enough here to filter precisely in the
// query itself, so the exact "is this actually due" decision is made in JS
// on values Prisma has already normalized to real JS null/Date, which is
// unambiguous regardless of how Mongo stored them.
async function runOnce() {
  const now = new Date();

  // deletedAt is deliberately left out of the query itself — combining it
  // with deletionScheduledAt's `lte` in one `where` pushes Prisma's Mongo
  // connector onto its $expr-aggregation path, which (same quirk as
  // escrowAutoEscalate.js's autoEscalatedAt) then requires deletedAt to be
  // *present* as well as null, silently excluding every normal user who's
  // never been deleted (deletedAt was never written at all). Checked in JS
  // below instead, where Prisma has already normalized it to a real null.
  const candidates = await prisma.user.findMany({
    where: { deletionScheduledAt: { lte: now } },
    select: { id: true, deletionScheduledAt: true, deletedAt: true },
  });
  const due = candidates.filter((u) => u.deletionScheduledAt && u.deletionScheduledAt <= now && !u.deletedAt);

  if (due.length === 0) return { anonymized: 0, blocked: 0 };

  let anonymized = 0;
  let blocked = 0;

  for (const { id: userId } of due) {
    try {
      // Re-checked here, not trusted from request time — up to 30 days have
      // passed since the request, plenty of time for a new escrow/loan to
      // start. Left as a pending request rather than erroring; it's picked
      // up again on tomorrow's run once the block clears.
      if (await hasMoneyInFlight(userId)) {
        blocked += 1;
        logger.info('[ProcessAccountDeletions] Skipped — money in flight', { userId });
        continue;
      }

      await anonymizeUser(userId);
      await createPrivacyAuditLog({ userId, action: 'DELETION_COMPLETED' });
      anonymized += 1;
    } catch (err) {
      logger.error('[ProcessAccountDeletions] Failed for user', { userId, error: err.message, stack: err.stack });
    }
  }

  logger.info('[ProcessAccountDeletions] Run complete', { anonymized, blocked });
  return { anonymized, blocked };
}

function start() {
  cron.schedule('0 4 * * *', () => {
    runOnce().catch((err) => {
      logger.error('[ProcessAccountDeletions] Job failed', { error: err.message, stack: err.stack });
    });
  });

  logger.info('[Jobs] Process account deletions job scheduled (daily 4am)');
}

module.exports = { start, runOnce };
