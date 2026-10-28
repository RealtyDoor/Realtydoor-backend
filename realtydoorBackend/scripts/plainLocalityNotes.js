// Rewrites the ESTIMATE:/DERIVED: localTruth notes so they name fields in plain words instead of database keys.
// Dry run by default; --apply writes (rollback saved in backups/); --restore puts the saved notes back.
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const restore = process.argv.includes('--restore');
const ROLLBACK = require('path').resolve(__dirname, '../../../backups/locality-genericnotes-rollback-2026-10-28.json');

const LABELS = {
  'priceTrends.growth (1/3/5-year; 3 and 5-year compound the 1-year, capped 2 to 14 percent a year)': 'price growth over 1, 3 and 5 years (the 3 and 5-year figures compound the 1-year change, capped at 2 to 14 percent a year)',
  'connectivity (airport distance added)': 'airport distance',
  propertyMix: 'property mix',
  medianPricePaise: 'median price',
  medianPricePropertyType: 'median price property type',
  priceChangeLastMonthPct: 'last-month price change',
  infrastructureProjects: 'infrastructure projects',
  livability: 'livability ratings',
  microMarkets: 'micro-markets',
  avgRentPerMonthPaise: 'average rent',
  buyVsRent: 'buy vs rent',
  localityScore: 'locality score',
  avgRentYieldPct: 'rental yield',
  rentalDemand: 'rental demand',
  connectivity: 'connectivity',
  subtitle: 'subtitle',
  prosAndCons: 'pros and cons',
  lastReviewedBy: 'reviewed-by line',
  mapCenter: 'map position',
  infrastructureStrength: 'infrastructure rating',
  marketStage: 'market stage',
  bestFor: 'best-for tags',
  investmentScore: 'investment score',
  faqs: 'FAQs',
  keyInfrastructure: 'key places nearby',
  nearbyInfra: 'nearby places',
  headline: 'headline',
  about: 'about text',
};
const GROWTH = 'priceTrends.growth (1/3/5-year; 3 and 5-year compound the 1-year, capped 2 to 14 percent a year)';
const labelsIn = (note, kind) => {
  const body = note.replace(/^(ESTIMATE|DERIVED): /, '').split(/ were (?:not available|calculated)/)[0];
  const out = [];
  if (body.includes(GROWTH)) out.push('price growth over 1, 3 and 5 years');
  const rest = body.split(GROWTH).join('').split(/; |, /).map((x) => x.trim()).filter(Boolean);
  for (const k of rest) out.push(LABELS[k] || k);
  return out;
};
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
const join = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0]);
const GENERIC = 'Some figures on this report are tentative estimates or approximate calculations, because published sources were not available for them. Please do your own research before relying on them.';
const SOURCE = 'RealtyDoor research estimate, 28 Oct 2026';
const rebuild = (lt) => {
  const keep = lt.filter((t) => !/^(ESTIMATE|DERIVED):/.test(t.note || '') && t.note !== GENERIC);
  keep.push({ note: GENERIC, source: SOURCE });
  return keep;
};

async function main() {
  if (restore) {
    for (const r of JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'))) await prisma.localityInsight.update({ where: { id: r.id }, data: { localTruth: r.localTruth } });
    console.log('restored'); return;
  }
  const rows = await prisma.localityInsight.findMany({ select: { id: true, locality: true, localTruth: true } });
  const changes = [];
  for (const r of rows) {
    const lt = Array.isArray(r.localTruth) ? r.localTruth : [];
    const next = rebuild(lt);
    if (lt.some((t) => /^(ESTIMATE|DERIVED):/.test(t.note || '') || t.note === GENERIC)) changes.push({ id: r.id, locality: r.locality, localTruth: lt, next });
  }
  console.log(`${changes.length} rows would change${apply ? '' : ' (dry run)'}`);
  const s = changes[0]; if (s) console.log(s.locality, JSON.stringify(s.next.filter((t) => /^(ESTIMATE|DERIVED)/.test(t.note)), null, 1));
  if (apply) {
    fs.writeFileSync(ROLLBACK, JSON.stringify(changes.map(({ id, locality, localTruth }) => ({ id, locality, localTruth })), null, 1));
    for (const c of changes) await prisma.localityInsight.update({ where: { id: c.id }, data: { localTruth: c.next } });
    console.log('rollback saved and rows written');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
