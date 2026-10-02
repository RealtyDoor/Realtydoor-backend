/**
 * A11 (optional) — best-effort backfill of Lead.buyerId for legacy leads
 * submitted before submitLead() required an authenticated, phone-verified
 * account (leads.service.js now always snapshots buyerId from req.user).
 *
 * Matches purely on buyerPhone === User.phone. This is inherently lossy:
 * a legacy lead's buyerPhone may not match any registered account at all
 * (the pre-migration flow didn't require one), or may match a phone number
 * that's since been reused by a different account — so a match here is a
 * reasonable guess, not a guarantee. Leads that don't match anyone are left
 * untouched (buyerId stays unset; sanitizeLeadForBuyer-gated endpoints simply
 * never surface them to a "My Inquiries" list, same as today).
 *
 * Run once:
 *
 *   node scripts/backfillLeadBuyerId.js           # dry run — reports matches found
 *   node scripts/backfillLeadBuyerId.js --apply   # writes buyerId for matched leads
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

async function main() {
  const leads = await prisma.lead.findMany({
    where: { buyerId: { isSet: false } },
    select: { id: true, buyerPhone: true },
  });

  console.log(`${leads.length} lead(s) missing buyerId.`);
  if (leads.length === 0) return;

  let matched = 0;
  for (const lead of leads) {
    const user = await prisma.user.findFirst({ where: { phone: lead.buyerPhone }, select: { id: true } });
    if (!user) continue;
    matched++;
    console.log(`  lead ${lead.id} (${lead.buyerPhone}) -> user ${user.id}${APPLY ? '' : ' (dry run)'}`);
    if (APPLY) {
      await prisma.lead.update({ where: { id: lead.id }, data: { buyerId: user.id } });
    }
  }

  console.log(`${matched} of ${leads.length} legacy lead(s) matched a registered account.`);
  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to write buyerId for matched leads.');
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
