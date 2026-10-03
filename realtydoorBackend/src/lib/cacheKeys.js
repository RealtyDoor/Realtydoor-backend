const norm = (s) => String(s || '').trim().toLowerCase();

module.exports = {
  FEATURED_PROPERTIES: 'cache:properties:featured',
  PUBLIC_CONFIG: 'cache:config:public',
  CITIES_SUMMARY: 'cache:locality:cities-summary',
  SERVICES_LIST: 'cache:services:list',
  FAQ_LIST: 'cache:blog:list:FAQ:all', // shares the blog-list invalidation pattern
  localityPage: (city, locality) => `cache:locality:page:${norm(city)}:${norm(locality)}`,
  blogList: (type, skip, limit) => `cache:blog:list:${type || 'all'}:${skip}:${limit}`,
  blogSlug: (slug) => `cache:blog:slug:${slug}`,
  BLOG_LIST_PATTERN: 'cache:blog:list:*',
};
