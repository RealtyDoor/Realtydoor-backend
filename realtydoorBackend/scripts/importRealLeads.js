/**
 * Adds the leads from an export file (scripts/exportRealLeads.js) to a TARGET database. Dry run unless --apply.
 *
 *   TARGET_DATABASE_URL="mongodb+srv://..." node scripts/importRealLeads.js --file exports/real-leads-2026-11-16.json
 *   TARGET_DATABASE_URL="..." node scripts/importRealLeads.js --file <file> --apply --confirm-host <host as printed>
 *
 * Safety:
 *  - The target is ONLY TARGET_DATABASE_URL, never the DATABASE_URL in .env, so a forgotten setting cannot aim it at the wrong database.
 *  - Nothing is written without --apply AND --confirm-host naming the target's host exactly.
 *  - Safe to run twice: a lead already in the target (same ref code or same Meta lead id) is skipped.
 *  - Each lead is matched to its listing by slug; a lead whose listing is not in the target is skipped and listed.
 *  - Keeps ref codes and dates, and moves the "lead" counter up to the highest imported number so new leads never reuse a ref code.
 * Take a mongodump of the target first. Atlas is production data.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { FORMAT, planImport, metaLeadId } = require('../src/lib/leadTransfer');

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes('--apply');

async function main() {
  const url = process.env.TARGET_DATABASE_URL;
  if (!url) throw new Error('Set TARGET_DATABASE_URL to the database that should receive the leads.');
  const file = arg('--file');
  if (!file) throw new Error('Give the export file with --file.');
  const doc = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (doc.format !== FORMAT || !Array.isArray(doc.leads)) throw new Error(`Not a ${FORMAT} file.`);
  const host = url.replace(/^[a-z+]+:\/\/[^@]*@/, '').split('/')[0];
  console.log(`Target: ${host}   File: ${doc.count} leads exported ${doc.exportedAt}   Mode: ${APPLY ? 'APPLY' : 'dry run'}`);
  if (APPLY && arg('--confirm-host') !== host) throw new Error(`--apply needs --confirm-host ${host} (exactly as printed above).`);

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const slugs = [...new Set(doc.leads.map((l) => l.propertySlug))];
    const [listings, existing] = await Promise.all([
      prisma.property.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } }),
      prisma.lead.findMany({ select: { refCode: true, intakeAnswers: true } }),
    ]);
    const plan = planImport(doc.leads, {
      listingsBySlug: new Map(listings.map((l) => [l.slug, l])),
      existingRefCodes: new Set(existing.map((l) => l.refCode).filter(Boolean)),
      existingMetaIds: new Set(existing.map(metaLeadId).filter(Boolean)),
    });
    console.log(`Would add ${plan.toCreate.length} leads; skip ${plan.skipped.length}.`);
    const reasons = plan.skipped.reduce((a, s) => { a[s.reason] = (a[s.reason] || 0) + 1; return a; }, {});
    for (const [r, n] of Object.entries(reasons)) console.log(`  skip: ${String(n).padStart(3)}  ${r}`);
    console.log(`Lead counter would be raised to at least ${plan.maxRef} (new leads continue after it).`);
    if (!APPLY) { console.log('Dry run: nothing was written. Add --apply --confirm-host <host> to write.'); return; }

    let created = 0;
    for (const { data } of plan.toCreate) {
      try { await prisma.lead.create({ data }); created += 1; } catch (e) {
        if (e.code === 'P2002') console.log(`  skipped ${data.refCode}: already exists`); else throw e;
      }
    }
    const counter = await prisma.counter.findUnique({ where: { id: 'lead' } });
    const seq = Math.max(counter?.seq || 0, plan.maxRef);
    await prisma.counter.upsert({ where: { id: 'lead' }, update: { seq }, create: { id: 'lead', seq } });
    console.log(`Added ${created} leads. Lead counter is now ${seq}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
