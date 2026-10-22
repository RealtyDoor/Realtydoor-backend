/**
 * T16 — best-effort Lead.closedAt for deals closed before the field existed.
 * Uses the lead's updatedAt (the last edit, so it can be later than
 * the real close). Leads that already have closedAt are left alone.
 *
 *   node scripts/backfillClosedAt.js           # dry run
 *   node scripts/backfillClosedAt.js --apply   # writes closedAt
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  const leads = await prisma.lead.findMany({ where: { status: 'CLOSED', closedAt: { isSet: false } }, select: { id: true, updatedAt: true } });
  console.log(`${leads.length} closed lead(s) without closedAt.`);
  for (const lead of leads) {
    console.log(`  lead ${lead.id} -> ${lead.updatedAt.toISOString()}${APPLY ? '' : ' (dry run)'}`);
    if (APPLY) await prisma.lead.update({ where: { id: lead.id }, data: { closedAt: lead.updatedAt } });
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
