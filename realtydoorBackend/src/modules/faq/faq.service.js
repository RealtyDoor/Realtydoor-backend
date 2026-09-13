const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { withCache } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');

function parseContent(block) {
  let content;
  try {
    content = JSON.parse(block.content);
  } catch {
    content = block.content;
  }
  return { ...block, content };
}

async function getAll() {
  return withCache(CACHE_KEYS.FAQ_LIST, 1800, async () => {
    const blocks = await prisma.contentBlock.findMany({
      where: { type: 'FAQ', isPublished: true },
      orderBy: { publishedAt: 'desc' },
    });
    return blocks.map(parseContent);
  });
}

async function getBySlug(slug) {
  return withCache(CACHE_KEYS.blogSlug(slug), 1800, async () => {
    const block = await prisma.contentBlock.findUnique({ where: { slug, isPublished: true } });
    if (!block || block.type !== 'FAQ') throw new ApiError(404, 'FAQ not found');
    return parseContent(block);
  });
}

module.exports = { getAll, getBySlug };
