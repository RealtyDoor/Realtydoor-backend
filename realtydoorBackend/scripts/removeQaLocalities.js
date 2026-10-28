/**
 * Removes the QA test rows from the locality CMS: the "QA Layout" report and the two pending QA suggestions.
 * The removed documents are saved first; --restore puts them back. Nothing else is touched.
 *
 *   node scripts/removeQaLocalities.js            # dry run
 *   node scripts/removeQaLocalities.js --apply
 *   node scripts/removeQaLocalities.js --restore
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const SAVED = path.resolve(__dirname, '../../../backups/qa-localities-removed-2026-10-27.json');
const prisma = new PrismaClient();

async function main() {
  if (process.argv.includes('--restore')) {
    const s = JSON.parse(fs.readFileSync(SAVED, 'utf8'));
    for (const r of s.insights) { const { id, createdAt, updatedAt, dataAsOfDate, ...rest } = r; await prisma.localityInsight.create({ data: { ...rest, id, dataAsOfDate: new Date(dataAsOfDate) } }); }
    for (const r of s.suggestions) { const { id, createdAt, resolvedAt, ...rest } = r; await prisma.localitySuggestion.create({ data: { ...rest, id } }); }
    console.log('restored', s.insights.length, 'reports and', s.suggestions.length, 'suggestions');
    return;
  }
  const insights = await prisma.localityInsight.findMany({ where: { OR: [{ locality: { contains: 'QA' } }] } });
  const suggestions = await prisma.localitySuggestion.findMany({ where: { OR: [{ locality: { contains: 'QA' } }] } });
  console.log('reports   :', insights.map((r) => `${r.city} | ${r.locality}`));
  console.log('suggestions:', suggestions.map((r) => `${r.city} | ${r.locality} (${r.status})`));
  if (process.argv.includes('--apply')) {
    fs.writeFileSync(SAVED, JSON.stringify({ insights, suggestions }, null, 1));
    await prisma.localityInsight.deleteMany({ where: { id: { in: insights.map((r) => r.id) } } });
    await prisma.localitySuggestion.deleteMany({ where: { id: { in: suggestions.map((r) => r.id) } } });
    console.log('removed; copies saved to', SAVED);
  } else console.log('(dry run: nothing removed)');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
