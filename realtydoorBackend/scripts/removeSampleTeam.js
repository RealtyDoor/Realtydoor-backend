/**
 * T50 — removes the three sample team members that earlier seeds created (they are not real people, and the public About
 * page reads the team table).
 *
 *   node scripts/removeSampleTeam.js           # dry run: lists what would be removed
 *   node scripts/removeSampleTeam.js --apply   # deletes them
 */
const SAMPLE_EMAILS = ['vikram@realtydoor.com', 'shreya@realtydoor.com', 'arun@realtydoor.com'];

async function main() {
  require('dotenv').config();
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const apply = process.argv.includes('--apply');
  try {
    const rows = await prisma.teamMember.findMany({ where: { email: { in: SAMPLE_EMAILS } }, select: { id: true, name: true, title: true, email: true } });
    console.log(`${rows.length} sample team member(s) found.`);
    for (const r of rows) console.log(`  ${r.name} (${r.title}) ${r.email}${apply ? '' : ' (dry run)'}`);
    if (apply && rows.length) {
      const res = await prisma.teamMember.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      console.log(`Removed ${res.count}.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { SAMPLE_EMAILS };
