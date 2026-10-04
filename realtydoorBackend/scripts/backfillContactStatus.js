/**
 * One-time backfill for ContactMessage.status / .source (docs 11.2 / 11.5).
 *
 * Both fields are required-with-@default, but a Prisma default only applies at
 * CREATE time — it is not written retroactively to documents that already
 * exist. So every message created before these fields were added has them
 * missing in Mongo, and because the fields are required (not optional),
 * Prisma offers no `isSet` filter to find or fix them from the client:
 *
 *   - groupBy(['status']) threw outright:
 *       "Attempted to serialize non-enum-compatible value 'null'"
 *   - count({ where: { status: { isSet: false } } }) is rejected:
 *       "Unknown argument `isSet`"
 *
 * Hence raw Mongo. admin.service.js's inbox counts were also changed to
 * explicit per-status counts rather than a groupBy, so a missing field can
 * never take that endpoint down again — but the rows still need real values
 * to be counted at all, which is what this does.
 *
 *   node scripts/backfillContactStatus.js           # dry run
 *   node scripts/backfillContactStatus.js --apply   # writes the defaults
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

async function main() {
  const [statusMissing, sourceMissing] = await Promise.all([
    prisma.$runCommandRaw({ count: 'ContactMessage', query: { status: { $exists: false } } }),
    prisma.$runCommandRaw({ count: 'ContactMessage', query: { source: { $exists: false } } }),
  ]);

  console.log(`status missing: ${statusMissing.n}`);
  console.log(`source missing: ${sourceMissing.n}`);

  if (!statusMissing.n && !sourceMissing.n) {
    console.log('Nothing to backfill.');
    return;
  }
  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to write the defaults.');
    return;
  }

  const res = await prisma.$runCommandRaw({
    update: 'ContactMessage',
    updates: [
      {
        q: { status: { $exists: false } },
        u: { $set: { status: 'NEW' } },
        multi: true,
      },
      {
        // CONTACT_FORM is the right default: before `source` existed, the
        // public contact form was the only way a row could be created.
        q: { source: { $exists: false } },
        u: { $set: { source: 'CONTACT_FORM' } },
        multi: true,
      },
    ],
  });

  console.log(`Backfilled. Documents modified: ${res.nModified ?? res.n}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
