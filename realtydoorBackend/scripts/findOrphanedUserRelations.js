// Diagnostic — scans every model with a required (non-optional) relation to
// User for rows whose foreign key points at a user that no longer exists.
// Read-only, reports only; fixes nothing.
//
// Why this matters: a required Prisma relation on MongoDB has no FK
// enforcement at the DB level, so a hard `prisma.user.delete()` (bypassing
// the soft-delete-only convention this codebase relies on — see
// User.deletedAt's own comment, and clerk.handler.js's user.deleted
// handler) leaves a dangling reference that any `include`/nested `select`
// on that relation 500s on with "Inconsistent query result". Confirmed
// live, 2026-10-12: 27 of 59 properties, plus rows across five other
// models, orphaned by (at least) five separate historical hard-deletes —
// this is what found them. Several read paths that `include`d a now-
// orphaned relation were fixed the same day (fetch the relation
// separately, degrade to null instead of throwing) — this script is for
// re-checking the data side after fixing (or before fixing) the code side
// for any relation not already covered.
//
//   node scripts/findOrphanedUserRelations.js
require('dotenv').config();
const prisma = require('../src/lib/prisma');

// Every model with a required (non-optional) relation to User, per the schema.
const CHECKS = [
  { model: 'property', fkField: 'partnerId' },
  { model: 'favorite', fkField: 'userId' },
  { model: 'loanApplication', fkField: 'userId' },
  { model: 'userDocument', fkField: 'userId' },
  { model: 'notification', fkField: 'userId' },
  { model: 'propertyReview', fkField: 'userId' },
  { model: 'userSubscription', fkField: 'userId' },
  { model: 'serviceTicket', fkField: 'userId' },
  { model: 'videoTourRequest', fkField: 'userId' },
  { model: 'dispute', fkField: 'userId' },
  { model: 'partnerSupportTicket', fkField: 'partnerId' },
  { model: 'propertyChangeRequest', fkField: 'partnerId' },
  { model: 'partnerDataAcknowledgment', fkField: 'partnerId' },
  { model: 'partnerCommissionOverride', fkField: 'partnerId' },
  { model: 'advisorReferral', fkField: 'advisorId' },
  { model: 'project', fkField: 'builderId' },
  { model: 'builderInvoice', fkField: 'builderId' },
  { model: 'b2BConnection', fkField: 'listingPartnerId' },
  { model: 'b2BConnection', fkField: 'buyerPartnerId' },
  { model: 'exclusiveMandate', fkField: 'partnerId' },
];

async function main() {
  const userCache = new Map();
  async function userExists(id) {
    if (!id) return true; // null FK is fine, not our concern here
    if (userCache.has(id)) return userCache.get(id);
    const u = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    userCache.set(id, !!u);
    return !!u;
  }

  let totalOrphans = 0;
  for (const { model, fkField } of CHECKS) {
    if (!prisma[model]) { console.log(`SKIP ${model} — not a valid Prisma model name`); continue; }
    const rows = await prisma[model].findMany({ select: { id: true, [fkField]: true } });
    const orphans = [];
    for (const r of rows) {
      if (!(await userExists(r[fkField]))) orphans.push(r.id);
    }
    totalOrphans += orphans.length;
    console.log(`${model}.${fkField}: ${rows.length} rows, ${orphans.length} orphaned${orphans.length ? ' -> ' + orphans.slice(0, 5).join(', ') + (orphans.length > 5 ? ' ...' : '') : ''}`);
  }
  console.log('\nTotal orphaned rows across all models:', totalOrphans);
  console.log('Distinct dangling user ids found:', [...userCache.entries()].filter(([, exists]) => !exists).map(([id]) => id));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
