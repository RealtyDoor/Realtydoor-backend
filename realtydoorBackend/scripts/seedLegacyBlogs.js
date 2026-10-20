/*
 * Imports the 12 blog posts that were ranking on the previous realtydoor.com site (Search Console coverage, 17 Oct 2026)
 * into the CMS as published BLOG_POST rows, keeping their slugs, titles, SEO title and description, keywords and images.
 * Safe to run again: a post with the same slug is updated, not duplicated.
 *
 *   node scripts/seedLegacyBlogs.js
 *
 * The post bodies are in scripts/data/legacy-blogs.json (converted from the previous site's pages). The images are in the
 * frontend at public/images/blog/.
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');

(async () => {
  const posts = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'legacy-blogs.json'), 'utf8'));
  for (const p of posts) {
    const data = {
      type: 'BLOG_POST', title: p.title, slug: p.slug, content: p.content, excerpt: p.excerpt, imageUrl: p.imageUrl,
      author: p.author, tags: [p.category, ...p.tags], isPublished: true,
      publishedAt: p.date ? new Date(`${p.date} 09:00:00 GMT+0530`) : new Date(), seoTitle: p.seoTitle, seoDesc: p.seoDesc,
    };
    const existing = await prisma.contentBlock.findUnique({ where: { slug: p.slug } });
    if (existing) await prisma.contentBlock.update({ where: { slug: p.slug }, data });
    else await prisma.contentBlock.create({ data });
    console.log(existing ? 'updated' : 'created', p.slug);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
