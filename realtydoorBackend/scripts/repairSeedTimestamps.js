/**
 * Repairs seeded records whose derived timestamps precede their createdAt.
 *
 * prisma/seed.js backdated assignedAt / otpVerifiedAt / heldAt / releasedAt
 * with daysAgo(), but left createdAt to @default(now()) — so a lead "assigned
 * 10 days ago" was created *today*, and every duration computed from it came
 * out negative. The analytics medians dropped those records as corrupt
 * (correctly — a negative elapsed time is not a fast partner), which meant
 * real rows were being discarded from the statistics.
 *
 * The seed itself is fixed, so a fresh `prisma db seed` no longer produces
 * these. This repairs the rows already in a database.
 *
 * It rewrites createdAt to the earliest derived timestamp on the record,
 * rather than moving the derived timestamps, because the derived values carry
 * the intended relative story (assigned, then visited, then released) and
 * createdAt is the one field that was never set deliberately.
 *
 * It also fills siteVisitScheduledAt on leads flagged isOtpVerified without a
 * slot. That state is unreachable through the API — siteVisitOTP is only ever
 * set by scheduleVisit, which always writes the slot — so these are seed-only
 * rows, and the funnel reported 5 OTPs against 4 scheduled visits because of
 * them. The slot is set to otpVerifiedAt, the earliest defensible value.
 *
 *   node scripts/repairSeedTimestamps.js           # dry run
 *   node scripts/repairSeedTimestamps.js --apply   # writes the repairs
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

function earliest(dates) {
  const ts = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return ts.length ? new Date(Math.min(...ts)) : null;
}

async function main() {
  console.log(APPLY ? '--- APPLYING REPAIRS ---' : '--- DRY RUN (pass --apply to write) ---\n');
  let leadFixes = 0;
  let slotFixes = 0;
  let escrowFixes = 0;

  const leads = await prisma.lead.findMany({
    select: {
      id: true, buyerName: true, createdAt: true, assignedAt: true,
      siteVisitScheduledAt: true, otpVerifiedAt: true, isOtpVerified: true,
      feedbackReceivedAt: true, droppedAt: true, dropRequestedAt: true,
    },
  });

  for (const l of leads) {
    const data = {};
    const floor = earliest([
      l.assignedAt, l.siteVisitScheduledAt, l.otpVerifiedAt,
      l.feedbackReceivedAt, l.dropRequestedAt, l.droppedAt,
    ]);
    if (floor && floor < l.createdAt) {
      // One day of head room, so createdAt is strictly before the first event.
      data.createdAt = new Date(floor.getTime() - 86400000);
      leadFixes += 1;
      console.log(`lead ${l.id} (${l.buyerName}): createdAt ${l.createdAt.toISOString().slice(0, 10)} -> ${data.createdAt.toISOString().slice(0, 10)}`);
    }
    if (l.isOtpVerified && !l.siteVisitScheduledAt && l.otpVerifiedAt) {
      data.siteVisitScheduledAt = l.otpVerifiedAt;
      slotFixes += 1;
      console.log(`lead ${l.id} (${l.buyerName}): siteVisitScheduledAt <- otpVerifiedAt ${l.otpVerifiedAt.toISOString().slice(0, 10)}`);
    }
    if (Object.keys(data).length && APPLY) {
      await prisma.lead.update({ where: { id: l.id }, data });
    }
  }

  const escrows = await prisma.escrowTransaction.findMany({
    select: { id: true, createdAt: true, heldAt: true, releasedAt: true, refundedAt: true },
  });

  for (const e of escrows) {
    const floor = earliest([e.heldAt, e.releasedAt, e.refundedAt]);
    if (floor && floor < e.createdAt) {
      const createdAt = new Date(floor.getTime() - 3600000);
      escrowFixes += 1;
      console.log(`escrow ${e.id}: createdAt ${e.createdAt.toISOString().slice(0, 10)} -> ${createdAt.toISOString().slice(0, 10)}`);
      if (APPLY) await prisma.escrowTransaction.update({ where: { id: e.id }, data: { createdAt } });
    }
  }

  console.log(`\n${APPLY ? 'Repaired' : 'Would repair'}: ${leadFixes} lead createdAt, ${slotFixes} missing visit slot, ${escrowFixes} escrow createdAt`);
  if (!leadFixes && !slotFixes && !escrowFixes) console.log('Nothing to repair.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); process.exit(0); });
