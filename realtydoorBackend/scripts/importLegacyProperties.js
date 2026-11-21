/*
 * Creates or updates the six projects that ranked on the previous realtydoor.com site as published listings in the property
 * CMS: Green Park, Vrunda City, Aashrithaa Brindavan, Aashrithaa Divine, Aashrithaa Serene and NewtownJ.
 * Full records (price, area, developer, RERA number, amenities, nearby places, bank approvals, SEO title and description,
 * images, site map, video, brochure) are in scripts/data/legacy-properties.json. The images and brochures are already in the
 * S3 bucket, so nothing is uploaded.
 *
 *   node scripts/importLegacyProperties.js --only vrunda-city-gated-plots-hoskote            # dry run (default): prints what it would do
 *   LEGACY_OWNER_EMAIL=info@realtydoor.com node scripts/importLegacyProperties.js --only <slug> --apply
 *
 * Dry run unless --apply (changed 18 Nov 2026). --only <slug> (repeatable) limits it to those listings; without it all six are used.
 * Every listing needs an owner: a PARTNER or a staff (ADMIN) account. The owner is the user with LEGACY_OWNER_EMAIL, default
 * support@realtydoor.com. A PARTNER owner must have KYC verified or the listing stays hidden from the public (see
 * src/lib/partnerStanding.js); a staff-owned listing is not subject to that, so Realtydoor's own listings use a staff owner.
 * Safe to run again: a property with the same slug is updated, never duplicated.
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');

const DATE_FIELDS = ['verifiedAt', 'possessionDate', 'locationVerifiedAt'];

(async () => {
  const email = (process.env.LEGACY_OWNER_EMAIL || 'support@realtydoor.com').toLowerCase();
  const owner = await prisma.user.findFirst({ where: { email, role: { in: ['PARTNER', 'ADMIN'] }, deletedAt: { isSet: false } } });
  if (!owner) {
    console.error(`No PARTNER or ADMIN account with the email ${email}. Create or pick one and set LEGACY_OWNER_EMAIL.`);
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const only = process.argv.flatMap((a, i, all) => (a === '--only' ? [all[i + 1]] : []));
  let records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'legacy-properties.json'), 'utf8'));
  if (only.length) {
    const missing = only.filter((s) => !records.some((r) => r.slug === s));
    if (missing.length) { console.error(`Not in legacy-properties.json: ${missing.join(', ')}`); process.exit(1); }
    records = records.filter((r) => only.includes(r.slug));
  }
  console.log(`${apply ? 'APPLYING' : 'Dry run'}: ${records.length} listing(s), owner ${owner.email} (${owner.role})`);
  for (const rec of records) {
    const data = { ...rec, partnerId: owner.id, publishStatus: 'APPROVED' };
    for (const f of DATE_FIELDS) if (data[f]) data[f] = new Date(data[f]);
    const existing = await prisma.property.findUnique({ where: { slug: rec.slug } });
    if (!apply) { console.log(existing ? 'would update' : 'would create', rec.slug, `| price ${rec.price} | ${rec.propertyType} | ${rec.locality}`); continue; }
    if (existing) {
      await prisma.property.update({ where: { slug: rec.slug }, data });
      console.log('updated', rec.slug);
    } else {
      await prisma.property.create({ data });
      console.log('created', rec.slug);
    }
  }
  console.log(apply ? `done: ${records.length} properties, owner ${owner.email}` : 'Dry run only. Re-run with --apply after approval.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
