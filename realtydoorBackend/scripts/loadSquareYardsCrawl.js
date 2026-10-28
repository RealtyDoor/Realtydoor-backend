/**
 * Loads the Bengaluru localities read from Square Yards "Property Rates" pages on 27 Oct 2026
 * (admin-nextjs/docs/qa/data/squareyards-crawl-2026-10-27.json) into the locality CMS, using the same conventions as the existing
 * rows: average = the page's asking price, history = its quarters, micro-markets = neighbouring localities on its chart (this
 * locality and repeats removed), min/max = lowest and highest of those, rent by BHK and yield from its rental section.
 *   - a locality with no report gets a new row (headline/about/pros are left empty: the page has no such facts to copy)
 *   - a locality that already has a report only has its EMPTY fields filled
 *   - Nandi Hills is skipped: a hill station with a handful of listings, its 33,000 per sq ft is not a residential average
 *
 *   node scripts/loadSquareYardsCrawl.js            # dry run
 *   node scripts/loadSquareYardsCrawl.js --apply    # saves created ids and changed documents, then writes
 *   node scripts/loadSquareYardsCrawl.js --restore
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ARG = process.argv.find((a) => a.startsWith('--data='));
const TAG = ARG ? ARG.slice(7) : '2026-10-27';
const DATA = path.resolve(__dirname, `../../../admin-nextjs/docs/qa/data/squareyards-crawl-${TAG}.json`);
const ROLLBACK = path.resolve(__dirname, `../../../backups/locality-crawl-rollback-${TAG}.json`);
const AS_OF = new Date('2026-10-27T00:00:00.000Z');
const Q = ['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];
const ACR = { jp: 'JP', cv: 'CV', kr: 'KR', rt: 'RT', mg: 'MG', nri: 'NRI', hrbr: 'HRBR', btm: 'BTM', hsr: 'HSR', orr: 'ORR', rmv: 'RMV' };
const nice = (s) => String(s).replace(/[-_]+/g, ' ').trim().split(/\s+/).map((w) => ACR[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const prisma = new PrismaClient();
const empty = (v) => v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

function toRow([slug, ask, , y, hist, micro, rent]) {
  let name = nice(slug.replace(/-jp-nagar$/, '').replace(/^jp-nagar-phase-9$/, 'jp-nagar-phase-9'));
  if (slug === 'defence-colony-bagalakunte') name = 'Defence Colony, Bagalakunte';
  const self = name.toLowerCase();
  const seen = new Set([self]);
  const mm = [];
  for (const part of micro ? micro.split('|') : []) {
    const i = part.lastIndexOf(':'); const n = nice(part.slice(0, i).replace(/ Bangalore$/i, '')); const v = Number(part.slice(i + 1));
    if (!v || seen.has(n.toLowerCase())) continue; seen.add(n.toLowerCase()); mm.push({ name: n, avgPricePerSqft: v });
  }
  const vals = mm.map((m) => m.avgPricePerSqft).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  const history = hist.split(',').map((p, i) => (p ? { period: Q[i], price: Number(p) } : null)).filter(Boolean);
  const rentBy = {}; for (const part of rent ? rent.split('|') : []) { const [k, v] = part.split(':'); const key = k.replace('Bhk', 'BHK'); if (/^[1-5]BHK$/.test(key) && Number(v) > 0) rentBy[key] = Number(v); }
  return { name, ask, y, history: history.length >= 2 ? history : [], micro: mm.slice(0, 6), min: vals.length >= 3 ? vals[0] : null, max: vals.length >= 3 ? vals[vals.length - 1] : null, rent: rentBy, skip: slug === 'nandi-hills' ? 'a hill station with a handful of listings (33,000 per sq ft is not a residential average)' : null };
}

async function main() {
  if (process.argv.includes('--restore')) {
    const s = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of s.changed) { const { id, createdAt, updatedAt, ...rest } = r; await prisma.localityInsight.update({ where: { id }, data: { ...rest, dataAsOfDate: new Date(rest.dataAsOfDate) } }); }
    for (const id of s.created) await prisma.localityInsight.delete({ where: { id } });
    console.log('restored', s.changed.length, 'rows; removed', s.created.length, 'created rows');
    return;
  }
  const apply = process.argv.includes('--apply');
  const rows = JSON.parse(fs.readFileSync(DATA, 'utf8')).map(toRow);
  const created = []; const changed = []; let skipped = 0, made = 0, filled = 0, same = 0;
  for (const r of rows) {
    if (r.skip) { skipped++; console.log(`SKIP ${r.name}: ${r.skip}`); continue; }
    const row = await prisma.localityInsight.findFirst({ where: { city: 'Bengaluru', locality: { equals: r.name, mode: 'insensitive' } } });
    const d = {
      avgPricePerSqftPaise: r.ask * 100, minPricePerSqftPaise: r.min ? r.min * 100 : undefined, maxPricePerSqftPaise: r.max ? r.max * 100 : undefined,
      avgRentYieldPct: r.y ?? undefined, avgRentPerMonthPaise: r.rent['2BHK'] ? r.rent['2BHK'] * 100 : undefined,
      priceTrends: r.history.length ? { historical: r.history } : undefined, microMarkets: r.micro.length ? r.micro : undefined,
      buyVsRent: Object.keys(r.rent).length ? { avgRentByBhk: r.rent, ...(r.y ? { rentalYieldPct: r.y } : {}) } : undefined,
    };
    if (!row) {
      made++;
      if (apply) { const c = await prisma.localityInsight.create({ data: { city: 'Bengaluru', locality: r.name, nearbyInfra: [], bestFor: [], subtitle: `Apartment asking prices are about ₹${r.ask.toLocaleString('en-IN')} per sq ft (Square Yards, October 2026).`, lastReviewedBy: 'RealtyDoor research team', dataAsOfDate: AS_OF, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) } }); created.push(c.id); }
      continue;
    }
    const patch = {};
    for (const [k, v] of Object.entries(d)) if (v !== undefined && empty(row[k])) patch[k] = v;
    if (!Object.keys(patch).length) { same++; continue; }
    filled++; console.log(`FILL ${row.locality}: ${Object.keys(patch).join(', ')}`); changed.push(row);
    if (apply) await prisma.localityInsight.update({ where: { id: row.id }, data: patch });
  }
  console.log(`${made} new, ${filled} filled, ${same} already complete, ${skipped} skipped${apply ? '' : ' (dry run)'}`);
  if (apply) { fs.writeFileSync(ROLLBACK, JSON.stringify({ changed, created }, null, 1)); console.log('rollback saved'); }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
