/**
 * Fills gaps on the locality reports from Square Yards locality "Property Rates" pages, read on 27 Oct 2026. The existing CMS rows
 * were built from the same data (Whitefield, Electronic City and Kanakapura Road quarterly histories match its pages exactly), so
 * the same conventions are used: average = the page's asking price, history = its four quarters, micro-markets = the neighbouring
 * localities on its comparison chart, min/max = lowest and highest of those, rent by BHK and yield from its rental section.
 * Only EMPTY fields are filled (plus the Jayanagar average and the stale Pune rows, see DATA). Nothing is deleted.
 *
 *   node scripts/fillLocalityFromSquareYards.js            # dry run
 *   node scripts/fillLocalityFromSquareYards.js --apply    # saves the old documents to the rollback file, then writes
 *   node scripts/fillLocalityFromSquareYards.js --restore  # puts old rows back and removes rows this script created
 *
 * Source notes: admin-nextjs/docs/qa/LOCALITY_REPORT_DRAFTS.md section 11.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROLLBACK = path.resolve(__dirname, '../../../backups/locality-squareyards-rollback-2026-10-27.json');
const AS_OF = new Date('2026-10-27T00:00:00.000Z');
const Q = ['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];
const hist = (vals) => vals.map((price, i) => (price ? { period: Q[i], price } : null)).filter(Boolean);
const micro = (pairs) => pairs.map(([name, avgPricePerSqft]) => ({ name, avgPricePerSqft }));
const bhk = (o) => o;

// fill: only set when the field is empty. force: set regardless (stale or wrong value, named in the note).
const DATA = [
  { city: 'Bengaluru', locality: 'BTM Layout', fill: { history: hist([10400, 11500, 13850, 14150]) } },
  { city: 'Bengaluru', locality: 'JP Nagar', fill: { history: hist([11500, 11500, 11350, 11900]) } },
  { city: 'Bengaluru', locality: 'Jayanagar', fill: { history: hist([20900, 21750, 18900, 19850]) }, force: { avgPricePerSqftPaise: 1890000 }, note: 'average 17,500 -> 18,900 (Square Yards Jun 2026 asking price; 19,850 in Sep 2026)' },
  { city: 'Bengaluru', locality: 'Sarjapur Road', fill: { history: hist([12250, 12200, 12250, 12200]), microMarkets: micro([['Carmelaram', 11600], ['Doddakannelli', 12750], ['Chikkakannalli', 17700], ['Bhoganhalli', 17000], ['Kaikondrahalli', 18650], ['Kodathi', 10400]]) } },
  { city: 'Bengaluru', locality: 'Kanakapura Road', fill: { microMarkets: micro([['Banashankari 6th Stage', 13350], ['Raja Rajeshwari Nagar', 11600], ['Uttarahalli', 12000], ['JP Nagar Phase 8', 12550], ['Bannerghatta Road', 12450], ['Kalena Agrahara', 11400]]) } },
  { city: 'Visakhapatnam', locality: 'Madhurawada', fill: { history: hist([5150, 4850, 5250, 5400]), microMarkets: micro([['Bakkannapalem', 4250], ['Pothinamallayya Palem', 4850], ['Rushikonda', 5950], ['Kommadi', 5350], ['Yendada', 6650], ['Boyapalem', 3950]]) } },
  { city: 'Visakhapatnam', locality: 'MVP Colony', fill: { microMarkets: micro([['Seethammadhara', 8550], ['Akkayyapalem', 6550], ['Yendada', 6650], ['Boyapalem', 3950], ['Pothinamallayya Palem', 4850], ['Rushikonda', 5950]]) } },
  { city: 'Vijayawada', locality: 'Benz Circle', fill: { microMarkets: micro([['Patamata', 6050], ['Kanuru', 4700], ['Currency Nagar', 4650], ['Ramavarappadu', 4150], ['Tadepalli', 5200], ['Poranki', 4450]]) } },
  // Pune rows were last set on 1 Jan 2024 and held only a price; refreshed from the same page.
  { city: 'Pune', locality: 'Kothrud', stale: true, force: { avgPricePerSqftPaise: 1930000, minPricePerSqftPaise: 1360000, maxPricePerSqftPaise: 2665000, avgRentYieldPct: 2.8, avgRentPerMonthPaise: 3660000, dataAsOfDate: AS_OF },
    fill: { history: hist([17900, 18050, 19300, 18800]), microMarkets: micro([['Anand Nagar', 13600], ['Shivtirth Nagar', 18650], ['Erandwane', 23250], ['Karve Nagar', 21200], ['Deccan Gymkhana', 26650], ['Pashan', 14300]]), buyVsRent: { avgRentByBhk: bhk({ '1BHK': 22000, '2BHK': 36600, '3BHK': 54900, '4BHK': 107500 }), rentalYieldPct: 2.8 } } },
  { city: 'Pune', locality: 'Aundh', stale: true, force: { avgPricePerSqftPaise: 1820000, minPricePerSqftPaise: 1075000, maxPricePerSqftPaise: 2480000, avgRentYieldPct: 2.97, avgRentPerMonthPaise: 3430000, dataAsOfDate: AS_OF },
    fill: { history: hist([16850, 15500, 18200, 18450]), microMarkets: micro([['Someshwarwadi', 13500], ['Anand Nagar', 13600], ['State Bank Nagar', 10750], ['Pimple Nilakh', 13750], ['Pashan', 14300], ['Baner', 16400]]), buyVsRent: { avgRentByBhk: bhk({ '1BHK': 22650, '2BHK': 34300, '3BHK': 52300, '4BHK': 99000 }), rentalYieldPct: 2.97 } } },
  { city: 'Pune', locality: 'Hinjewadi', stale: true, force: { avgPricePerSqftPaise: 1140000, minPricePerSqftPaise: 1050000, maxPricePerSqftPaise: 1530000, avgRentYieldPct: 4.21, dataAsOfDate: AS_OF },
    fill: { history: hist([10950, 11400, 11400, 11350]), microMarkets: micro([['Hinjewadi Phase 2', 12150], ['Marunji', 14000], ['Maan', 10800], ['Wakad', 12700], ['Mahalunge', 12200], ['Tathawade', 11900]]) } },
];

// Localities with listings and no report: created from the same page. Apartment asking prices (the page's basis); most listings here are plots, the subtitle says so.
const NEW_ROWS = [
  {
    city: 'Bengaluru', locality: 'Hoskote', avg: 6750, min: 7400, max: 21150,
    history: hist([5400, 7250, 6750, 7350]),
    micro: micro([['Dasarahalli', 12400], ['Budigere Cross', 12400], ['Kannamangala', 10000], ['Soukya Road', 11850], ['Kadugodi', 10250], ['Belathur', 7400]]),
    headline: 'East Bengaluru corridor, mostly plots and land',
    subtitle: 'About 27 km east of the city centre on the Old Madras Road (NH 75), beside the Satellite Town Ring Road. Apartment asking prices are about ₹6,750/sqft; most listings here are plots.',
    about: 'Hoskote lies on the Old Madras Road (NH 75) corridor about 27 km east of the city centre. The first phase of the Satellite Town Ring Road, from Dobbaspet to Hoskote, opened on 11 March 2024, and the Bengaluru-Chennai expressway is reported to be nearing completion. A metro link from KR Puram is only a Phase 3 proposal, with no date. Prices vary widely by approval status: buyers should check for a DC conversion or BMRDA approval before paying, because being near the ring road does not by itself give residential use rights. Figures here are apartment asking prices from Square Yards, October 2026; plot rates are quoted separately by developers and differ.',
    pros: ['Old Madras Road (NH 75) and the first phase of the STRR give road access east and north', 'Entry prices well below Whitefield and Kadugodi'],
    cons: ['Metro is only a proposal (Phase 3), with no date', 'Plot and land prices differ widely by approval; check DC conversion or BMRDA approval'],
    connectivity: { majorRoads: ['Old Madras Road (NH 75)', 'Satellite Town Ring Road (STRR), first phase open since March 2024', 'Bengaluru-Chennai Expressway (reported nearing completion)'], metro: [{ name: 'KR Puram to Hoskote extension', line: 'Phase 3 proposal', status: 'Proposed' }] },
  },
  {
    city: 'Bengaluru', locality: 'Jigani', avg: 5650, min: 5350, max: 13250,
    history: hist([5350, 5350, 5650, 5650]),
    micro: micro([['Lingapura', 7500], ['Bommasandra', 8350], ['Hebbagodi', 7500], ['Chandapura Anekal Road', 6550], ['Neeladri Nagar', 5350], ['Chandapura', 6300]]),
    yield: 4.04, rent: { '2BHK': 12000, '3BHK': 39350 },
    headline: 'South Bengaluru industrial belt near Bommasandra',
    subtitle: 'South of Bommasandra and Electronic City, with the Yellow Line open to Bommasandra. Apartment asking prices are about ₹5,650/sqft; most listings here are plots.',
    about: 'Jigani sits in south Bengaluru beyond Bommasandra and Electronic City, in an industrial belt. The Yellow Line metro, from RV Road to Bommasandra, opened in full on 11 August 2025; a link onward to Jigani is only proposed. Plot rates are quoted at roughly ₹3,500 to ₹7,000 per sq ft depending on approvals, while apartments average about ₹5,650 per sq ft on Square Yards (October 2026), close to the 99acres figure of about ₹5,550. Check the layout approval (BMRDA, A-khata) before paying.',
    pros: ['Yellow Line metro now runs to Bommasandra', 'Entry prices below Electronic City'],
    cons: ['A metro link to Jigani itself is only proposed', 'Plot rates vary with approval status'],
    connectivity: { metro: [{ name: 'RV Road to Bommasandra', line: 'Yellow Line', status: 'Operational since 11 Aug 2025' }, { name: 'Bommasandra to Jigani extension', line: 'Yellow Line', status: 'Proposed' }] },
  },
];

const prisma = new PrismaClient();
const empty = (v) => v == null || (Array.isArray(v) && v.length === 0);

async function main() {
  if (process.argv.includes('--restore')) {
    const s = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of s.changed) { const { id, createdAt, updatedAt, ...rest } = r; await prisma.localityInsight.update({ where: { id }, data: { ...rest, dataAsOfDate: new Date(rest.dataAsOfDate) } }); }
    for (const id of s.created) await prisma.localityInsight.delete({ where: { id } });
    console.log('restored', s.changed.length, 'rows; removed', s.created.length, 'created rows');
    return;
  }
  const apply = process.argv.includes('--apply');
  const changed = []; const created = [];
  for (const d of DATA) {
    const r = await prisma.localityInsight.findFirst({ where: { city: d.city, locality: d.locality } });
    if (!r) { console.log('MISSING row', d.city, d.locality); continue; }
    const data = {}; const notes = [];
    const pt = r.priceTrends || {};
    if (d.fill.history && (d.stale || empty(pt.historical))) { data.priceTrends = { ...pt, historical: d.fill.history }; notes.push('history'); }
    if (d.fill.microMarkets && (d.stale || empty(r.microMarkets))) { data.microMarkets = d.fill.microMarkets; notes.push('micro-markets'); }
    if (d.fill.buyVsRent && (d.stale || empty(r.buyVsRent))) { data.buyVsRent = d.fill.buyVsRent; notes.push('rent by BHK'); }
    for (const [k, v] of Object.entries(d.force || {})) { data[k] = v; notes.push(k); }
    if (!notes.length) { console.log('nothing to do:', d.locality); continue; }
    console.log(`${d.city} | ${d.locality}: ${notes.join(', ')}${d.note ? ' [' + d.note + ']' : ''}`);
    changed.push(r);
    if (apply) await prisma.localityInsight.update({ where: { id: r.id }, data });
  }
  for (const n of NEW_ROWS) {
    const exists = await prisma.localityInsight.findFirst({ where: { city: n.city, locality: n.locality } });
    if (exists) { console.log('already exists:', n.locality); continue; }
    console.log(`NEW ${n.city} | ${n.locality}: avg ${n.avg} (${n.min} to ${n.max}), history ${n.history.map((h) => h.price).join('/')}, ${n.micro.length} micro-markets`);
    if (apply) {
      const row = await prisma.localityInsight.create({ data: {
        city: n.city, locality: n.locality, avgPricePerSqftPaise: n.avg * 100, minPricePerSqftPaise: n.min * 100, maxPricePerSqftPaise: n.max * 100,
        avgRentPerMonthPaise: n.rent ? n.rent['2BHK'] * 100 : null, avgRentYieldPct: n.yield ?? null,
        nearbyInfra: [], bestFor: [], headline: n.headline, subtitle: n.subtitle, about: n.about,
        priceTrends: { historical: n.history }, microMarkets: n.micro,
        buyVsRent: n.rent ? { avgRentByBhk: n.rent, rentalYieldPct: n.yield } : undefined,
        prosAndCons: { pros: n.pros, cons: n.cons }, connectivity: n.connectivity,
        lastReviewedBy: 'RealtyDoor research team', dataAsOfDate: AS_OF,
      } });
      created.push(row.id);
    }
  }
  if (apply) { fs.writeFileSync(ROLLBACK, JSON.stringify({ changed, created }, null, 1)); console.log(`written: ${changed.length} rows changed, ${created.length} created; rollback saved`); }
  else console.log('(dry run: nothing written)');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
