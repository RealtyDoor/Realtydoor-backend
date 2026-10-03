/**
 * FRONTEND_HANDOFF_SPEC.md §3.2 — one-time backfill.
 *
 * Property.viewsThisWeek is incremented via Prisma's `{ increment: 1 }`, which
 * MongoDB executes as an aggregation-pipeline $add — and $add on a field that
 * doesn't exist on the document evaluates to null, not 0. Any Property row
 * that existed before this field was added (i.e. every row, on a real deploy)
 * needs it explicitly set to 0 first, or the very first view on that listing
 * silently writes null instead of 1. Confirmed empirically while building this.
 *
 * Safe to run more than once — only touches rows where the field is still
 * missing or already null.
 *
 *   node scripts/backfillPropertyViewCounter.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.$runCommandRaw({
    update: 'Property',
    updates: [{
      q: { $or: [{ viewsThisWeek: { $exists: false } }, { viewsThisWeek: null }] },
      u: { $set: { viewsThisWeek: 0 } },
      multi: true,
    }],
  });

  console.log(`Backfilled viewsThisWeek=0 for ${result.nModified} propert${result.nModified === 1 ? 'y' : 'ies'}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
