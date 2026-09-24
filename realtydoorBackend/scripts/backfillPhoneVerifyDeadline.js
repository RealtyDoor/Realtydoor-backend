/**
 * B9 — one-time backfill.
 *
 * Existing users without a verified phone get a 30-day grace period
 * (phoneVerifyDeadline) so requireOnboarded doesn't lock them out the moment
 * this deploy ships. Run once, right after deploying this change:
 *
 *   node scripts/backfillPhoneVerifyDeadline.js
 *
 * Idempotent: only touches rows where phoneVerifyDeadline is still null, so
 * re-running it is a no-op for anyone already backfilled.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

async function main() {
  const deadline = new Date(Date.now() + GRACE_PERIOD_MS);

  const result = await prisma.user.updateMany({
    where: { phoneVerified: false, phoneVerifyDeadline: null },
    data: { phoneVerifyDeadline: deadline },
  });

  console.log(`Backfilled phoneVerifyDeadline (${deadline.toISOString()}) for ${result.count} user(s).`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
