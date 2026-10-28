/**
 * Loads locality data collected by Cowork (JSON files in admin-nextjs/docs/qa/inbox-localities/, format in
 * admin-nextjs/docs/qa/COWORK_LOCALITY_DATA_PROMPT.md) into the locality CMS. It checks every object first and skips what fails.
 *   - a locality with no row is created (needs avgPricePerSqft)
 *   - a locality with a row only gets its EMPTY fields filled; nothing already there is overwritten
 *   - a field group marked "conflict" (sources disagree by more than 15%) is skipped and listed
 *
 *   node scripts/loadLocalityInbox.js            # dry run: validation report and what would change
 *   node scripts/loadLocalityInbox.js --apply    # saves old documents and created ids to the rollback file, then writes
 *   node scripts/loadLocalityInbox.js --restore  # undoes the last --apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const INBOX = path.resolve(__dirname, '../../../admin-nextjs/docs/qa/inbox-localities');
const ROLLBACK = path.resolve(__dirname, '../../../backups/locality-inbox-rollback.json');
const SOURCES_OUT = path.resolve(__dirname, '../../../admin-nextjs/docs/qa/LOCALITY_SOURCES.md');
const AS_OF = new Date();
const prisma = new PrismaClient();

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const empty = (v) => v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
const slug = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

function check(o) {
  const problems = [];
  if (!o || !o.locality || !o.city) problems.push('missing locality or city');
  const avg = num(o.avgPricePerSqft);
  if (avg !== null && (avg < 500 || avg > 300000)) problems.push(`avg price ${avg} out of range`);
  for (const k of ['minPricePerSqft', 'maxPricePerSqft']) if (o[k] != null && num(o[k]) === null) problems.push(`${k} not a number`);
  if (num(o.minPricePerSqft) && num(o.maxPricePerSqft) && o.minPricePerSqft > o.maxPricePerSqft) problems.push('min above max');
  if (!Array.isArray(o.sources) || o.sources.length === 0) problems.push('no source named');
  for (const [k, v] of Object.entries(o.ratings || {})) if (v != null && (num(v) === null || v < 0 || v > 10)) problems.push(`rating ${k} must be 0 to 10`);
  return problems;
}

function build(o) {
  const skipped = [];
  const conflict = (g) => o.conflict && (o.conflict === true || o.conflict[g] != null);
  const d = {};
  const avg = num(o.avgPricePerSqft);
  if (avg && !conflict('avgPricePerSqft')) d.avgPricePerSqftPaise = Math.round(avg * 100); else if (conflict('avgPricePerSqft')) skipped.push('price');
  if (num(o.minPricePerSqft) && !conflict('minPricePerSqft')) d.minPricePerSqftPaise = Math.round(o.minPricePerSqft * 100);
  if (num(o.maxPricePerSqft) && !conflict('maxPricePerSqft')) d.maxPricePerSqftPaise = Math.round(o.maxPricePerSqft * 100);
  const hist = (o.priceHistory || []).filter((h) => h && h.period && num(h.price));
  const g = o.growthPct || {};
  const growth = {}; for (const k of ['oneYear', 'threeYear', 'fiveYear']) if (num(g[k]) !== null) growth[k] = g[k];
  if ((hist.length || Object.keys(growth).length) && !conflict('priceHistory')) d.priceTrends = { ...(hist.length ? { historical: hist } : {}), ...(Object.keys(growth).length ? { growth } : {}) };
  const rent = {}; for (const [k, v] of Object.entries(o.rentByBhk || {})) if (num(v)) rent[k] = v;
  const y = num(o.rentalYieldPct);
  if (y !== null) d.avgRentYieldPct = y;
  if (Object.keys(rent).length || y !== null) d.buyVsRent = { ...(Object.keys(rent).length ? { avgRentByBhk: rent } : {}), ...(y !== null ? { rentalYieldPct: y } : {}) };
  if (rent['2BHK']) d.avgRentPerMonthPaise = Math.round(rent['2BHK'] * 100);
  const mm = (o.microMarkets || []).filter((m) => m && m.name && num(m.avgPricePerSqft)).map((m) => ({ name: m.name, avgPricePerSqft: m.avgPricePerSqft }));
  if (mm.length) d.microMarkets = mm;
  const mix = (o.propertyMix || []).filter((m) => m && m.type && num(m.count) !== null);
  const total = mix.reduce((a, m) => a + m.count, 0);
  if (total > 0) d.propertyMix = mix.map((m) => ({ type: m.type, percentage: Math.round((m.count / total) * 1000) / 10, count: m.count }));
  const live = {}; for (const [k, v] of Object.entries(o.ratings || {})) if (num(v) !== null) live[k] = v;
  if (Object.keys(live).length) d.livability = live;
  if ((o.pros || []).length || (o.cons || []).length) d.prosAndCons = { pros: o.pros || [], cons: o.cons || [] };
  const proj = (o.upcomingProjects || []).filter((p) => p && p.name).map((p) => ({ name: p.name, category: p.category || 'Other', status: p.status || 'Planned', year: num(p.year) ?? undefined, impact: 'Medium' }));
  if (proj.length) d.infrastructureProjects = proj;
  return { d, skipped };
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
  if (!fs.existsSync(INBOX)) { console.log('no inbox folder yet:', INBOX); return; }
  const files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.json')).sort();
  const objs = []; for (const f of files) { try { const j = JSON.parse(fs.readFileSync(path.join(INBOX, f), 'utf8')); (Array.isArray(j) ? j : [j]).forEach((o) => objs.push({ o, f })); } catch (e) { console.log('UNREADABLE', f, e.message); } }
  console.log(`${files.length} files, ${objs.length} localities`);
  const changed = []; const created = []; const sourcesLog = []; let bad = 0, made = 0, filled = 0, noop = 0;
  for (const { o, f } of objs) {
    const problems = check(o);
    if (problems.length) { bad++; console.log(`SKIP ${o && o.locality} (${f}): ${problems.join('; ')}`); continue; }
    const { d, skipped } = build(o);
    const row = await prisma.localityInsight.findFirst({ where: { city: { equals: o.city === 'Bengaluru' ? 'Bengaluru' : o.city }, locality: { equals: o.locality, mode: 'insensitive' } } });
    sourcesLog.push(`- ${o.city} | ${o.locality}: ${(o.sources || []).map((s) => `${s.site} ${s.url || ''} (${s.readOn || ''})`).join('; ')}${skipped.length ? ' | skipped: ' + skipped.join(',') : ''}${o.conflict ? ' | CONFLICT noted' : ''}`);
    if (!row) {
      if (!d.avgPricePerSqftPaise) { bad++; console.log(`SKIP ${o.locality}: new row needs an average price`); continue; }
      made++; console.log(`NEW  ${o.city} | ${o.locality}: avg ${d.avgPricePerSqftPaise / 100}, ${Object.keys(d).length} fields`);
      if (apply) { const r = await prisma.localityInsight.create({ data: { city: o.city, locality: o.locality, nearbyInfra: [], bestFor: [], lastReviewedBy: 'RealtyDoor research team', dataAsOfDate: AS_OF, ...d } }); created.push(r.id); }
      continue;
    }
    const patch = {};
    for (const [k, v] of Object.entries(d)) {
      if (k === 'priceTrends') { const cur = row.priceTrends || {}; const merged = { ...cur }; if (v.historical && empty(cur.historical)) merged.historical = v.historical; if (v.growth) merged.growth = { ...v.growth, ...(cur.growth || {}) }; if (JSON.stringify(merged) !== JSON.stringify(cur)) patch.priceTrends = merged; }
      else if (k === 'buyVsRent') { const cur = row.buyVsRent || {}; const merged = { ...cur }; for (const [a, b] of Object.entries(v)) if (empty(cur[a])) merged[a] = b; if (JSON.stringify(merged) !== JSON.stringify(cur)) patch.buyVsRent = merged; }
      else if (k === 'avgPricePerSqftPaise' || k === 'minPricePerSqftPaise' || k === 'maxPricePerSqftPaise') { if (row[k] == null) patch[k] = v; }
      else if (empty(row[k])) patch[k] = v;
    }
    if (!Object.keys(patch).length) { noop++; continue; }
    filled++; console.log(`FILL ${row.city} | ${row.locality}: ${Object.keys(patch).join(', ')}`);
    changed.push(row);
    if (apply) await prisma.localityInsight.update({ where: { id: row.id }, data: patch });
  }
  console.log(`${bad} skipped, ${made} new, ${filled} filled, ${noop} nothing to add${apply ? '' : ' (dry run)'}`);
  if (apply) {
    fs.writeFileSync(ROLLBACK, JSON.stringify({ changed, created }, null, 1));
    fs.writeFileSync(SOURCES_OUT, `# Sources of locality data loaded from the inbox\n\n${sourcesLog.join('\n')}\n`);
    console.log('rollback saved; sources written to docs/qa/LOCALITY_SOURCES.md');
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
