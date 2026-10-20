/*
 * The six projects that ranked on the previous realtydoor.com site already exist in the property CMS, but with short
 * placeholder SEO text ("Capitalize on Hoskote's Future"). This puts back the title and description Google had indexed
 * and attaches each project's brochure.
 *
 *   node scripts/restoreLegacyPropertySeo.js            (needs the old site's folder, see OLD below)
 *
 * Safe to run again: the brochure is only added when the property has none.
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');
const { s3Upload } = require('../src/lib/fileUpload');

const OLD = process.env.OLD_SITE_DIR || path.join(__dirname, '..', '..', '..', 'seo-source', 'Realtydoor-demo-main');
// CMS slug -> [old page folder (for the title/description), old public folder (for the brochure)]
const MAP = {
  'vrunda-city-gated-plots-hoskote': ['vrunda-city-gated-plots-hoskote', 'vrunda-city', 'Vrunda Brochure.pdf'],
  'brindavan-premium-plots-kanakapura-road': ['brindavan-premium-plots-kanakapura-road', 'aashrithaa-brindavan', 'brochure.pdf'],
  'divine-rera-plots-jigani': ['aashrithaa-divine-jigani', 'aashrithaa-divine', 'brochure.pdf'],
  'premium-villa-plots-old-madras-road-hoskote-neo-serene': ['premium-villa-plots-old-madras-road-hoskote-neo-serene', 'aashrithaa-serene', 'brochure.pdf'],
  'green-park-dtcp-plots-chintamani': ['green-park-dtcp-plots-chintamani', 'green-park', 'brochure.pdf'],
  'dtcp-approved-lakeview-township-plots-in-punganur-newtownj': ['dtcp-approved-lakeview-township-plots-in-punganur-newtownj', 'newtownj', 'brochure.pdf'],
};

const grab = (src, key) => {
  const m = src.match(new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`));
  return m ? m[1].replace(/\\'/g, "'") : null;
};

(async () => {
  for (const [slug, [pageDir, pubDir, brochure]] of Object.entries(MAP)) {
    const layout = fs.readFileSync(path.join(OLD, 'app', 'properties', pageDir, 'layout.tsx'), 'utf8');
    const meta = layout.slice(layout.indexOf('export const metadata'));
    const title = grab(meta, 'title');
    const description = grab(meta, 'description');
    const prop = await prisma.property.findUnique({ where: { slug } });
    if (!prop) { console.log('MISSING', slug); continue; }
    const data = { metaTitle: title, metaDescription: description };
    const hasBrochure = (prop.documents || []).some((d) => /brochure/i.test(d.name || ''));
    const file = path.join(OLD, 'public', pubDir, brochure);
    if (!hasBrochure && fs.existsSync(file)) {
      const { url } = await s3Upload(fs.readFileSync(file), `properties/import/${slug}`, 'brochure.pdf', 'application/pdf');
      data.documents = [...(prop.documents || []), { name: 'Brochure', url, uploadedAt: new Date().toISOString() }];
    }
    await prisma.property.update({ where: { slug }, data });
    console.log('updated', slug, '|', title, '| brochure', data.documents ? 'added' : 'kept');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
