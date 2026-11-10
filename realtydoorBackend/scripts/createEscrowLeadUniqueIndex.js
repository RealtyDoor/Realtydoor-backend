/**
 * One-time index creation.
 *
 * escrow.service.js's createOrder() checks for an existing active
 * (HELD/PAYMENT_PENDING) escrow on a lead before creating a new one, but that
 * check-then-write is a TOCTOU race: two concurrent requests for the same
 * lead can both pass the check before either writes, producing two Razorpay
 * orders (and two DB rows) for one lead. This partial unique index makes
 * "at most one active escrow per lead" a real DB-level guarantee instead of
 * just an application-level check — createOrder() catches the resulting
 * P2002 and converts it to the same 400 the pre-check already throws.
 *
 * Run once, after confirming there are no existing duplicates:
 *
 *   node scripts/createEscrowLeadUniqueIndex.js           # dry run — reports duplicates only
 *   node scripts/createEscrowLeadUniqueIndex.js --apply   # creates the index (fails loudly if duplicates exist)
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
// 7 Nov 2026: widened from HELD and PAYMENT_PENDING. createOrder() (escrow.service.js) refuses a new order while a token is in any of these
// states (a frozen or part-refunded token still holds the buyer's money), so the index must back the same rule against the race.
const ACTIVE_STATUSES = ['HELD', 'PAYMENT_PENDING', 'HELD_PAYOUT_FAILED', 'FROZEN', 'PARTIALLY_REFUNDED'];
const INDEX_NAME = 'escrow_active_lead_unique';

async function main() {
  const active = await prisma.escrowTransaction.findMany({
    where: { status: { in: ACTIVE_STATUSES } },
    select: { leadId: true },
  });
  const counts = new Map();
  for (const { leadId } of active) counts.set(leadId, (counts.get(leadId) || 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);

  if (duplicates.length > 0) {
    console.error(`Found ${duplicates.length} lead(s) with more than one active escrow — resolve these before creating the unique index:`);
    duplicates.forEach(([leadId, count]) => console.error(`  ${leadId} — ${count} active escrows`));
    process.exitCode = 1;
    return;
  }

  console.log('No leads with multiple active escrows found.');

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to create the index.');
    return;
  }

  // An index of the same name with a different filter cannot be changed in place: drop it, then create the wider one.
  const existing = (await prisma.$runCommandRaw({ listIndexes: 'EscrowTransaction' })).cursor.firstBatch.find((i) => i.name === INDEX_NAME);
  const sameFilter = existing && JSON.stringify(existing.partialFilterExpression?.status?.$in) === JSON.stringify(ACTIVE_STATUSES);
  if (sameFilter) {
    console.log('The index is already in place with these statuses. Nothing to do.');
    return;
  }
  if (existing) {
    console.log(`Replacing ${INDEX_NAME} (was ${JSON.stringify(existing.partialFilterExpression?.status?.$in)}). There is a gap of a few milliseconds with no database-level guard; the application check still runs.`);
    await prisma.$runCommandRaw({ dropIndexes: 'EscrowTransaction', index: INDEX_NAME });
  }
  await prisma.$runCommandRaw({
    createIndexes: 'EscrowTransaction',
    indexes: [
      {
        key: { leadId: 1 },
        name: INDEX_NAME,
        unique: true,
        partialFilterExpression: { status: { $in: ACTIVE_STATUSES } },
      },
    ],
  });

  console.log(`Partial unique index on (leadId, active status) created for ${ACTIVE_STATUSES.join(', ')}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
