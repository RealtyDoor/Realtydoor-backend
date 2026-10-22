/**
 * Data clean-up from the QA logs: B35, B46, B51, T4, T5, T19, T41. Reads, reports, and (with flags) fixes the safe ones.
 *
 *   node scripts/dataCleanup.js                  # report only, changes nothing
 *   node scripts/dataCleanup.js --apply          # deactivates QA services (T41) and CLOSES the known junk tickets (T19, B46)
 *   node scripts/dataCleanup.js --apply --fix-types   # also fixes property types saved as PLOT whose title says flat / villa / house (B51)
 *
 * Never deletes anything. B35 (orphaned partner), T4 (rent typed as a sale price) and T5 (placeholder description) are only
 * REPORTED: they need a person to decide what is right. Run it against the database you mean to clean.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const plan = require('../src/lib/dataCleanup');

const APPLY = process.argv.includes('--apply');
const FIX_TYPES = process.argv.includes('--fix-types');
const prisma = new PrismaClient();
const tag = (change) => (APPLY && change ? '' : ' (dry run)');

async function main() {
  console.log(`Data clean-up: ${APPLY ? 'APPLY' : 'report only'}${FIX_TYPES ? ' + property types' : ''}\n`);

  const [properties, services, partnerTickets, userTickets, partners] = await Promise.all([
    prisma.property.findMany({ select: { id: true, title: true, propertyType: true, listingType: true, monthlyRent: true, description: true, partnerId: true, publishStatus: true } }),
    prisma.service.findMany({ select: { id: true, name: true, price: true, isActive: true } }),
    prisma.partnerSupportTicket.findMany({ select: { id: true, ticketNo: true, subject: true, status: true } }),
    prisma.serviceTicket.findMany({ select: { id: true, subject: true, status: true } }),
    prisma.user.findMany({ select: { id: true } }),
  ]);

  const qa = plan.planQaServices(services);
  console.log(`T41  active QA / retest services: ${qa.length}`);
  for (const s of qa) {
    console.log(`  ${s.name} (Rs. ${s.price})${tag(true)}`);
    if (APPLY) await prisma.service.update({ where: { id: s.id }, data: { isActive: false } });
  }

  const junk = plan.planJunkTickets({ partnerTickets, userTickets });
  console.log(`\nT19 / B46  junk tickets to close: ${junk.partner.length} partner, ${junk.user.length} buyer`);
  for (const t of junk.partner) {
    console.log(`  partner ${t.ticketNo} "${t.subject}"${tag(true)}`);
    if (APPLY) await prisma.partnerSupportTicket.update({ where: { id: t.id }, data: { status: 'CLOSED' } });
  }
  for (const t of junk.user) {
    console.log(`  buyer ticket "${t.subject}"${tag(true)}`);
    if (APPLY) await prisma.serviceTicket.update({ where: { id: t.id }, data: { status: 'CLOSED' } });
  }

  const typeFixes = plan.planPropertyTypeFixes(properties);
  console.log(`\nB51  listings saved as PLOT whose title says otherwise: ${typeFixes.length}${FIX_TYPES ? '' : '  (add --fix-types to change them)'}`);
  for (const f of typeFixes) {
    console.log(`  "${f.title}": PLOT -> ${f.to}${APPLY && FIX_TYPES ? '' : ' (not changed)'}`);
    if (APPLY && FIX_TYPES) await prisma.property.update({ where: { id: f.id }, data: { propertyType: f.to } });
  }

  const orphans = plan.findOrphanedProperties(properties, partners.map((p) => p.id));
  console.log(`\nB35  listings whose partner no longer exists (decide the right owner, then fix by hand): ${orphans.length}`);
  for (const o of orphans) console.log(`  ${o.id} "${o.title}" partnerId ${o.partnerId} [${o.publishStatus}]`);

  const rents = plan.findSuspiciousRents(properties);
  console.log(`\nT4   rentals with a rent of Rs. 10,00,000 a month or more (a sale price in the rent field?): ${rents.length}`);
  for (const r of rents) console.log(`  ${r.id} "${r.title}" monthlyRent ${r.monthlyRent}`);

  const placeholders = plan.findPlaceholderDescriptions(properties);
  console.log(`\nT5   listings whose description is the form's hint text: ${placeholders.length}`);
  for (const p of placeholders) console.log(`  ${p.id} "${p.title}"`);

  console.log(`\nNothing was deleted.${APPLY ? '' : ' Nothing was changed (report only).'}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
