/*
 * Moves the hero image of each imported legacy blog post to the S3 bucket and points the CMS post at it, so the CMS owns its
 * images instead of relying on files in the frontend's public folder. Run after seedLegacyBlogs.js. Safe to run again.
 *
 *   node scripts/uploadLegacyBlogImages.js
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');
const { s3Upload } = require('../src/lib/fileUpload');

const IMAGES = process.env.BLOG_IMAGES_DIR || path.join(__dirname, '..', '..', '..', 'admin-nextjs', 'public', 'images', 'blog');
const posts = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'legacy-blogs.json'), 'utf8'));

(async () => {
  for (const p of posts) {
    const row = await prisma.contentBlock.findUnique({ where: { slug: p.slug } });
    if (!row || !p.imageUrl) { console.log('skip', p.slug); continue; }
    if (/^https?:/i.test(row.imageUrl || '')) { console.log('already hosted', p.slug); continue; }
    const file = path.join(IMAGES, path.basename(p.imageUrl));
    if (!fs.existsSync(file)) { console.log('image file missing', file); continue; }
    const { url } = await s3Upload(fs.readFileSync(file), 'blog/legacy', path.basename(file), 'image/png');
    await prisma.contentBlock.update({ where: { slug: p.slug }, data: { imageUrl: url } });
    console.log('uploaded', p.slug, url);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
