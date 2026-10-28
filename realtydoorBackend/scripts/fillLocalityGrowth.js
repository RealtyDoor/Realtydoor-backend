/**
 * Fills the empty 1-year price change on two Bengaluru locality reports, keeping everything else in priceTrends.
 *   Whitefield       13.0%  (HexaHome trend chart and a Brigade guide agree; Mahindra and NoBroker say 8 to 12%)
 *   Electronic City  16.1%  (99acres locality data as quoted by PropNewz, Jun 2026; other sources 9 to 25%)
 * Both are indicative (see admin-nextjs/docs/qa/LOCALITY_REPORT_DRAFTS.md sections 6 and 7).
 *
 *   node scripts/fillLocalityGrowth.js            # dry run: prints before and after
 *   node scripts/fillLocalityGrowth.js --apply    # saves the old priceTrends to the rollback file, then writes
 *   node scripts/fillLocalityGrowth.js --restore  # puts the old priceTrends back
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const FILLS = [
  { city: 'Bengaluru', locality: 'Whitefield', oneYear: 13.0 },
  { city: 'Bengaluru', locality: 'Electronic City', oneYear: 16.1 },
];
const ROLLBACK = path.resolve(__dirname, '../../../backups/locality-growth-rollback-2026-10-27.json');
const prisma = new PrismaClient();

async function main() {
  if (process.argv.includes('--restore')) {
    const saved = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const s of saved) await prisma.localityInsight.update({ where: { id: s.id }, data: { priceTrends: s.priceTrends } });
    console.log(`restored ${saved.length} rows`);
    return;
  }
  const saved = [];
  for (const f of FILLS) {
    const r = await prisma.localityInsight.findFirst({ where: { city: f.city, locality: f.locality } });
    if (!r) { console.log('missing row', f.locality); continue; }
    const before = r.priceTrends || {};
    const after = { ...before, growth: { ...(before.growth || {}), oneYear: f.oneYear } };
    console.log(`${f.locality}\n  before: ${JSON.stringify(before.growth ?? null)}\n  after : ${JSON.stringify(after.growth)}   (history and everything else unchanged)`);
    saved.push({ id: r.id, priceTrends: r.priceTrends ?? null });
    if (process.argv.includes('--apply')) await prisma.localityInsight.update({ where: { id: r.id }, data: { priceTrends: after } });
  }
  if (process.argv.includes('--apply')) {
    fs.writeFileSync(ROLLBACK, JSON.stringify(saved, null, 1));
    console.log('written; rollback saved to', ROLLBACK);
  } else console.log('(dry run: nothing written)');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
