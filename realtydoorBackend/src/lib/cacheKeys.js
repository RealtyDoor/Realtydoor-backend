const norm = (s) => String(s || '').trim().toLowerCase();

module.exports = {
  FEATURED_PROPERTIES: 'cache:properties:featured',
  PUBLIC_CONFIG: 'cache:config:public',
  CITIES_SUMMARY: 'cache:locality:cities-summary',
  LOCALITIES_LIST: 'cache:locality:localities-list',
  // BE-8 — GET /services now takes an optional ?category filter; each
  // category gets its own cache entry rather than one flat key, so a
  // filtered and an unfiltered call never collide. servicesList(undefined)
  // === SERVICES_LIST, kept as a constant for admin.service.js's
  // create/update/delete, which now invalidates the whole pattern instead
  // of just the unfiltered key.
  SERVICES_LIST: 'cache:services:list:all',
  servicesList: (category) => `cache:services:list:${category || 'all'}`,
  SERVICES_LIST_PATTERN: 'cache:services:list:*',
  FAQ_LIST: 'cache:blog:list:FAQ:all', // shares the blog-list invalidation pattern
  localityPage: (city, locality) => `cache:locality:page:${norm(city)}:${norm(locality)}`,
  blogList: (type, skip, limit) => `cache:blog:list:${type || 'all'}:${skip}:${limit}`,
  blogSlug: (slug) => `cache:blog:slug:${slug}`,
  BLOG_LIST_PATTERN: 'cache:blog:list:*',
  // Microsites spec — FE revalidates every 60s, so the TTL matches that.
  micrositeSlug: (slug) => `cache:microsite:slug:${slug}`,
};
