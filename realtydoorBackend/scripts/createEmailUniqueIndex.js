/**
 * One-time index migration — replaces the plain `@unique` on User.email
 * (removed from the schema) with a PARTIAL unique index scoped to
 * deletedAt: null. A plain unique index would let a soft-deleted user's
 * email block that same person from ever signing up again; this index only
 * enforces uniqueness among active (non-deleted) rows, so two different
 * deletedAt-set rows — or a deleted row and a brand-new signup — can share
 * an email freely.
 *
 * partialFilterExpression: { deletedAt: null } — plain equality, not
 * { deletedAt: { $exists: false } } (MongoDB rejects $exists:false /
 * $not in a partial filter). Verified directly against this database:
 * raw Mongo equality-to-null already matches a MISSING field the same as
 * an explicit null, so this one predicate covers every existing row
 * (deletedAt is missing on all of them) and future soft-deletes alike.
 *
 * Run once, after confirming there are no duplicate ACTIVE emails:
 *
 *   node scripts/createEmailUniqueIndex.js           # dry run — reports duplicates only
 *   node scripts/createEmailUniqueIndex.js --apply   # creates the index (fails loudly if duplicates exist)
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

async function main() {
  const duplicates = await prisma.user.groupBy({
    by: ['email'],
    where: { deletedAt: { isSet: false } },
    _count: { email: true },
    having: { email: { _count: { gt: 1 } } },
  });

  if (duplicates.length > 0) {
    console.error(`Found ${duplicates.length} duplicate active email(s) — resolve these before creating the index:`);
    duplicates.forEach((d) => console.error(`  ${d.email} — ${d._count.email} users`));
    process.exitCode = 1;
    return;
  }

  console.log('No duplicate active emails found.');

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to create the index.');
    return;
  }

  await prisma.$runCommandRaw({
    createIndexes: 'User',
    indexes: [
      {
        key: { email: 1 },
        name: 'email_unique_active_partial',
        unique: true,
        partialFilterExpression: { deletedAt: null },
      },
    ],
  });

  console.log('Partial unique index on email (active rows only) created.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
