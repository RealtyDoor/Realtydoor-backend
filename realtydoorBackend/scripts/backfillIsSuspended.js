/**
 * Live-tested finding — User.isSuspended is `Boolean @default(false)`
 * (non-nullable), but 6 pre-existing rows have the field missing from the
 * document entirely (confirmed via a raw `$type` aggregation, not just a
 * Prisma read — Prisma's client silently fills in the schema default when
 * DESERIALIZING a row missing the field, which makes `findMany` reads look
 * fine, but a query FILTER like `where: { isSuspended: false }` only
 * matches an explicit `false` at the MongoDB level and silently excludes
 * these rows — same "missing vs null" class of bug this codebase has hit
 * before for other fields (deletedAt, payoutAttempt, lockCount, ...).
 *
 * Concretely: these 6 users don't show up under either the SUSPENDED or
 * ACTIVE status filter on GET /admin/users, only in the unfiltered list.
 *
 * Safe to re-run — only touches rows where the field is genuinely absent.
 *
 * Run once:
 *
 *   node scripts/backfillIsSuspended.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const result = await prisma.$runCommandRaw({
    update: 'User',
    updates: [
      {
        q: { isSuspended: { $exists: false } },
        u: { $set: { isSuspended: false } },
        multi: true,
      },
    ],
  });
  console.log(`Backfilled isSuspended: false on ${result.nModified ?? result.n ?? 0} row(s).`);
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
