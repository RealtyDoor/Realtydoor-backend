/**
 * A12 — one-time backfill of human-readable refCodes for rows created before
 * refCode existed (auth.service.js / leads.service.js now assign one via
 * lib/refCode.js at creation time for every new User/Lead, so only pre-existing
 * rows need this).
 *
 * Assigns sequentially in createdAt order via the same Counter-backed
 * nextRefCode() used at creation time, so the Counter ends up seeded to the
 * correct final value automatically — no separate Counter seeding step needed.
 *
 * Run once:
 *
 *   node scripts/backfillRefCodes.js           # dry run — reports how many rows need a refCode
 *   node scripts/backfillRefCodes.js --apply   # assigns them
 *
 * After this completes (and only after), add `@unique` to refCode on both
 * User and Lead in their schema files and run `npx prisma db push` — safe at
 * that point since no row is left without a refCode (Mongo's unique index
 * rejects a second `null`, not a second real value).
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { nextRefCode } = require('../src/lib/refCode');

const APPLY = process.argv.includes('--apply');

async function backfill(kind, model) {
  // MongoDB docs created before the refCode field existed never had it
  // written at all (not even as null) — Prisma's ordinary `refCode: null`
  // filter only matches an *explicit* null and silently excludes documents
  // where the field is entirely absent, so `isSet: false` is required here.
  const rows = await model.findMany({
    where: { refCode: { isSet: false } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`${kind}: ${rows.length} row(s) missing a refCode.`);
  if (!APPLY || rows.length === 0) return;

  // Sequential, not Promise.all — nextRefCode() is atomic per call, but
  // assigning in createdAt order only works if awaited one at a time.
  for (const row of rows) {
    const refCode = await nextRefCode(kind);
    await model.update({ where: { id: row.id }, data: { refCode } });
  }
  console.log(`${kind}: assigned ${rows.length} refCode(s).`);
}

async function main() {
  await backfill('user', prisma.user);
  await backfill('lead', prisma.lead);

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to assign refCodes.');
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
