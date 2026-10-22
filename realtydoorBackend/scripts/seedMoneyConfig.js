/**
 * Money model Rev 3 (22 Oct 2026) — creates an editable PlatformConfig row for
 * every setting in src/modules/money/moneyConfig.js, so admin can find and
 * change them under GET /admin/config. The code works without these rows (it
 * falls back to the same defaults); this only makes them visible.
 *
 * WRITES TO THE DATABASE. Atlas is production: do not run without the
 * owner's approval. Only creates missing rows, never updates an existing one.
 *
 *   node scripts/seedMoneyConfig.js            # dry run, prints what it would create
 *   node scripts/seedMoneyConfig.js --apply    # creates the missing rows
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { DEFINITIONS } = require('../src/modules/money/moneyConfig');

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function run() {
  for (const [key, [value, description]] of Object.entries(DEFINITIONS)) {
    const existing = await prisma.platformConfig.findUnique({ where: { key } });
    if (existing) { console.log(`Skip   ${key} (exists: ${existing.value})`); continue; }
    if (!apply) { console.log(`Would create ${key} = ${value}`); continue; }
    await prisma.platformConfig.create({ data: { key, value: String(value), description, isPublic: false } });
    console.log(`Created ${key} = ${value}`);
  }
  if (!apply) console.log('\nDry run only. Re-run with --apply after approval.');
}

run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
