/**
 * BE-13 — default_fee_pct / default_partner_share_pct, read via
 * getConfigNumber(key, null) in commission.service.js's previewTermsForLead
 * and setLeadTerms. Until either is seeded, a lead with no matching rate
 * card has nothing to fall back to and setLeadTerms refuses with the coded
 * 400s FEE_PCT_REQUIRED / PARTNER_SHARE_PCT_REQUIRED (city + sellerType in
 * the error data) rather than guessing a number.
 *
 * SEEDS is deliberately empty — same precedent as
 * scripts/seedCommissionGatewayConfig.js's own four gateway-cost keys: there
 * is no safe assumed brokerage fee % or partner default share %, so this
 * stays a no-op until the business gives real figures to fill in below.
 * Also seed a baseline RateCard per launch city + seller type once those
 * figures exist (see commission.controller.js's createRateCard) — the
 * platform-wide defaults here are the fallback for a city/sellerType that
 * has no rate card of its own, not a substitute for having real rate cards.
 *
 * Run once (after filling in SEEDS):
 *
 *   node scripts/seedDefaultFeeRates.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SEEDS = [
  // { key: 'default_fee_pct', value: '<business-confirmed %>', description: 'Platform-wide default brokerage fee %, used when a lead\'s city/sellerType has no rate card of its own.' },
  // { key: 'default_partner_share_pct', value: '<business-confirmed %>', description: 'Platform-wide default CLOSING_AGENT share % of the fee, used the same way as default_fee_pct.' },
];

async function run() {
  if (SEEDS.length === 0) {
    console.log('SEEDS is empty — fill in default_fee_pct/default_partner_share_pct above once the business confirms real values, then re-run.');
    return;
  }
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
