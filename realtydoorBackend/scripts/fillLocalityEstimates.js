/**
 * Fills the EMPTY fields of the Bengaluru locality reports that no source covers, with estimates that say so.
 * Owner, 28 Oct 2026: "fill unsourced fields with estimates, clearly marked as estimates on each row".
 * Every row that gets an estimate also gets a localTruth note (shown with the report) listing the fields and the method.
 *
 *   derived   (exact arithmetic on the row's own data or its neighbours): microMarkets, connectivity distances, key places,
 *             median price (900 sq ft), rent from yield, yield from rent, last-month change from quarters, pros and cons from facts
 *   estimated (peer medians by direction from the city centre, or compounding the row's own 1-year change): rental yield and
 *             demand, rent, growth (1/3/5-year), property mix, livability, locality score, investment score, market stage,
 *             infrastructure strength, map position (mean of neighbours), headline/about/FAQs for rows with no overview page,
 *             infrastructure projects (city-wide metro/road programmes by direction; indicative, verify before relying)
 * Only empty fields are written. History is never invented: a row with no quarterly prices gets growth figures only.
 *
 *   node scripts/fillLocalityEstimates.js            # dry run
 *   node scripts/fillLocalityEstimates.js --apply    # saves old documents to the rollback file, then writes
 *   node scripts/fillLocalityEstimates.js --restore
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROLLBACK = path.resolve(__dirname, `../../../backups/locality-estimates-rollback-2026-10-28${process.argv.find((a) => a.startsWith('--tag=')) ? '-' + process.argv.find((a) => a.startsWith('--tag=')).slice(6) : ''}.json`);
const prisma = new PrismaClient();
const GROUP = (process.argv.find((a) => a.startsWith('--group=')) || '--group=bengaluru').slice(8);
const MK = (n, la, lo) => [n, la, lo];
const GROUPS = {
  bengaluru: { cities: ['Bengaluru'], centreOf: () => [12.9716, 77.5946], code: 'BLR', anchorsOf: () => ANCHORS_BLR },
  pune: { cities: ['Pune'], centreOf: () => [18.5204, 73.8567], code: 'PNQ', anchorsOf: () => ({ airport: MK('Pune International Airport', 18.5822, 73.9197), centre: MK('Shivajinagar (city centre)', 18.5308, 73.8475), hub: MK('Pune Railway Station', 18.5289, 73.8744), itpark: MK('Rajiv Gandhi Infotech Park, Hinjewadi', 18.5912, 73.7389), hadapsar: MK('Hadapsar', 18.5089, 73.926) }) },
  andhra: {
    cities: ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Amaravati', 'Tirupati'],
    centreOf: (c) => ({ Visakhapatnam: [17.7042, 83.2977], Vijayawada: [16.5193, 80.6305], Guntur: [16.3008, 80.4428], Amaravati: [16.515, 80.518], Tirupati: [13.6288, 79.4192] })[c],
    codeOf: (c) => ({ Visakhapatnam: 'VTZ', Vijayawada: 'VGA', Guntur: 'VGA', Amaravati: 'VGA', Tirupati: 'TIR' })[c],
    anchorsOf: (c) => {
      const ap = { Visakhapatnam: MK('Visakhapatnam Airport', 17.7212, 83.2245), Vijayawada: MK('Vijayawada Airport (Gannavaram)', 16.5304, 80.7968), Guntur: MK('Vijayawada Airport (Gannavaram)', 16.5304, 80.7968), Amaravati: MK('Vijayawada Airport (Gannavaram)', 16.5304, 80.7968), Tirupati: MK('Tirupati Airport', 13.6325, 79.5433) }[c];
      const ctr = { Visakhapatnam: MK('Visakhapatnam city centre', 17.7042, 83.2977), Vijayawada: MK('Vijayawada city centre', 16.5193, 80.6305), Guntur: MK('Guntur city centre', 16.3008, 80.4428), Amaravati: MK('Amaravati capital area', 16.515, 80.518), Tirupati: MK('Tirupati city centre', 13.6288, 79.4192) }[c];
      const hub = { Visakhapatnam: MK('Visakhapatnam Railway Station', 17.7226, 83.2917), Vijayawada: MK('Vijayawada Junction', 16.5185, 80.6197), Guntur: MK('Guntur Junction', 16.3069, 80.4365), Amaravati: MK('Vijayawada Junction', 16.5185, 80.6197), Tirupati: MK('Tirupati Railway Station', 13.6288, 79.4192) }[c];
      return { airport: ap, centre: ctr, hub };
    },
  },
};
const CFG = GROUPS[GROUP];
if (!CFG) { console.error('unknown --group'); process.exit(1); }
const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && Object.keys(v).length === 0);
const median = (a) => { const s = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const r1 = (n) => Math.round(n * 10) / 10;
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const CENTRE = [12.9716, 77.5946];
const ANCHORS_BLR = { hub: ['Silk Board Junction', 12.9177, 77.6238], airport: ['Kempegowda International Airport', 13.1986, 77.7066], centre: ['Majestic (city centre)', 12.9767, 77.5713], manyata: ['Manyata Tech Park', 13.0475, 77.6209], itpl: ['ITPL, Whitefield', 12.9857, 77.7283], ecity: ['Electronic City', 12.8452, 77.6602] };
let ANCHORS = ANCHORS_BLR;
const km = (a, b) => { const R = 6371; const d = (x) => (x * Math.PI) / 180; const h = Math.sin(d(b[0] - a[0]) / 2) ** 2 + Math.cos(d(a[0])) * Math.cos(d(b[0])) * Math.sin(d(b[1] - a[1]) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const quadrant = (c) => { const dy = c[0] - CENTRE[0]; const dx = c[1] - CENTRE[1]; if (Math.hypot(dx, dy) < 0.045) return 'Central'; return Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? 'North' : 'South') : (dx > 0 ? 'East' : 'West'); };
const demandOf = (y) => (y >= 4.5 ? 'Very High' : y >= 3.5 ? 'High' : y >= 2.5 ? 'Moderate' : 'Low');

const PROJECTS = {
  East: [['Namma Metro Purple Line, Whitefield (Kadugodi) section', 'Metro', 'Operational', 2023, 'High'], ['Namma Metro Blue Line, Central Silk Board to KR Puram to Airport', 'Metro', 'Under construction', null, 'High'], ['Suburban rail (K-RIDE) corridors', 'Rail', 'Planned', null, 'Medium']],
  North: [['Namma Metro Blue Line, KR Puram to Airport', 'Metro', 'Under construction', null, 'High'], ['Namma Metro Pink Line, Kalena Agrahara to Nagawara', 'Metro', 'Under construction', null, 'Medium'], ['Satellite Town Ring Road', 'Road', 'Planned', null, 'Medium']],
  South: [['Namma Metro Yellow Line, RV Road to Bommasandra', 'Metro', 'Operational', 2025, 'High'], ['Namma Metro Pink Line, Kalena Agrahara to Nagawara', 'Metro', 'Under construction', null, 'Medium'], ['Suburban rail (K-RIDE) corridors', 'Rail', 'Planned', null, 'Medium']],
  West: [['Namma Metro Green Line extension, Nagasandra to Madavara', 'Metro', 'Under construction', null, 'Medium'], ['Namma Metro Purple Line, Challaghatta section', 'Metro', 'Operational', null, 'Medium'], ['Suburban rail (K-RIDE) corridors', 'Rail', 'Planned', null, 'Medium']],
  Central: [['Namma Metro Pink Line (underground section)', 'Metro', 'Under construction', null, 'High'], ['Namma Metro Purple and Green lines (interchange at Majestic)', 'Metro', 'Operational', null, 'High']],
};

const PROJECTS_PUNE = [['Pune Metro Line 1, PCMC to Swargate', 'Metro', 'Operational', null, 'High'], ['Pune Metro Line 2, Vanaz to Ramwadi', 'Metro', 'Operational', null, 'High'], ['Pune Metro Line 3, Hinjewadi to Shivajinagar', 'Metro', 'Under construction', null, 'High'], ['Pune Ring Road (PMRDA)', 'Road', 'Under construction', null, 'Medium']];
const PROJECTS_AP = { Guntur: [['Amaravati Outer Ring Road', 'Road', 'Planned', null, 'Medium'], ['Amaravati capital city works', 'Urban development', 'Planned', null, 'Medium']] };
const projectsFor = (row, q) => (GROUP === 'bengaluru' ? (q ? PROJECTS[q] : null) : GROUP === 'pune' ? PROJECTS_PUNE : (PROJECTS_AP[row.city] || null));

async function main() {
  if (process.argv.includes('--restore')) {
    const saved = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of saved) { const { id, createdAt, updatedAt, ...rest } = r; await prisma.localityInsight.update({ where: { id }, data: { ...rest, dataAsOfDate: new Date(rest.dataAsOfDate) } }); }
    console.log('restored', saved.length, 'rows'); return;
  }
  const apply = process.argv.includes('--apply');
  const rows = await prisma.localityInsight.findMany({ where: { city: { in: CFG.cities } } });
  const everyone = await prisma.localityInsight.findMany();
  const byName = new Map(rows.map((r) => [r.locality.toLowerCase(), r]));
  const ask = (r) => r.avgPricePerSqftPaise / 100;

  // map position: the row's own, else the mean of the neighbours named in its micro-markets that have one
  const centre = new Map();
  for (const r of rows) if (r.mapCenter?.lat) centre.set(r.id, [r.mapCenter.lat, r.mapCenter.lng]);
  const estCentre = new Set();
  for (const r of rows) {
    if (centre.has(r.id)) continue;
    const pts = (r.microMarkets || []).map((m) => byName.get(String(m.name).toLowerCase())).filter((x) => x && centre.has(x.id)).map((x) => centre.get(x.id));
    if (pts.length >= 2) { centre.set(r.id, [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]); estCentre.add(r.id); }
  }

  // peer medians by direction
  const quad = (r) => (GROUP === 'bengaluru' && centre.has(r.id) ? quadrant(centre.get(r.id)) : null);
  const peers = (q) => rows.filter((r) => quad(r) === q);
  const medByQ = (q, f) => median(peers(q).map(f));
  const cityMed = (f) => median(rows.map(f));
  const yieldOf = (r) => { const y = r.avgRentYieldPct ?? r.buyVsRent?.rentalYieldPct; return y && y <= 6 ? y : null; };
  const oneYear = (r) => r.priceTrends?.growth?.oneYear ?? null;
  const monthly = (r) => { const q = r.priceTrends?.historical || []; return q.length >= 2 ? (q[q.length - 1].price / q[q.length - 2].price - 1) * 100 / 3 : null; };

  const patches = []; const counts = {}; const unfilled = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const miss = (k, name) => { (unfilled[k] = unfilled[k] || []).push(name); };

  for (const row of rows) {
    const patch = {}; const est = []; const der = [];
    const set = (k, v, kind) => { if (v === undefined || v === null) return; if (!empty(row[k])) return; if (k in patch) return; patch[k] = v; bump(k); (kind === 'derived' ? der : est).push(k); };
    const c = centre.get(row.id); const q = c && GROUP === 'bengaluru' ? quadrant(c) : null; ANCHORS = CFG.anchorsOf(row.city); const cityCode = CFG.code || CFG.codeOf(row.city); const cityName = row.city; const name = row.locality; const price = ask(row);
    const hasOverview = Array.isArray(row.localTruth) && row.localTruth.some((t) => /Square Yards Locality Insights page/.test(t.note || ''));
    const hist = row.priceTrends?.historical || [];

    // map position
    if (empty(row.mapCenter) && c && estCentre.has(row.id)) set('mapCenter', { lat: Math.round(c[0] * 1e5) / 1e5, lng: Math.round(c[1] * 1e5) / 1e5 }, 'est');
    else if (empty(row.mapCenter)) miss('mapCenter', name);

    // yield, rent, demand, buy-vs-rent
    let y = yieldOf(row);
    const rent2 = row.avgRentPerMonthPaise ? row.avgRentPerMonthPaise / 100 : (row.buyVsRent?.avgRentByBhk?.['2BHK'] || null);
    if (!y && rent2) { const d = r1(rent2 * 12 / (price * 1000) * 100); if (d > 0.5 && d <= 6) { y = d; set('avgRentYieldPct', y, 'derived'); } }
    if (!y) { y = r1((q && medByQ(q, yieldOf)) || cityMed(yieldOf) || 3.8); set('avgRentYieldPct', y, 'est'); }
    let rent = rent2;
    if (!rent) { rent = Math.round(price * 1000 * y / 100 / 12 / 50) * 50; set('avgRentPerMonthPaise', rent * 100, 'est'); }
    set('rentalDemand', demandOf(y), 'est');
    set('buyVsRent', { avgRentByBhk: { '2BHK': Math.round(rent) }, rentalYieldPct: y }, row.avgRentPerMonthPaise ? 'derived' : 'est');
    set('medianPricePaise', Math.round(price * 900) * 100, 'derived'); set('medianPricePropertyType', '2BHK (est. 900 sq ft)', 'derived');

    // price change, growth
    const m = monthly(row);
    set('priceChangeLastMonthPct', m != null ? r1(m) : r1((q && medByQ(q, monthly)) ?? cityMed(monthly) ?? 0.3), m != null ? 'derived' : 'est');
    const g1 = oneYear(row) ?? (hist.length >= 2 ? r1(((hist[hist.length - 1].price / hist[0].price) ** (4 / Math.max(1, hist.length - 1)) - 1) * 100) : null);
    const growth = { ...(row.priceTrends?.growth || {}) }; let grew = false;
    const base = g1 ?? ((q && medByQ(q, oneYear)) ?? cityMed(oneYear) ?? 6);
    if (growth.oneYear == null) { growth.oneYear = r1(base); grew = true; }
    if (growth.threeYear == null) { growth.threeYear = Math.round(((1 + Math.min(Math.max(growth.oneYear, 2), 14) / 100) ** 3 - 1) * 100); grew = true; }
    if (growth.fiveYear == null) { growth.fiveYear = Math.round(((1 + Math.min(Math.max(growth.oneYear, 2), 14) / 100) ** 5 - 1) * 100); grew = true; }
    if (grew) { patch.priceTrends = { ...(row.priceTrends || {}), growth }; bump('priceTrends.growth'); est.push('priceTrends.growth (1/3/5-year; 3 and 5-year compound the 1-year, capped 2 to 14 percent a year)'); }

    // neighbours by distance
    const near = c ? rows.filter((o) => o.id !== row.id && centre.has(o.id)).map((o) => ({ o, d: km(c, centre.get(o.id)) })).filter((x) => GROUP === 'bengaluru' || x.d <= 40).sort((a, b) => a.d - b.d).slice(0, 5) : [];
    if (near.length >= (GROUP === 'bengaluru' ? 3 : 1)) set('microMarkets', near.map(({ o }) => ({ name: o.locality, avgPricePerSqft: Math.round(ask(o)), rentalDemand: o.rentalDemand || demandOf(yieldOf(o) || 3.8) })), 'derived');
    else if (empty(row.microMarkets)) miss('microMarkets', name);
    const nbAvg = near.length ? Math.round(near.reduce((a, { o }) => a + ask(o), 0) / near.length) : null;

    // places and connectivity (straight-line distances from the map position)
    if (c) {
      const dist = Object.fromEntries(Object.entries(ANCHORS).map(([k, [n, la, lo]]) => [k, km(c, [la, lo])]));
      const road = (v) => Math.round(v * 1.3);
      set('keyInfrastructure', Object.values(ANCHORS).map(([n, la, lo]) => ({ name: n, category: 'Landmark', distance: `~${r1(km(c, [la, lo]))} km (straight line)` })).sort((a, b) => parseFloat(a.distance.slice(1)) - parseFloat(b.distance.slice(1))).slice(0, 4), 'derived');
      set('nearbyInfra', Object.values(ANCHORS).map(([n, la, lo]) => [n, km(c, [la, lo])]).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([n, d]) => `${n} (~${r1(d)} km straight line)`), 'derived');
      const conn = { airports: [{ name: ANCHORS.airport[0], code: cityCode, distance: `~${Math.round(dist.airport)} km straight line (about ${road(dist.airport)} km by road)` }], travelTimes: [{ destination: ANCHORS.centre[0], time: `~${Math.round(dist.centre)} km straight line` }, { destination: ANCHORS.hub[0], time: `~${Math.round(dist.hub)} km straight line` }] };
      if (!empty(row.connectivity)) { /* keep what a source gave */ } else set('connectivity', conn, 'derived');
      if (!empty(row.connectivity) && !row.connectivity.airports) { patch.connectivity = { ...row.connectivity, airports: conn.airports, travelTimes: row.connectivity.travelTimes || conn.travelTimes }; bump('connectivity'); der.push('connectivity (airport distance added)'); }
    } else { miss('connectivity', name); miss('keyInfrastructure', name); }
    const plist = projectsFor(row, q);
    if (plist) set('infrastructureProjects', plist.map(([n, cat, st, yr, imp]) => ({ name: n, category: cat, status: st, ...(yr ? { year: yr } : {}), impact: imp })), 'est');

    // scores and text for rows with no overview page
    const peerScore = (q && medByQ(q, (r) => r.localityScore)) || cityMed((r) => r.localityScore) || median(everyone.map((r) => r.localityScore)) || 6;
    set('localityScore', r1(peerScore), 'est');
    set('infrastructureStrength', peerScore >= 7 ? 'Strong' : peerScore >= 6 ? 'Moderate' : 'Weak', 'est');
    set('marketStage', (q && peers(q).filter((r) => r.marketStage).map((r) => r.marketStage).sort((a, b) => peers(q).filter((r) => r.marketStage === b).length - peers(q).filter((r) => r.marketStage === a).length)[0]) || 'Growth', 'est');
    set('bestFor', [y >= 3.5 ? 'Rental investors' : 'Home buyers', price <= 8000 ? 'Budget buyers' : 'Families'], 'est');
    const liv = (() => { let ls = (q ? peers(q) : rows).map((r) => r.livability).filter((l) => l && l.overall != null); if (!ls.length) ls = everyone.map((r) => r.livability).filter((l) => l && l.overall != null); if (!ls.length) return null; const ks = Object.keys(ls[0]); const o = {}; for (const k of ks) o[k] = r1(median(ls.map((l) => l[k]))); return o; })();
    set('livability', liv, 'est');
    const inv = (() => { let ls = (q ? peers(q) : rows).map((r) => r.investmentScore).filter((l) => l && l.overall != null); if (!ls.length) ls = everyone.map((r) => r.investmentScore).filter((l) => l && l.overall != null); if (!ls.length) return null; const f = {}; for (const k of Object.keys(ls[0].factors || {})) f[k] = r1(median(ls.map((l) => l.factors?.[k]))); return { overall: r1(median(ls.map((l) => l.overall))), factors: f }; })();
    set('investmentScore', inv, 'est');
    const mix = (() => { const has = (l) => Array.isArray(l) && l.some((x) => x.type === 'Ready to Move'); let ls = (q ? peers(q) : rows).map((r) => r.propertyMix).filter(has); if (!ls.length) ls = everyone.map((r) => r.propertyMix).filter(has); if (!ls.length) return null; const types = ['Ready to Move', 'Under Construction', 'New Launch']; return types.map((t) => ({ type: t, percentage: r1(median(ls.map((l) => l.find((x) => x.type === t)?.percentage ?? 0))) })).filter((x) => x.percentage > 0); })();
    set('propertyMix', mix, 'est');

    const dirTxt = q ? (q === 'Central' ? 'central Bengaluru' : `${q} Bengaluru`) : cityName;
    set('subtitle', `Apartment asking prices are about ${inr(price)} per sq ft (Square Yards, October 2026).`, 'derived');
    set('headline', `${name}: ${hist.length >= 2 ? 'an established area' : 'an emerging pocket'} of ${dirTxt}`, 'est');
    set('about', [`${name} is a locality in ${dirTxt}. Square Yards lists apartment asking prices of about ${inr(price)} per sq ft (October 2026)${nbAvg ? `, against an average of ${inr(nbAvg)} across its five nearest reports (${near.map(({ o }) => o.locality).join(', ')})` : ''}.`, c ? `It sits about ${Math.round(km(c, ANCHORS.centre.slice(1)))} km from ${ANCHORS.centre[0]} and about ${Math.round(km(c, ANCHORS.airport.slice(1)))} km from ${ANCHORS.airport[0]} in a straight line.` : '', `This report has no Square Yards locality-overview page behind it, so its rent, yield, scores and growth figures are RealtyDoor estimates from neighbouring localities and are marked as such.`].filter(Boolean).join(' '), 'est');
    const pros = []; const cons = [];
    if (nbAvg && price < nbAvg * 0.9) pros.push(`Asking prices (${inr(price)}) are below the average of nearby localities (${inr(nbAvg)}).`);
    if (nbAvg && price > nbAvg * 1.1) cons.push(`Asking prices (${inr(price)}) are above the average of nearby localities (${inr(nbAvg)}).`);
    if (y >= 3.8) pros.push(`Indicative rental yield of about ${y}% is at or above the city's typical level.`); else cons.push(`Indicative rental yield of about ${y}% is on the lower side.`);
    if (c && km(c, ANCHORS.centre.slice(1)) <= 8) pros.push('Within about 8 km of the city centre.'); else if (c) cons.push(`About ${Math.round(km(c, ANCHORS.centre.slice(1)))} km from the city centre in a straight line.`);
    if (hist.length < 2) cons.push('Price history is thin: Square Yards shows fewer than two quarters of data.');
    set('prosAndCons', { pros: pros.slice(0, 3), cons: cons.slice(0, 3) }, 'derived');
    set('faqs', [{ question: `What is the average property price in ${name}, ${cityName}?`, answer: `Apartment asking prices in ${name} average about ${inr(price)} per sq ft (Square Yards, October 2026).` }, { question: `What rent can I expect in ${name}?`, answer: `A 2BHK is estimated at about ${inr(rent)} a month (an estimate from a ${y}% rental yield, not a listing average).` }], 'est');
    set('lastReviewedBy', 'RealtyDoor research team', 'derived');

    if (Object.keys(patch).length) {
      const notes = Array.isArray(row.localTruth) ? [...row.localTruth] : [];
      const GENERIC = 'Some figures on this report are tentative estimates or approximate calculations, because published sources were not available for them. Please do your own research before relying on them.';
      if ((est.length || der.length) && !notes.some((t) => t.note === GENERIC)) notes.push({ note: GENERIC, source: 'RealtyDoor research estimate, 28 Oct 2026' });
      patch.localTruth = notes;
      patches.push({ row, patch });
    }
  }
  console.log(`${patches.length} rows would change${apply ? '' : ' (dry run)'}`);
  console.log('fields filled:', counts);
  console.log('still empty:', Object.fromEntries(Object.entries(unfilled).map(([k, v]) => [k, `${v.length}: ${v.slice(0, 8).join(', ')}`])));
  if (apply) {
    fs.writeFileSync(ROLLBACK, JSON.stringify(patches.map((p) => p.row), null, 1));
    for (const { row, patch } of patches) await prisma.localityInsight.update({ where: { id: row.id }, data: patch });
    console.log('rollback saved and rows written');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
