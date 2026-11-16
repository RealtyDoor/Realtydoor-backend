/**
 * Read-only: reports whether the three safety indexes that `prisma db push` does NOT create exist on the database in DATABASE_URL.
 * Audit Nov 2026 (O2). Run it against every new database (a fresh production Atlas has none of them) and after a restore.
 *
 *   node scripts/checkIndexes.js
 *
 * A missing one is created with its own script (dry run first, then --apply):
 *   escrow_active_lead_unique   -> node scripts/createEscrowLeadUniqueIndex.js
 *   phone_unique_partial        -> node scripts/createPhoneUniqueIndex.js
 *   email_unique_active_partial -> node scripts/createEmailUniqueIndex.js
 * Exit code 1 when any is missing, so a deploy step can stop on it.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const REQUIRED = [
  { collection: 'EscrowTransaction', name: 'escrow_active_lead_unique', why: 'one active token per inquiry' },
  { collection: 'User', name: 'phone_unique_partial', why: 'one account per phone number' },
  { collection: 'User', name: 'email_unique_active_partial', why: 'one active account per email' },
];

async function main() {
  let missing = 0;
  for (const r of REQUIRED) {
    // $indexStats returns just names and usage (listIndexes also returns partial filters that Prisma cannot read back).
    const out = await prisma.$runCommandRaw({ aggregate: r.collection, pipeline: [{ $indexStats: {} }, { $project: { name: 1 } }], cursor: {} });
    const have = (out?.cursor?.firstBatch || []).some((i) => i.name === r.name);
    console.log(`${have ? 'OK     ' : 'MISSING'} ${r.collection}.${r.name} (${r.why})`);
    if (!have) missing += 1;
  }
  if (missing) { console.error(`${missing} index(es) missing: create them before launch.`); process.exitCode = 1; }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
