/**
 * Adds a bulk list of leads (first: the old Buildesk CRM export) to a TARGET database, into the qualification pool. Dry run unless --apply.
 *
 *   TARGET_DATABASE_URL="mongodb://..." node scripts/importBulkLeads.js --file "<xlsx>" --batch buildesk-2026-11
 *   TARGET_DATABASE_URL="..." node scripts/importBulkLeads.js --file <xlsx> --batch <name> --apply --confirm-host <host as printed>
 *   TARGET_DATABASE_URL="..." node scripts/importBulkLeads.js --rollback <batch> --apply --confirm-host <host>   (removes the batch's UNRELEASED leads)
 *
 * Safety (same as importRealLeads.js):
 *  - The target is ONLY TARGET_DATABASE_URL, never DATABASE_URL.
 *  - Nothing is written without --apply AND --confirm-host naming the target's host exactly.
 *  - Safe to run twice: a row already imported (same old reference) is skipped.
 *  - Writes straight with Prisma: no admin notification, WhatsApp or e-mail is ever sent.
 *  - createdAt = import time (NOT back-dated); the old date is originalLeadAt.
 * Take a mongodump of the target first. Atlas is production data. The file holds real people's details: never commit it.
 */
const path = require('path');
const ExcelJS = require('exceljs');
const { PrismaClient } = require('@prisma/client');
const { planBulk, toLeadData, BUILDESK, LIST_PRESET } = require('../src/lib/bulkLeads');

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes('--apply');
// --preset list --label "Electronic City list" --list-date 2026-03-10 : a plain contact list (Name, Contact Number, Email Id, City, Location).
const presetFor = (batch) => (arg('--preset') === 'list' ? LIST_PRESET({ id: batch, label: arg('--label') || batch, fileDate: arg('--list-date') }) : BUILDESK);

async function readRows(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(file));
  const ws = wb.worksheets[0];
  const head = ws.getRow(1).values.slice(1).map((h) => String(h || '').trim());
  const rows = [];
  ws.eachRow((r, i) => {
    if (i === 1) return;
    const v = r.values.slice(1);
    const o = {};
    head.forEach((h, k) => { o[h] = v[k]; });
    rows.push(o);
  });
  return rows;
}

const items0 = (plan) => plan.counts.total;
function printReport(plan, batch) {
  const { counts, skipped } = plan;
  console.log(`\nBatch ${batch}: ${counts.total} rows planned, ${skipped.length} skipped.`);
  console.log(`  Group A (strong signals, promote after review): ${counts.A}`);
  console.log(`  Group B (call first):                            ${counts.B}`);
  console.log(`  Group C (archive, kept):                         ${counts.C}`);
  console.log('Why (top reasons):');
  Object.entries(counts.byReason).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([r, n]) => console.log(`  ${String(n).padStart(6)}  ${r}`));
  console.log('Source:', JSON.stringify(counts.bySource));
  console.log('Sales stage:', JSON.stringify(counts.byStage));
  const reasons = skipped.reduce((a, s) => { a[s.reason] = (a[s.reason] || 0) + 1; return a; }, {});
  for (const [r, n] of Object.entries(reasons)) console.log(`  skipped ${n}: ${r}`);
}

async function main() {
  const url = process.env.TARGET_DATABASE_URL;
  if (!url && arg('--file') && !APPLY && !arg('--rollback')) { // offline dry run: reads only the file, touches no database
    const plan = planBulk(await readRows(arg('--file')), { preset: presetFor(arg('--batch') || 'dry-run'), batch: arg('--batch') || 'dry-run' });
    printReport(plan, arg('--batch') || 'dry-run');
    return console.log('\nOffline dry run (no database read). Set TARGET_DATABASE_URL to also check do-not-contact numbers and earlier imports.');
  }
  if (!url) throw new Error('Set TARGET_DATABASE_URL to the database that should receive the leads.');
  const host = url.replace(/^[a-z+]+:\/\/[^@]*@/, '').split('/')[0];
  const rollback = arg('--rollback');
  const file = arg('--file');
  const batch = arg('--batch');
  if (!rollback && (!file || !batch)) throw new Error('Give --file <xlsx> and --batch <name> (or --rollback <batch>).');
  console.log(`Target: ${host}   Mode: ${APPLY ? 'APPLY' : 'dry run'}`);
  if (APPLY && arg('--confirm-host') !== host) throw new Error(`--apply needs --confirm-host ${host} (exactly as printed above).`);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (rollback) {
      const where = { poolBatch: rollback, poolReleasedAt: { isSet: false } };
      const found = await prisma.lead.findMany({ where, select: { id: true } });
      console.log(`Would remove ${found.length} unreleased leads of batch ${rollback} (released leads are never removed).`);
      if (!APPLY) return console.log('Dry run: nothing was removed.');
      const ids = found.map((l) => l.id);
      await prisma.leadNote.deleteMany({ where: { leadId: { in: ids } } });
      const r = await prisma.lead.deleteMany({ where: { id: { in: ids } } });
      return console.log(`Removed ${r.count} leads.`);
    }
    const rows = await readRows(file);
    const [existing, dnc, everyone] = await Promise.all([
      prisma.lead.findMany({ where: { poolBatch: { isSet: true } }, select: { intakeAnswers: true } }),
      prisma.lead.findMany({ where: { doNotContactAt: { isSet: true } }, select: { buyerPhone: true } }),
      prisma.lead.findMany({ select: { buyerPhone: true } }),
    ]);
    const existingKeys = new Set(existing.map((l) => l.intakeAnswers && l.intakeAnswers.import_key).filter(Boolean));
    const plan = planBulk(rows, { preset: presetFor(batch), existingKeys, doNotContact: new Set(dnc.map((l) => l.buyerPhone)), knownPhones: new Set(everyone.map((l) => l.buyerPhone).filter(Boolean)), batch });
    printReport(plan, batch);
    if (!APPLY) return console.log('\nDry run: nothing was written. Add --apply --confirm-host <host> to write.');

    // Reserve ref codes in one block, in old-date order, so numbers follow the old order.
    if (arg('--sample')) { // a small, mixed sample (same share of each group) for checking on screen; the rest can be imported later (re-runs skip what exists)
      const n = Math.max(3, Number(arg('--sample')) || 300);
      const keep = [];
      for (const g of ['A', 'B', 'C']) keep.push(...plan.items.filter((i) => i.group === g).slice(0, Math.round(n / 3)));
      plan.items = keep;
      console.log(`Sample: importing ${keep.length} of ${items0(plan)} planned rows.`);
    }
    const items = [...plan.items].sort((a, b) => (a.originalLeadAt || 0) - (b.originalLeadAt || 0));
    const counter = await prisma.counter.upsert({ where: { id: 'lead' }, update: { seq: { increment: items.length } }, create: { id: 'lead', seq: items.length } });
    const first = counter.seq - items.length + 1;
    const priorByPhone = new Map();
    const phones = [...new Set(items.map((i) => i.phone).filter(Boolean))];
    for (let i = 0; i < phones.length; i += 500) {
      const prior = await prisma.lead.findMany({ where: { buyerPhone: { in: phones.slice(i, i + 500) } }, orderBy: { createdAt: 'desc' }, select: { id: true, buyerPhone: true } });
      for (const p of prior) if (!priorByPhone.has(p.buyerPhone)) priorByPhone.set(p.buyerPhone, p.id);
    }
    const primaryId = new Map(); // phone -> id of the callable (newest) lead of this batch
    let created = 0;
    const later = [];
    for (let n = 0; n < items.length; n += 1) {
      const it = items[n];
      const data = toLeadData(it, batch);
      data.refCode = `RD-L-${String(first + n).padStart(6, '0')}`;
      data.intakeAnswers = { ...data.intakeAnswers, import_key: it.key };
      let row;
      for (let attempt = 1; ; attempt += 1) { // the cloud database sometimes times out a write: try again, never twice for one lead (the key is checked first)
        try { row = await prisma.lead.create({ data, select: { id: true } }); break; } catch (e) {
          if (attempt >= 4) throw e;
          const again = await prisma.lead.findFirst({ where: { refCode: data.refCode }, select: { id: true } });
          if (again) { row = again; break; }
        }
      }
      created += 1;
      if (it.notes.length) await prisma.leadNote.createMany({ data: it.notes.map((nt) => ({ ...nt, leadId: row.id, createdAt: nt.createdAt || undefined })) });
      if (it.phone && it.group !== 'C') primaryId.set(it.phone, row.id);
      later.push({ id: row.id, phone: it.phone, group: it.group, reason: it.reason });
      if (created % 1000 === 0) console.log(`  ... ${created}`);
    }
    // Link repeat buyers: an older duplicate points at the callable lead; the callable lead points at an earlier live lead (if any).
    let linked = 0;
    for (const l of later) {
      const target = l.group === 'C' && /duplicate/i.test(l.reason) ? primaryId.get(l.phone) : priorByPhone.get(l.phone);
      if (target && target !== l.id) { await prisma.lead.update({ where: { id: l.id }, data: { relatedLeadId: target } }); linked += 1; }
    }
    console.log(`Added ${created} leads to the pool (ref codes from RD-L-${String(first).padStart(6, '0')}), linked ${linked} repeat buyers.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
