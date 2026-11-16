/**
 * Writes the real leads of a database to a JSON file, for moving them to production (audit Nov 2026, go-live prep).
 * Reads only; changes nothing. See src/lib/leadTransfer.js for what "real" means.
 *
 *   node scripts/exportRealLeads.js                       # reads DATABASE_URL from .env, writes exports/real-leads-<date>.json
 *   node scripts/exportRealLeads.js --out /path/file.json
 *   node scripts/exportRealLeads.js --list                # only prints what would be exported and what is left out and why
 *
 * The file holds real people's names, phones and emails: keep it private (exports/ is git-ignored), move it only over a secure
 * channel, and delete it after the import.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { FORMAT, whyNotReal, toRecord } = require('../src/lib/leadTransfer');

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const LIST_ONLY = process.argv.includes('--list');

async function main() {
  const prisma = new PrismaClient();
  const host = (process.env.DATABASE_URL || '').replace(/^[a-z+]+:\/\/[^@]*@/, '').split('/')[0];
  console.log(`Reading from ${host}`);
  const [leads, escrows, props] = await Promise.all([
    prisma.lead.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.escrowTransaction.findMany({ select: { leadId: true } }),
    prisma.property.findMany({ select: { id: true, title: true, slug: true } }),
  ]);
  const escrowed = new Set(escrows.map((e) => e.leadId));
  const propById = new Map(props.map((p) => [p.id, p]));

  const records = [];
  const left = {};
  for (const lead of leads) {
    const prop = propById.get(lead.propertyId);
    const why = whyNotReal(lead, { hasEscrow: escrowed.has(lead.id), propertyTitle: prop?.title });
    if (why) { left[why] = (left[why] || 0) + 1; continue; }
    records.push(toRecord(lead, prop.slug));
  }
  console.log(`${leads.length} leads in the database: ${records.length} real, ${leads.length - records.length} left out.`);
  for (const [why, n] of Object.entries(left).sort((a, b) => b[1] - a[1])) console.log(`  left out: ${String(n).padStart(3)}  ${why}`);
  const bySlug = records.reduce((a, r) => { a[r.propertySlug] = (a[r.propertySlug] || 0) + 1; return a; }, {});
  console.log('Listings the real leads point to (they must exist in the target, by slug):');
  for (const [slug, n] of Object.entries(bySlug)) console.log(`  ${String(n).padStart(3)}  ${slug}`);
  if (!LIST_ONLY) {
    const out = path.resolve(arg('--out') || path.join(__dirname, '..', 'exports', `real-leads-${new Date().toISOString().slice(0, 10)}.json`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ format: FORMAT, exportedAt: new Date().toISOString(), count: records.length, leads: records }, null, 2), { mode: 0o600 });
    console.log(`Wrote ${records.length} leads to ${out} (private: real people's details).`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
