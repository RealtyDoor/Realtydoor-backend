/**
 * Data clean-up from the QA logs: B35, B46, B51, T4, T5, T19, T41. Reads, reports, and (with flags) fixes the safe ones.
 *
 *   node scripts/dataCleanup.js                  # report only, changes nothing
 *   node scripts/dataCleanup.js --apply          # deactivates QA services (T41) and CLOSES the known junk tickets (T19, B46)
 *   node scripts/dataCleanup.js --apply --fix-types   # also fixes property types saved as PLOT whose title says flat / villa / house (B51)
 *   node scripts/dataCleanup.js --apply --archive-old  # ARCHIVES old test listings (QA-named, orphaned partner, rent typed as a price, hint-text description) and closes the open leads on them (B35, T4, T5, T8, B27b). Hidden from the site, reversible.
 *
 * Never deletes anything. B35 (orphaned partner), T4 (rent typed as a sale price) and T5 (placeholder description) are only
 * REPORTED: they need a person to decide what is right. Run it against the database you mean to clean.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const plan = require('../src/lib/dataCleanup');

const APPLY = process.argv.includes('--apply');
const FIX_TYPES = process.argv.includes('--fix-types');
const ARCHIVE_OLD = process.argv.includes('--archive-old');
const prisma = new PrismaClient();
const tag = (change) => (APPLY && change ? '' : ' (dry run)');

async function main() {
  console.log(`Data clean-up: ${APPLY ? 'APPLY' : 'report only'}${FIX_TYPES ? ' + property types' : ''}\n`);

  const [properties, services, partnerTickets, userTickets, partners, leads, heldEscrows] = await Promise.all([
    prisma.property.findMany({ select: { id: true, title: true, propertyType: true, listingType: true, monthlyRent: true, description: true, partnerId: true, publishStatus: true } }),
    prisma.service.findMany({ select: { id: true, name: true, price: true, isActive: true } }),
    prisma.partnerSupportTicket.findMany({ select: { id: true, ticketNo: true, subject: true, status: true } }),
    prisma.serviceTicket.findMany({ select: { id: true, subject: true, status: true } }),
    prisma.user.findMany({ select: { id: true } }),
    prisma.lead.findMany({ select: { id: true, propertyId: true, status: true } }),
    prisma.escrowTransaction.findMany({ where: { status: { in: ['HELD', 'HELD_PAYOUT_FAILED', 'PAYMENT_PENDING'] } }, select: { leadId: true } }),
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

  const toArchive = plan.planArchiveListings(properties, partners.map((p) => p.id));
  console.log(`\nOLD TEST LISTINGS to archive (hidden from the site, reversible)${ARCHIVE_OLD ? '' : '  (add --archive-old)'}: ${toArchive.length}`);
  for (const a of toArchive) console.log(`  ${a.id} "${a.title}" [${a.publishStatus}]: ${a.reasons.join(', ')}`);
  const { toDrop, skippedHeld } = plan.planLeadsOnArchived(leads, toArchive.map((a) => a.id), heldEscrows.map((e) => e.leadId));
  console.log(`  open leads on them to close: ${toDrop.length}; left alone because a token is held or being paid: ${skippedHeld.length}`);
  if (APPLY && ARCHIVE_OLD) {
    for (const a of toArchive) await prisma.property.update({ where: { id: a.id }, data: { publishStatus: 'ARCHIVED', isSearchable: false } });
    for (const id of toDrop) await prisma.lead.update({ where: { id }, data: { status: 'DROPPED', droppedAt: new Date(), droppedReason: 'Old test data cleanup' } });
  }

  console.log(`\nNothing was deleted.${APPLY ? '' : ' Nothing was changed (report only).'}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
