/**
 * B9 — one-time index creation.
 *
 * MongoDB unique indexes treat null as a real value: a plain `@unique` on a
 * nullable `phone` field would reject the SECOND user with phone: null. This
 * script instead creates a PARTIAL unique index that only applies to
 * documents where phone is an actual string — exactly what we want, and not
 * expressible through Prisma's schema DSL for Mongo, hence a standalone script.
 *
 * Run once, after confirming there are no duplicate phones:
 *
 *   node scripts/createPhoneUniqueIndex.js           # dry run — reports duplicates only
 *   node scripts/createPhoneUniqueIndex.js --apply   # creates the index (fails loudly if duplicates exist)
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

async function main() {
  const duplicates = await prisma.user.groupBy({
    by: ['phone'],
    where: { phone: { not: null } },
    _count: { phone: true },
    having: { phone: { _count: { gt: 1 } } },
  });

  if (duplicates.length > 0) {
    console.error(`Found ${duplicates.length} duplicate phone number(s) — resolve these before creating the unique index:`);
    duplicates.forEach((d) => console.error(`  ${d.phone} — ${d._count.phone} users`));
    process.exitCode = 1;
    return;
  }

  console.log('No duplicate phone numbers found.');

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to create the index.');
    return;
  }

  await prisma.$runCommandRaw({
    createIndexes: 'User',
    indexes: [
      {
        key: { phone: 1 },
        name: 'phone_unique_partial',
        unique: true,
        partialFilterExpression: { phone: { $type: 'string' } },
      },
    ],
  });

  console.log('Partial unique index on phone created.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
