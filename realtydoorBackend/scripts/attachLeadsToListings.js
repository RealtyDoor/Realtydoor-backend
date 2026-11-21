/**
 * Links leads that were imported before their listing existed (scripts/importRealLeads.js --allow-unlisted) to the listing, once it exists.
 * Such a lead has no propertyId and a propertyInterest ending in the listing's slug in brackets: "Vrunda City [vrunda-city-gated-plots-hoskote]".
 * The bracket is removed from propertyInterest when the lead is linked. Dry run unless --apply. Safe to run again.
 *
 *   node scripts/attachLeadsToListings.js              # dry run: what would be linked
 *   node scripts/attachLeadsToListings.js --apply
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const APPLY = process.argv.includes('--apply');
const SLUG = /\[([a-z0-9-]+)\]\s*$/;

(async () => {
  const leads = await prisma.lead.findMany({ where: { propertyId: null, propertyInterest: { not: null } }, select: { id: true, refCode: true, propertyInterest: true } });
  const wanted = leads.map((l) => ({ ...l, slug: (SLUG.exec(l.propertyInterest) || [])[1] })).filter((l) => l.slug);
  const listings = await prisma.property.findMany({ where: { slug: { in: [...new Set(wanted.map((l) => l.slug))] } }, select: { id: true, slug: true } });
  const bySlug = new Map(listings.map((p) => [p.slug, p.id]));
  const perSlug = {};
  let linked = 0;
  for (const l of wanted) {
    perSlug[l.slug] = perSlug[l.slug] || { linked: 0, waiting: 0 };
    if (!bySlug.has(l.slug)) { perSlug[l.slug].waiting += 1; continue; }
    perSlug[l.slug].linked += 1;
    if (APPLY) {
      await prisma.lead.update({ where: { id: l.id }, data: { propertyId: bySlug.get(l.slug), propertyInterest: l.propertyInterest.replace(SLUG, '').trim() || null } });
      linked += 1;
    }
  }
  for (const [slug, c] of Object.entries(perSlug)) console.log(`${slug}: ${c.linked} ${APPLY ? 'linked' : 'would be linked'}, ${c.waiting} waiting (listing not created yet)`);
  console.log(APPLY ? `Linked ${linked} leads.` : 'Dry run only. Re-run with --apply.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
