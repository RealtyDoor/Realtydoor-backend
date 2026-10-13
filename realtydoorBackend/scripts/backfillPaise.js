/**
 * BE-9 — one-off backfill for the new integer-paise columns added alongside
 * the existing Float rupee fields: EscrowTransaction.amountPaise/
 * netAmountPaise/partnerSharePaise/platformFeePaise, UserSubscription.
 * amountPaidPaise, Service.pricePaise. Every write path going forward sets
 * these directly (escrow.service.js, services.service.js, admin.service.js);
 * this just fills in rows that existed before those columns did.
 *
 * Safe to re-run — skips any row that already has its paise field set.
 *
 * Run once:
 *
 *   node scripts/backfillPaise.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function backfillEscrow() {
  const rows = await prisma.escrowTransaction.findMany({
    select: { id: true, amount: true, netAmount: true, partnerShareAmount: true, amountPaise: true, netAmountPaise: true, partnerSharePaise: true },
  });
  let updated = 0;
  for (const r of rows) {
    const data = {};
    if (r.amountPaise == null && r.amount != null) data.amountPaise = Math.round(r.amount * 100);
    if (r.netAmountPaise == null && r.netAmount != null) data.netAmountPaise = Math.round(r.netAmount * 100);
    if (r.partnerSharePaise == null && r.partnerShareAmount != null) data.partnerSharePaise = Math.round(r.partnerShareAmount * 100);
    if (Object.keys(data).length) {
      await prisma.escrowTransaction.update({ where: { id: r.id }, data });
      updated++;
    }
  }
  console.log(`EscrowTransaction: backfilled ${updated}/${rows.length}`);
}

async function backfillSubscriptions() {
  const rows = await prisma.userSubscription.findMany({ select: { id: true, amountPaid: true, amountPaidPaise: true } });
  let updated = 0;
  for (const r of rows) {
    if (r.amountPaidPaise == null && r.amountPaid != null) {
      await prisma.userSubscription.update({ where: { id: r.id }, data: { amountPaidPaise: Math.round(r.amountPaid * 100) } });
      updated++;
    }
  }
  console.log(`UserSubscription: backfilled ${updated}/${rows.length}`);
}

async function backfillServices() {
  const rows = await prisma.service.findMany({ select: { id: true, price: true, pricePaise: true } });
  let updated = 0;
  for (const r of rows) {
    if (r.pricePaise == null && r.price != null) {
      await prisma.service.update({ where: { id: r.id }, data: { pricePaise: Math.round(r.price * 100) } });
      updated++;
    }
  }
  console.log(`Service: backfilled ${updated}/${rows.length}`);
}

async function run() {
  await backfillEscrow();
  await backfillSubscriptions();
  await backfillServices();
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
