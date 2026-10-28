/**
 * One-record fix: the NewtownJ / Lakeview Township listing is in Punganur, Andhra Pradesh (its own address says so), but was saved
 * as locality "Bengaluru", city "Bengaluru", state "Karnataka". Sets locality Punganur, city Chittoor, state Andhra Pradesh.
 * Pincode (517247) and everything else stay as they are.
 *
 *   node scripts/fixLakeviewLocation.js            # dry run, prints before and after
 *   node scripts/fixLakeviewLocation.js --apply    # saves the old values to the rollback file, then writes
 *   node scripts/fixLakeviewLocation.js --restore  # puts the old values back
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const SLUG = 'dtcp-approved-lakeview-township-plots-in-punganur-newtownj';
const AFTER = { locality: 'Punganur', city: 'Chittoor', state: 'Andhra Pradesh' };
const ROLLBACK = path.resolve(__dirname, '../../../backups/lakeview-location-rollback-2026-10-26.json');
const prisma = new PrismaClient();

async function main() {
  const p = await prisma.property.findFirst({ where: { slug: SLUG }, select: { id: true, slug: true, address: true, pincode: true, locality: true, city: true, state: true } });
  if (!p) throw new Error('listing not found');
  if (process.argv.includes('--restore')) {
    const saved = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    await prisma.property.update({ where: { id: saved.id }, data: { locality: saved.locality, city: saved.city, state: saved.state } });
    console.log('restored', saved);
    return;
  }
  console.log('address :', p.address, '| pincode', p.pincode);
  console.log('before  :', { locality: p.locality, city: p.city, state: p.state });
  console.log('after   :', AFTER);
  if (process.argv.includes('--apply')) {
    fs.writeFileSync(ROLLBACK, JSON.stringify({ id: p.id, locality: p.locality, city: p.city, state: p.state }, null, 1));
    await prisma.property.update({ where: { id: p.id }, data: AFTER });
    console.log('written; rollback saved to', ROLLBACK);
  } else console.log('(dry run: nothing written)');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
