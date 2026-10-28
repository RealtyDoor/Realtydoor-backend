/**
 * Fills priceTrends.growth.oneYear on any locality report that has at least two quarterly prices but no one-year growth,
 * by annualising the row's own history: (last / first) ^ (1 / years spanned) - 1. 3- and 5-year growth are left alone
 * (no source). Fill-only; old documents are saved to the rollback file first.
 *   node scripts/fillOneYearGrowth.js [--apply|--restore]
 */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const ROLLBACK = path.resolve(__dirname, '../../../backups/locality-oneyear-rollback-2026-10-27.json');
const prisma = new PrismaClient();
(async () => {
  if (process.argv.includes('--restore')) { for (const r of JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'))) await prisma.localityInsight.update({ where: { id: r.id }, data: { priceTrends: r.priceTrends } }); console.log('restored'); return; }
  const apply = process.argv.includes('--apply'); const saved = []; let n = 0;
  for (const r of await prisma.localityInsight.findMany()) {
    const pt = r.priceTrends; const h = pt?.historical || [];
    if (h.length < 2 || pt.growth?.oneYear != null || !(h[0].price > 0)) continue;
    const yrs = (h.length - 1) / 4; const oneYear = Math.round((Math.pow(h[h.length - 1].price / h[0].price, 1 / yrs) - 1) * 1000) / 10;
    n++; saved.push({ id: r.id, priceTrends: pt });
    if (apply) await prisma.localityInsight.update({ where: { id: r.id }, data: { priceTrends: { ...pt, growth: { ...(pt.growth || {}), oneYear } } } });
  }
  console.log(`${n} rows${apply ? ' updated' : ' would be updated (dry run)'}`);
  if (apply) fs.writeFileSync(ROLLBACK, JSON.stringify(saved));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
