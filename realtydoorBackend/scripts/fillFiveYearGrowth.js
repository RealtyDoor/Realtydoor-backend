/**
 * Fills priceTrends.growth.fiveYear from Homebazaar's "Property Rates in Bangalore" table (June 2026,
 * admin-nextjs/docs/qa/data/homebazaar-5y-growth-2026-06.json). A locality is only filled when Homebazaar's latest price per sq ft
 * is within 15% of the row's own average (two sources agreeing on the price level); fill-only; old documents are saved first.
 *   node scripts/fillFiveYearGrowth.js [--apply|--restore]
 */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const DATA = path.resolve(__dirname, '../../../admin-nextjs/docs/qa/data/homebazaar-5y-growth-2026-06.json');
const ROLLBACK = path.resolve(__dirname, '../../../backups/locality-fiveyear-rollback-2026-10-27.json');
const prisma = new PrismaClient();
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
(async () => {
  if (process.argv.includes('--restore')) { for (const r of JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'))) await prisma.localityInsight.update({ where: { id: r.id }, data: { priceTrends: r.priceTrends, localTruth: r.localTruth } }); console.log('restored'); return; }
  const apply = process.argv.includes('--apply'); const saved = []; let n = 0; const skipped = [];
  const rows = await prisma.localityInsight.findMany({ where: { city: 'Bengaluru' } });
  for (const [, name, price, g5] of JSON.parse(fs.readFileSync(DATA, 'utf8'))) {
    const r = rows.find((x) => norm(x.locality) === norm(name)); if (!r) { skipped.push(`${name}: no row`); continue; }
    const ours = r.avgPricePerSqftPaise / 100;
    if (Math.abs(price - ours) / ours > 0.15) { skipped.push(`${name}: price ${price} vs ours ${ours}`); continue; }
    const pt = r.priceTrends || { historical: [] }; if (pt.growth?.fiveYear != null) continue;
    n++; saved.push({ id: r.id, priceTrends: r.priceTrends, localTruth: r.localTruth });
    const note = { note: `Five-year price growth (${g5}%) is from Homebazaar's Bangalore property rates table, June 2026; its latest price (₹${price.toLocaleString('en-IN')} per sq ft) matches ours within 15%.`, source: 'https://www.homebazaar.com/knowledge/property-rates-in-bangalore-2/' };
    if (apply) await prisma.localityInsight.update({ where: { id: r.id }, data: { priceTrends: { ...pt, growth: { ...(pt.growth || {}), fiveYear: g5 } }, localTruth: [...(Array.isArray(r.localTruth) ? r.localTruth : []), note] } });
  }
  console.log(`${n} rows${apply ? ' updated' : ' would be updated (dry run)'}; skipped:`, skipped);
  if (apply) fs.writeFileSync(ROLLBACK, JSON.stringify(saved));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
