/**
 * Fills two empty fields on the locality reports from data the same row already holds (no new outside facts):
 *   nearbyInfra          <- the first 4 names in the row's own keyInfrastructure, when nearbyInfra is empty
 *   avgRentPerMonthPaise <- the row's own 2BHK rent in buyVsRent.avgRentByBhk, when the average rent is empty
 * The 2BHK rent is used as the "typical monthly rent" for the locality.
 *
 *   node scripts/fillLocalityDerived.js            # dry run
 *   node scripts/fillLocalityDerived.js --apply    # saves the old values to the rollback file, then writes
 *   node scripts/fillLocalityDerived.js --restore  # puts the old values back
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROLLBACK = path.resolve(__dirname, '../../../backups/locality-derived-rollback-2026-10-27.json');
const prisma = new PrismaClient();

async function main() {
  if (process.argv.includes('--restore')) {
    const saved = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const s of saved) await prisma.localityInsight.update({ where: { id: s.id }, data: { nearbyInfra: s.nearbyInfra, avgRentPerMonthPaise: s.avgRentPerMonthPaise } });
    console.log(`restored ${saved.length} rows`);
    return;
  }
  const apply = process.argv.includes('--apply');
  const rows = await prisma.localityInsight.findMany();
  const saved = [];
  for (const r of rows) {
    const data = {};
    const infra = (r.keyInfrastructure || []).map((k) => k && k.name).filter(Boolean).slice(0, 4);
    if ((!r.nearbyInfra || r.nearbyInfra.length === 0) && infra.length) data.nearbyInfra = infra;
    const rent2 = r.buyVsRent && r.buyVsRent.avgRentByBhk && Number(r.buyVsRent.avgRentByBhk['2BHK']);
    if (!r.avgRentPerMonthPaise && rent2 > 0) data.avgRentPerMonthPaise = Math.round(rent2 * 100);
    if (!Object.keys(data).length) continue;
    console.log(`${r.city} | ${r.locality}: ${Object.keys(data).map((k) => (k === 'nearbyInfra' ? `nearbyInfra ${JSON.stringify(data.nearbyInfra).slice(0, 80)}` : `avgRent Rs ${data.avgRentPerMonthPaise / 100}`)).join(' ; ')}`);
    saved.push({ id: r.id, nearbyInfra: r.nearbyInfra, avgRentPerMonthPaise: r.avgRentPerMonthPaise ?? null });
    if (apply) await prisma.localityInsight.update({ where: { id: r.id }, data });
  }
  console.log(`${saved.length} rows ${apply ? 'updated' : 'would change (dry run)'}`);
  if (apply) fs.writeFileSync(ROLLBACK, JSON.stringify(saved, null, 1));
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
