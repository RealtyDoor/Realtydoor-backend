/**
 * Dev feedback, 2026-10-08 — escrow.service.js's createOrder() reads two
 * new PlatformConfig keys via getConfigNumber(key, default). Same
 * discoverability gap as scripts/seedEscrowFeeConfig.js: until a row
 * exists, GET /admin/config has nothing to show, so admin can't find or
 * edit these without already knowing the exact key string.
 *
 * Run once:
 *
 *   node scripts/seedEscrowCapConfig.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SEEDS = [
  {
    key: 'escrow_max_pct_of_price',
    value: '10',
    description: 'Maximum escrow (token advance) amount, as a % of the deal price (dealPriceAtLock, else the listing price). Dev feedback 2026-10-08.',
  },
  {
    key: 'escrow_refund_protection_fee_pct',
    value: '0',
    description: '"Refund protection fee" shown at checkout, as a % of the escrow amount. Default 0 — genuinely free today, not a placeholder. Dev feedback 2026-10-08.',
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
