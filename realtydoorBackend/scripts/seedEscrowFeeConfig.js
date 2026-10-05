/**
 * backend-work-still-open.md #1 — escrow.service.js's release()/
 * getReleasePlan() read the platform's cost-recovery fee rate and the
 * partner-share rate via getConfigNumber('escrow_platform_fee_pct', 1) /
 * getConfigNumber('escrow_partner_share_pct', 2). Those defaults work fine
 * at the code level, but until a PlatformConfig row actually exists for
 * each key, admin has no way to discover or edit them from
 * GET /admin/config — that endpoint only lists rows that exist, and
 * nothing ever creates one for a key that's only ever read through a
 * fallback. This is a one-time seed of real, editable rows at today's
 * defaults; same gap, same fix shape as PUBLIC_CONFIG_DEFAULTS in
 * config.service.js covers for public keys.
 *
 * Run once:
 *
 *   node scripts/seedEscrowFeeConfig.js
 *
 * Safe to re-run — upsert, and does nothing to a key an admin has already
 * edited (ON CONFLICT would overwrite their value, so this only CREATEs,
 * never UPDATEs, an existing row).
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SEEDS = [
  {
    key: 'escrow_platform_fee_pct',
    value: '1',
    description: 'Platform cost-recovery fee (R), as a % of the held escrow amount (B), retained at release and never paid out — backend-work-still-open.md #1.',
  },
  {
    key: 'escrow_partner_share_pct',
    value: '2',
    description: 'Partner share (Pi), as a % of the held escrow amount (B), shown on GET /admin/escrow/:id/release-plan for display/headroom. Does not by itself trigger a payout — PATCH .../release still only pays it out when partnerShare is explicitly passed.',
  },
];

async function run() {
  for (const seed of SEEDS) {
    const existing = await prisma.platformConfig.findUnique({ where: { key: seed.key } });
    if (existing) {
      console.log(`Skipped ${seed.key} — already exists (value: ${existing.value})`);
      continue;
    }
    await prisma.platformConfig.create({ data: { ...seed, isPublic: false } });
    console.log(`Created ${seed.key} = ${seed.value}`);
  }
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
