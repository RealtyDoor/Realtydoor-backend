/**
 * backend-gaps-frontend-integration.md #1 — commission.service.js's R
 * calculation (the platform's gateway-cost-recovery retainage on the
 * brokerage fee) reads four PlatformConfig keys via getConfigNumber/
 * getConfigValue(key, 0-ish default). Same discoverability gap as
 * scripts/seedEscrowFeeConfig.js: until a row exists, GET /admin/config
 * has nothing to show, so admin can't find or edit these without already
 * knowing the exact key string.
 *
 * All four seed at a safe 0/false — a genuine no-op, not a guessed real
 * rate (there is no safe non-zero default here; the real Razorpay/
 * RazorpayX schedule is still needed, see section 8 of the handoff doc).
 * default_fee_pct/default_partner_share_pct are deliberately NOT seeded
 * here — "Admin sets every percentage" means there is no safe assumed
 * value for the brokerage fee % or the default partner share, so those
 * two stay unset until admin deliberately configures them.
 *
 * Run once:
 *
 *   node scripts/seedCommissionGatewayConfig.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SEEDS = [
  {
    key: 'commission_gateway_collection_pct',
    value: '0',
    description: 'Razorpay collection charge, as a % of the brokerage fee (B). Part of R — backend-gaps-frontend-integration.md #1. Still needs the real schedule (section 8).',
  },
  {
    key: 'commission_gateway_payout_pct',
    value: '0',
    description: 'RazorpayX payout/transfer charge, as a % of the brokerage fee (B). Part of R. Still needs the real schedule (section 8).',
  },
  {
    key: 'commission_gateway_gst_pct',
    value: '0',
    description: 'GST %, applied to the collection + payout charges above when input credit is not claimed.',
  },
  {
    key: 'commission_gateway_gst_input_credit',
    value: 'false',
    description: '"true" or "false". Whether GST on gateway charges is claimed as input credit (so excluded from R) — open with the accountant, see section 1 of the handoff doc.',
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
