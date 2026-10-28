/**
 * Hides the test and seed listings from every public and buyer surface by ARCHIVING them (publishStatus ARCHIVED, isSearchable false).
 * Nothing is deleted and no lead, escrow, favourite or microsite row is touched. Reversible: --restore puts back exactly what was there.
 *
 *   node scripts/hideTestListings.js            # dry run: prints what would change
 *   node scripts/hideTestListings.js --apply    # writes, after saving the original values to the rollback file
 *   node scripts/hideTestListings.js --restore  # puts the saved values back
 *
 * The list is the owner-approved plan in admin-nextjs/docs/qa/HIDE_TEST_LISTINGS_PLAN.json. A listing with money held in escrow
 * is skipped (resolve that deal first). Atlas is production: take a mongodump before --apply.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const PLAN = path.resolve(__dirname, '../../../admin-nextjs/docs/qa/HIDE_TEST_LISTINGS_PLAN.json');
const ROLLBACK = path.resolve(__dirname, '../../../backups/hide-test-listings-rollback-2026-10-26.json');
const APPLY = process.argv.includes('--apply');
const RESTORE = process.argv.includes('--restore');
const prisma = new PrismaClient();

async function main() {
  if (RESTORE) {
    const saved = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of saved) await prisma.property.update({ where: { id: r.id }, data: { publishStatus: r.publishStatus, isSearchable: r.isSearchable } });
    console.log(`restored ${saved.length} listings`);
    return;
  }
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  const skipSlugs = new Set(plan.rows.filter((r) => r.heldEscrow > 0).map((r) => r.slug));
  const slugs = plan.rows.map((r) => r.slug).filter((s) => !skipSlugs.has(s));
  const props = await prisma.property.findMany({ where: { slug: { in: slugs }, publishStatus: 'APPROVED' }, select: { id: true, slug: true, publishStatus: true, isSearchable: true } });
  console.log(`${APPLY ? 'APPLY' : 'dry run'}: ${props.length} of ${slugs.length} listed listings are still approved; skipped for held escrow: ${[...skipSlugs].join(', ') || 'none'}`);
  if (APPLY) {
    fs.writeFileSync(ROLLBACK, JSON.stringify(props, null, 1));
    for (const p of props) await prisma.property.update({ where: { id: p.id }, data: { publishStatus: 'ARCHIVED', isSearchable: false } });
    console.log(`archived ${props.length}; rollback saved to ${ROLLBACK}`);
  } else {
    for (const p of props) console.log('  would archive', p.slug);
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
