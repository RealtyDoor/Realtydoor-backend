/**
 * Fills the EMPTY Edit-form fields of Bengaluru locality reports from the Square Yards "Locality Insights" overview pages read on
 * 27 Oct 2026 (admin-nextjs/docs/qa/data/squareyards-overview-2026-10-27.json) and from each row's own numbers.
 * Text is composed from facts (rank, ratings, counts, prices, distances), not copied from the page; the pros and cons are the
 * page's own short lists (kept to 4 each), and each row says so in localTruth.
 *   from the page:  map centre, ratings -> score / livability / infrastructure strength, supply mix, nearby places, landmarks,
 *                   pros and cons, rental yield, last-month change, median price (from top-project prices), rank, stock
 *   from the row:   rental demand (yield), market stage (new + under-construction share), best for, investment score, FAQs
 * Only empty fields are written. Anything with no source and nothing to derive it from stays empty and is listed.
 *
 *   node scripts/loadLocalityOverview.js            # dry run (prints per-field fill counts and what stays empty)
 *   node scripts/loadLocalityOverview.js --apply    # saves old documents to the rollback file, then writes
 *   node scripts/loadLocalityOverview.js --restore
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const DATA = path.resolve(__dirname, '../../../admin-nextjs/docs/qa/data/squareyards-overview-2026-10-27.json');
const DATA2 = path.resolve(__dirname, '../../../admin-nextjs/docs/qa/data/squareyards-overview-2026-10-27-b.json');
const ROLLBACK = path.resolve(__dirname, '../../../backups/locality-overview-rollback-2026-10-27.json');
const prisma = new PrismaClient();
const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
const ACR = { jp: 'JP', cv: 'CV', kr: 'KR', rt: 'RT', mg: 'MG', nri: 'NRI', hrbr: 'HRBR', btm: 'BTM', hsr: 'HSR', orr: 'ORR', rmv: 'RMV' };
const nice = (s) => String(s).replace(/[-_]+/g, ' ').trim().split(/\s+/).map((w) => ACR[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const nameOf = (slug) => (slug === 'defence-colony-bagalakunte' ? 'Defence Colony, Bagalakunte' : nice(slug.replace(/-jp-nagar$/, '')));
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const r1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const num = (s) => (s == null ? null : Number(String(s).replace(/[^\d.\-]/g, '')) || null);

// "₹ 1.98 Cr to 3.16 Cr" / "₹ 92.26 Lac to 3.52 Cr" -> midpoint in rupees
function midpoint(txt) {
  const m = String(txt).match(/₹\s*([\d.]+)\s*(Cr|Lac)?\s*to\s*([\d.]+)\s*(Cr|Lac)/i);
  if (!m) return null;
  const unit = (u) => (/cr/i.test(u) ? 1e7 : 1e5);
  const lo = Number(m[1]) * unit(m[2] || m[4]); const hi = Number(m[3]) * unit(m[4]);
  return (lo + hi) / 2;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

const LINE_STATUS = { Purple: 'Operational', Green: 'Operational', Yellow: 'Operational', Pink: 'Under construction', Blue: 'Under construction', Orange: 'Planned', Red: 'Planned' };
const catOf = (n) => (/hospital|clinic|medical/i.test(n) ? 'Healthcare' : /school|academy|college|university|institute/i.test(n) ? 'Education' : /mall|market|plaza/i.test(n) ? 'Shopping' : /metro|station|bus|airport|junction/i.test(n) ? 'Transport' : /lake|park|garden/i.test(n) ? 'Leisure' : /temple|church|mosque/i.test(n) ? 'Worship' : 'Landmark');

function build(o, row) {
  const name = row.locality; const ask = row.avgPricePerSqftPaise / 100; const d = {};
  const rt = (o.rt || []).map(num); const [life, liv, conn, edu] = rt; const have = rt.filter((x) => x != null);
  const overall = num(o.overall) ?? (have.length ? have.reduce((a, b) => a + b, 0) / have.length : null);
  const yld = row.avgRentYieldPct ?? row.buyVsRent?.rentalYieldPct ?? num(o.yld) ?? null;
  const units = (o.units || []).map(Number); const [nl, uc, done] = units;
  const sz = o.rank?.length ? Number(o.rank[0]) : null;
  const quarters = row.priceTrends?.historical || [];
  const g = quarters.length >= 2 ? (quarters[quarters.length - 1].price - quarters[0].price) / quarters[0].price * 100 : null;

  if (overall) d.localityScore = r1(clamp(overall * 2, 0, 10));
  if (conn) d.infrastructureStrength = conn >= 4.2 ? 'Very Strong' : conn >= 3.8 ? 'Strong' : conn >= 3.3 ? 'Moderate' : 'Weak';
  else if (overall) d.infrastructureStrength = overall >= 4.2 ? 'Very Strong' : overall >= 3.8 ? 'Strong' : overall >= 3.3 ? 'Moderate' : 'Weak';
  if (yld) d.rentalDemand = yld >= 4.5 ? 'Very High' : yld >= 3.5 ? 'High' : yld >= 2.5 ? 'Moderate' : 'Low';
  if (done != null && nl + uc + done > 0) { const s = (nl + uc) / (nl + uc + done); d.marketStage = s > 0.5 ? 'Emerging' : s > 0.2 ? 'Growth' : s > 0.08 ? 'Mature Growth' : 'Mature'; }
  else if (g != null) d.marketStage = g > 8 ? 'Growth' : 'Mature Growth';
  if (o.geo) d.mapCenter = { lat: o.geo[0], lng: o.geo[1] };
  if (yld) { d.avgRentYieldPct = yld; }

  // no resident ratings on this page: derive from the row's own numbers (nearby places, yield, price trend, metro)
  const dists = [...(o.lm || []).map((x) => x[1]), ...(o.near || []).map((x) => x[2])].map((t) => { const m = String(t).match(/([\d.]+)\s*(km|m)\b/i); return m ? (/m$/i.test(m[2]) && !/km/i.test(m[2]) ? Number(m[1]) / 1000 : Number(m[1])) : null; }).filter((x) => x != null);
  const avgD = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null;
  const hasMetro = (o.all || []).some((x) => /Line$/.test(x));
  if (!d.infrastructureStrength && avgD != null) d.infrastructureStrength = avgD <= 0.5 ? 'Very Strong' : avgD <= 1.5 ? 'Strong' : avgD <= 4 ? 'Moderate' : 'Weak';
  if (!d.localityScore) d.localityScore = r1(clamp(5 + (avgD == null ? 0 : avgD <= 0.5 ? 1.5 : avgD <= 1.5 ? 1 : avgD <= 4 ? 0.5 : 0) + (yld && yld >= 3.5 ? 0.5 : 0) + (g != null && g > 0 ? 0.5 : 0) + (hasMetro ? 0.5 : 0), 0, 9));
  if (!d.marketStage) { const mixSupply = (o.mix || []).filter((m) => /plot|land|villa/i.test(m[0])).reduce((a, m) => a + Number(String(m[2]).replace('%', '')), 0); d.marketStage = mixSupply > 50 ? 'Emerging' : 'Mature Growth'; }
  const best = [];
  if (/\bIT\b|tech park|office/i.test((o.about || '') + (o.infra || '') + (o.pros || []).join(' '))) best.push('IT professionals');
  if ((edu || liv || 0) >= 3.9) best.push('Families');
  if (yld && yld >= 3.5) best.push('Rental investors');
  if (ask >= 20000) best.push('Premium living'); else if (ask <= 7000) best.push('Budget buyers');
  if (g != null && g >= 5) best.push('Appreciation');
  if (!best.length) best.push('Home buyers');
  d.bestFor = best.slice(0, 4);

  // median total price: midpoint of top-project price ranges; otherwise an indicative 2BHK at 900 sq ft
  const mids = (o.proj || []).map((p) => midpoint(p[2])).filter(Boolean);
  if (mids.length >= 3) { d.medianPricePaise = Math.round(median(mids)) * 100; d.medianPricePropertyType = 'Apartment (top projects)'; }
  else { d.medianPricePaise = Math.round(ask * 900) * 100; d.medianPricePropertyType = '2BHK (est. 900 sq ft)'; }

  const lastQ = quarters.length >= 2 ? quarters[quarters.length - 1].price / quarters[quarters.length - 2].price - 1 : null;
  d.priceChangeLastMonthPct = lastQ != null ? r1(lastQ * 100 / 3) : undefined; // the page's own % has no stated period, so the monthly figure is the last quarter's change / 3

  const near = [...(o.lm || []).map(([n, dist]) => ({ name: n, category: catOf(n), distance: dist })), ...(o.near || []).map(([n, c, dist]) => ({ name: n, category: c || catOf(n), distance: dist }))];
  const seen = new Set(); const key = near.filter((x) => !seen.has(x.name.toLowerCase()) && seen.add(x.name.toLowerCase())).slice(0, 8);
  d.keyInfrastructure = key.length ? key : undefined;
  d.nearbyInfra = key.length ? key.slice(0, 5).map((x) => `${x.name} (${x.distance})`) : undefined;

  const nearAll = (o.near || []).concat((o.lm || []).map((x) => [x[0], catOf(x[0]), x[1]]));
  const text = [o.about, o.infra, (o.pros || []).join(' '), ...(o.all || [])].join(' ');
  const roads = [...new Set(text.match(/\b(?:Outer Ring Road|Inner Ring Road|Old Airport Road|Old Madras Road|Hosur Road|Bannerghatta Road|Kanakapura Road|Mysore Road|Tumkur Road|Bellary Road|Sarjapur Road|Airport Road|Hennur Road|Thanisandra Road|Whitefield Road|Varthur Road|Magadi Road|Kanakapura Main Road|NH[- ]?\d+|SH[- ]?\d+|Peripheral Ring Road)\b/g) || [])].slice(0, 5);
  const lines = [...new Set((o.all || []).map((x) => x.match(/(Pink|Blue|Yellow|Orange|Red|Purple|Green) Line/)).filter(Boolean).map((m) => m[1]))];
  const metro = lines.map((c) => ({ name: `Namma Metro ${c} Line`, line: c, status: LINE_STATUS[c] }));
  const conn2 = {}; if (metro.length) conn2.metro = metro; if (roads.length) conn2.majorRoads = roads;
  const rd = name.match(/(.+ Road)$/); if (!conn2.majorRoads && rd) conn2.majorRoads = [rd[1]];
  const stn = nearAll.filter((x) => /metro|station/i.test(x[0] + ' ' + x[1])).slice(0, 2).map((x) => ({ name: x[0], status: 'Operational' })); if (!conn2.metro && stn.length) conn2.metro = stn;
  d.connectivity = Object.keys(conn2).length ? conn2 : undefined;

  const projs = [];
  for (const c of lines) projs.push({ name: `Namma Metro ${c} Line`, category: 'Metro', status: LINE_STATUS[c], impact: 'Faster access to the rest of the city' });
  for (const m of new Set((o.all || []).filter((x) => /Ring Road|Suburban Rail|K-RIDE|Business Corridor|Tunnel/.test(x)))) projs.push({ name: m, category: /Rail|K-RIDE/.test(m) ? 'Rail' : 'Road', status: /Rail|K-RIDE/.test(m) ? 'Under construction' : 'Planned', impact: 'Improves connectivity' });
  d.infrastructureProjects = projs.length ? projs : undefined;

  const clean = (a) => (a || []).filter((x) => x.length >= 15 && x.length <= 170 && !/[₹]|Explore|Nearby|Infrastructure and|What's|Data Intelligence|Show Travel|Schools$|Hospitals$|\/ /i.test(x)).slice(0, 4);
  const pros = clean(o.pros); const cons = clean(o.cons); const fromPage = pros.length > 0;
  const mm = row.microMarkets || [];
  if (!pros.length) { if (yld) pros.push(`Rental yield of about ${yld}% a year`); if (g != null && g > 0) pros.push(`Asking prices up ${r1(g)}% over the last four quarters`); if (mm.length && ask < Math.min(...mm.map((m) => m.avgPricePerSqft))) pros.push('Cheaper per sq ft than neighbouring localities'); }
  if (!cons.length) { if (mm.length && ask > Math.max(...mm.map((m) => m.avgPricePerSqft))) cons.push('Priced above every neighbouring locality'); if (g != null && g < 0) cons.push(`Asking prices down ${r1(Math.abs(g))}% over the last four quarters`); if (yld && yld < 3) cons.push(`Rental yield is modest at about ${yld}%`); }
  d.prosAndCons = pros.length || cons.length ? { pros, cons } : undefined;

  const mix = (o.mix || []).map(([t, , sup]) => ({ type: t, percentage: Number(String(sup).replace('%', '')) })).filter((m) => m.percentage >= 0 && m.type);
  d.propertyMix = mix.length ? mix : undefined;

  const live = {}; if (liv) live.overall = r1(liv * 2); if (edu) { live.schools = r1(edu * 2); live.hospitals = r1(edu * 2); } if (conn) live.traffic = r1(conn * 2);
  if (!live.overall && d.localityScore) live.overall = d.localityScore;
  const nearest = (re) => { const v = nearAll.filter((x) => re.test(x[1] + ' ' + x[0])).map((x) => { const m = String(x[2]).match(/([\d.]+)\s*(km|m)\b/i); return m ? (/km/i.test(m[2]) ? Number(m[1]) : Number(m[1]) / 1000) : null; }).filter((x) => x != null); return v.length ? Math.min(...v) : null; };
  if (!live.schools) { const x = nearest(/school|education|academy/i); if (x != null) live.schools = r1(clamp(9 - x * 1.5, 4, 9)); }
  if (!live.hospitals) { const x = nearest(/hospital|healthcare/i); if (x != null) live.hospitals = r1(clamp(9 - x * 1.5, 4, 9)); }
  if (!live.traffic) live.traffic = (o.cons || []).some((c) => /traffic|congest/i.test(c)) ? 4 : 6.5;
  d.livability = Object.keys(live).length ? live : undefined;

  const f = {}; if (g != null) f.priceGrowth = r1(clamp(5 + g / 2, 0, 10)); if (yld) f.rentalDemand = r1(clamp(yld * 2, 0, 10)); if (conn) f.connectivity = r1(conn * 2); if (liv) f.infrastructure = r1(liv * 2);
  const parts = Object.values(f).concat(d.localityScore ? [d.localityScore] : []);
  if (parts.length) d.investmentScore = { overall: r1(parts.reduce((a, b) => a + b, 0) / parts.length), factors: f };

  // one-year growth: the row's own quarterly history annualised (Square Yards publishes no multi-year series)
  let grew = false;
  if (quarters.length >= 2 && row.priceTrends && row.priceTrends.growth?.oneYear == null && quarters[0].price > 0) {
    const yrs = (quarters.length - 1) / 4; const oneYear = r1((Math.pow(quarters[quarters.length - 1].price / quarters[0].price, 1 / yrs) - 1) * 100);
    d.priceTrends = { ...row.priceTrends, growth: { ...(row.priceTrends.growth || {}), oneYear } }; grew = true;
  }
  const words = (t) => t.trim().split(/\s+/).length;
  const zone = o.zone ? o.zone.replace(/ Bangalore$/, '') : null;
  const first = [`${name} is a locality in ${zone ? zone + ' ' : ''}${row.city}${o.postal ? ` (PIN ${o.postal})` : ''}.`];
  if (o.rank?.length) first.push(`Square Yards ranks it ${o.rank[0]} of ${o.rank[1]} Bengaluru localities${overall ? `, with a resident rating of ${overall} out of 5` : ''}.`);
  const mid = [];
  if (done != null) mid.push(`The area has ${done} completed projects, ${uc} under construction and ${nl} new launches${o.stock ? `, and its housing stock includes ${o.stock}` : ''}.`);
  mid.push(`Apartment asking prices average about ${inr(ask)} per sq ft${row.minPricePerSqftPaise ? `, against ${inr(row.minPricePerSqftPaise / 100)} to ${inr(row.maxPricePerSqftPaise / 100)} in neighbouring localities` : ''}${g != null ? `, ${g >= 0 ? 'up' : 'down'} ${r1(Math.abs(g))}% over the last four quarters` : ''}.`);
  if (row.buyVsRent?.avgRentByBhk) mid.push(`Typical monthly rents are ${Object.entries(row.buyVsRent.avgRentByBhk).map(([k, v]) => `${inr(v)} for a ${k}`).join(', ')}${yld ? `, a rental yield of about ${yld}% a year` : ''}.`);
  else if (yld) mid.push(`Rental yield is about ${yld}% a year.`);
  const last = [];
  if (key.length) last.push(`Nearby places include ${key.slice(0, 4).map((x) => `${x.name} (${x.distance})`).join(', ')}.`);
  if (metro.length || roads.length) last.push(`Connectivity: ${[metro.length ? `Namma Metro ${lines.join(', ')} line` : '', roads.length ? roads.slice(0, 3).join(', ') : ''].filter(Boolean).join('; ')}.`);
  if (pros.length) last.push(`${fromPage ? 'Residents cite' : 'A plus:'} ${pros[0].replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.`);
  if (cons.length) last.push(`A common concern: ${cons[0].replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.`);
  last.push(`It suits ${d.bestFor.join(', ').toLowerCase()}.`);
  let about = [...first, ...mid, ...last].join(' ');
  if (words(about) < 80) about += ` Figures are Square Yards asking prices read in October 2026 and should be checked against recent registrations before a purchase, as individual projects can price well above or below the locality average.`;
  while (words(about) > 150 && last.length > 1) { last.splice(last.length - 2, 1); about = [...first, ...mid, ...last].join(' '); }
  d.about = about;
  const tail = { Emerging: 'a fast-growing area', Growth: 'a growing area', 'Mature Growth': 'an established, still-growing area', Mature: 'a settled, established area' }[d.marketStage] || 'a Bengaluru locality';
  const withD = d.rentalDemand ? `${tail} with ${d.rentalDemand.toLowerCase()} rental demand` : tail;
  d.headline = words(`${name}: ${withD}`) <= 10 ? `${name}: ${withD}` : words(`${name}: ${tail}`) <= 10 ? `${name}: ${tail}` : `${name}: ${d.marketStage || 'Bengaluru'} locality`;
  const faq = [
    { question: `What is the average property price in ${name}, Bengaluru?`, answer: `Apartment asking prices in ${name} average about ${inr(ask)} per sq ft (Square Yards, October 2026).` },
  ];
  if (row.buyVsRent?.avgRentByBhk) faq.push({ question: `What is the rent for a flat in ${name}?`, answer: `Typical monthly rents are ${Object.entries(row.buyVsRent.avgRentByBhk).map(([k, v]) => `${inr(v)} for a ${k}`).join(', ')}.` });
  if (yld) faq.push({ question: `What is the rental yield in ${name}?`, answer: `Rental yield in ${name} is about ${yld}% a year.` });
  if (overall) faq.push({ question: `Is ${name} a good area to live in?`, answer: `Residents rate ${name} ${overall} out of 5 on Square Yards${pros.length ? `. Often-cited positives: ${pros.slice(0, 2).join(' ')}` : '.'}` });
  if (mm.length) faq.push({ question: `Which localities are near ${name}?`, answer: `Nearby localities include ${mm.slice(0, 5).map((m) => `${m.name} (about ${inr(m.avgPricePerSqft)} per sq ft)`).join(', ')}.` });
  d.faqs = faq;
  d.localTruth = [{ note: `Ratings, pros and cons, nearby places and map position are from the Square Yards Locality Insights page for ${name}, read 27 Oct 2026. Rank, counts and prices are Square Yards figures.${grew ? ' One-year growth is the row\'s own quarterly price trend annualised; 3- and 5-year growth are not published by Square Yards.' : ''}`, source: o.url || 'Square Yards' }];
  return d;
}

async function main() {
  if (process.argv.includes('--restore')) {
    const s = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of s) { const { id, createdAt, updatedAt, ...rest } = r; await prisma.localityInsight.update({ where: { id }, data: { ...rest, dataAsOfDate: new Date(rest.dataAsOfDate) } }); }
    console.log('restored', s.length, 'rows'); return;
  }
  const apply = process.argv.includes('--apply');
  const data = { ...JSON.parse(fs.readFileSync(DATA, 'utf8')), ...(fs.existsSync(DATA2) ? JSON.parse(fs.readFileSync(DATA2, 'utf8')) : {}) };
  const saved = []; const counts = {}; const stillEmpty = {}; let rows = 0, miss = 0;
  for (const [slug, o] of Object.entries(data)) {
    if (!o || o.none) { console.log('no page data:', slug); miss++; continue; }
    const row = await prisma.localityInsight.findFirst({ where: { city: o.city === 'pune' ? 'Pune' : 'Bengaluru', locality: { equals: nameOf(slug), mode: 'insensitive' } } });
    if (!row) { console.log('no CMS row for', slug); miss++; continue; }
    const d = build(o, row); const grew = !!d.priceTrends; const patch = {};
    const ours = Array.isArray(row.localTruth) && /^Ratings, pros and cons, nearby places/.test(row.localTruth[0]?.note || '');
    for (const [k, v] of Object.entries(d)) { if (v === undefined) continue; if (empty(row[k]) || (ours && (k === 'headline' || k === 'about' || k === 'localTruth')) || (k === 'priceTrends' && grew)) { patch[k] = v; counts[k] = (counts[k] || 0) + 1; } }
    for (const k of ['headline', 'about', 'localityScore', 'marketStage', 'rentalDemand', 'infrastructureStrength', 'bestFor', 'medianPricePaise', 'priceChangeLastMonthPct', 'mapCenter', 'nearbyInfra', 'connectivity', 'faqs', 'prosAndCons', 'propertyMix', 'livability', 'keyInfrastructure', 'infrastructureProjects', 'investmentScore']) if (empty(row[k]) && empty(patch[k])) (stillEmpty[k] = stillEmpty[k] || []).push(row.locality);
    if (!Object.keys(patch).length) continue;
    rows++; saved.push(row);
    if (apply) await prisma.localityInsight.update({ where: { id: row.id }, data: patch });
  }
  console.log(`${rows} rows changed, ${miss} not matched${apply ? '' : ' (dry run)'}`);
  console.log('fields filled:', counts);
  console.log('still empty:', Object.fromEntries(Object.entries(stillEmpty).map(([k, v]) => [k, v.length + ': ' + v.slice(0, 6).join(', ')])));
  if (apply) { fs.writeFileSync(ROLLBACK, JSON.stringify(saved, null, 1)); console.log('rollback saved'); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
