/*
 * Creates or updates the six projects that ranked on the previous realtydoor.com site as published listings in the property
 * CMS: Green Park, Vrunda City, Aashrithaa Brindavan, Aashrithaa Divine, Aashrithaa Serene and NewtownJ.
 * Full records (price, area, developer, RERA number, amenities, nearby places, bank approvals, SEO title and description,
 * images, site map, video, brochure) are in scripts/data/legacy-properties.json. The images and brochures are already in the
 * S3 bucket, so nothing is uploaded.
 *
 *   node scripts/importLegacyProperties.js
 *   LEGACY_OWNER_EMAIL=someone@realtydoor.com node scripts/importLegacyProperties.js
 *
 * Every listing needs an owner (a PARTNER account). The owner is the user with LEGACY_OWNER_EMAIL, default
 * support@realtydoor.com. Safe to run again: a property with the same slug is updated, never duplicated.
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');

const DATE_FIELDS = ['verifiedAt', 'possessionDate', 'locationVerifiedAt'];

(async () => {
  const email = (process.env.LEGACY_OWNER_EMAIL || 'support@realtydoor.com').toLowerCase();
  const owner = await prisma.user.findFirst({ where: { email, role: 'PARTNER' } });
  if (!owner) {
    console.error(`No PARTNER account with the email ${email}. Create or pick one and set LEGACY_OWNER_EMAIL.`);
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'legacy-properties.json'), 'utf8'));
  for (const rec of records) {
    const data = { ...rec, partnerId: owner.id, publishStatus: 'APPROVED' };
    for (const f of DATE_FIELDS) if (data[f]) data[f] = new Date(data[f]);
    const existing = await prisma.property.findUnique({ where: { slug: rec.slug } });
    if (existing) {
      await prisma.property.update({ where: { slug: rec.slug }, data });
      console.log('updated', rec.slug);
    } else {
      await prisma.property.create({ data });
      console.log('created', rec.slug);
    }
  }
  console.log(`done: ${records.length} properties, owner ${owner.email}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
