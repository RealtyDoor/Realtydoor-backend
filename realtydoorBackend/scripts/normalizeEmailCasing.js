// One-off migration — lowercases every active User.email so the existing
// case-sensitive partial unique index (email_unique_active_partial) can
// actually do its job going forward. Confirmed bug: "Test@X.com" and
// "test@x.com" were treated as different values by both the signup
// duplicate pre-check and the DB index, letting the same real mailbox
// register twice. The code is now fixed to always normalize email to
// lowercase before writing (auth.validator.js's emailField,
// auth.service.js::syncUserByClerkId) — this one-time pass cleans up
// whatever was already stored with mixed case before that fix shipped.
//
// Safe to re-run — a row already lowercase is simply skipped. Checks for
// collisions first (two active rows that would normalize to the same
// value) and refuses to touch anything if any exist, same as
// canonicalizeCityNames.js's sibling script.
//
//   node scripts/normalizeEmailCasing.js           # dry run — reports what would change
//   node scripts/normalizeEmailCasing.js --apply   # applies the change
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const APPLY = process.argv.includes('--apply');

async function main() {
  const activeUsers = await prisma.user.findMany({
    where: { deletedAt: { isSet: false } },
    select: { id: true, email: true },
  });

  const byLower = {};
  for (const u of activeUsers) {
    const lower = (u.email || '').toLowerCase().trim();
    (byLower[lower] ||= []).push(u);
  }

  const collisions = Object.entries(byLower).filter(([, rows]) => rows.length > 1);
  if (collisions.length) {
    console.error(`Found ${collisions.length} email(s) that would collide after lowercasing — resolve these manually first:`);
    collisions.forEach(([lower, rows]) => console.error(`  "${lower}":`, rows.map((r) => `${r.id} (${r.email})`)));
    process.exitCode = 1;
    return;
  }

  const toFix = activeUsers.filter((u) => u.email !== u.email.toLowerCase().trim());
  if (!toFix.length) {
    console.log('No active user has a mixed-case email. Nothing to do.');
    return;
  }

  console.log(`${toFix.length} active user(s) have a mixed-case email:`);
  toFix.forEach((u) => console.log(`  ${u.id}: "${u.email}" -> "${u.email.toLowerCase().trim()}"`));

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to normalize them.');
    return;
  }

  for (const u of toFix) {
    await prisma.user.update({ where: { id: u.id }, data: { email: u.email.toLowerCase().trim() } });
  }
  console.log(`\nNormalized ${toFix.length} email(s).`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exitCode = 1; });
