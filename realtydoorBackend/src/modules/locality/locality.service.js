const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { withCache, cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { buildLocalityReportPdf } = require('../../lib/pdfReport');
const { canonicalizeCity, cityAliasQueryGroup } = require('../../lib/cityAlias');
const { notifyAdmins } = require('../../lib/notifications');

// Backend gaps handoff, 2026-10-10 (#7C) — same alias-group safety net as
// properties.service.js's search, applied here too ("apply the same to
// locality-insights and city counts").
const suggestionKey = (city, locality) => `${canonicalizeCity(city).trim().toLowerCase()}|${String(locality).trim().toLowerCase()}`;

// What the listing form offers in its Locality dropdown: every curated locality for the city plus the ones partners have
// added since, once each, A to Z. `pending` marks the ones the admin has not filled in yet.
async function listLocalityOptions(city) {
  if (!city) throw new ApiError(400, 'city is required');
  const cityMatch = cityAliasQueryGroup(city).map((v) => ({ city: { equals: v, mode: 'insensitive' } }));
  const [insights, suggestions] = await Promise.all([
    prisma.localityInsight.findMany({ where: { OR: cityMatch }, select: { locality: true } }),
    prisma.localitySuggestion.findMany({ where: { OR: cityMatch }, select: { locality: true, status: true } }),
  ]);
  const byName = new Map();
  for (const i of insights) byName.set(i.locality.trim().toLowerCase(), { name: i.locality.trim(), pending: false });
  for (const sg of suggestions) {
    const k = sg.locality.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, { name: sg.locality.trim(), pending: sg.status === 'PENDING' });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A partner or admin adds a locality that is not in the list. It is usable at once; the admins are told to fill in its
// CMS details. A name that already exists (in either list, any letter case) is returned as it is, with no second alert.
async function suggestLocality({ city: rawCity, locality: rawLocality }, user) {
  const city = canonicalizeCity(rawCity).trim();
  const locality = String(rawLocality).trim().replace(/\s+/g, ' ');
  const existing = (await listLocalityOptions(city)).find((o) => o.name.toLowerCase() === locality.toLowerCase());
  if (existing) return { city, locality: existing.name, created: false };

  await prisma.localitySuggestion.create({
    data: { key: suggestionKey(city, locality), city, locality, addedByUserId: user.id },
  });
  await notifyAdmins({
    title: 'New locality added',
    message: `${locality}, ${city} was added by ${user.role === 'ADMIN' ? 'an admin' : 'a partner'} while listing a property. Please fill in its details in the CMS.`,
    type: 'LOCALITY_NEW',
    linkUrl: `/admin/cms/locality-insights/new?city=${encodeURIComponent(city)}&locality=${encodeURIComponent(locality)}`,
  });
  return { city, locality, created: true };
}

async function listPendingSuggestions() {
  return prisma.localitySuggestion.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 200 });
}

async function getLocality(city, locality) {
  const insight = await prisma.localityInsight.findFirst({
    where: {
      OR: cityAliasQueryGroup(city).map((v) => ({ city: { equals: v, mode: 'insensitive' } })),
      locality: { equals: locality, mode: 'insensitive' },
    },
  });
  if (!insight) throw new ApiError(404, 'No locality data found');
  return insight;
}

async function upsertLocality(data, adminId) {
  const { city: rawCity, locality, dataAsOfDate, ...rest } = data;
  const city = canonicalizeCity(rawCity);
  const resolvedDataAsOfDate = dataAsOfDate ? new Date(dataAsOfDate) : new Date();
  const saved = await prisma.localityInsight.upsert({
    where:  { city_locality: { city, locality } },
    update: { ...rest, dataAsOfDate: resolvedDataAsOfDate, updatedByAdminId: adminId },
    create: { city, locality, ...rest, dataAsOfDate: resolvedDataAsOfDate, updatedByAdminId: adminId },
  });
  cacheDel(CACHE_KEYS.CITIES_SUMMARY, CACHE_KEYS.LOCALITIES_LIST, CACHE_KEYS.localityPage(city, locality));
  // The admin has now filled this locality in, so a partner's suggestion for it is done.
  await prisma.localitySuggestion.updateMany({
    where: { key: suggestionKey(city, locality), status: 'PENDING' },
    data: { status: 'RESOLVED', resolvedAt: new Date() },
  }).catch(() => null);
  return saved;
}

async function listLocalities({ city } = {}, skip = 0, limit = 20) {
  const where = {};
  if (city) where.OR = cityAliasQueryGroup(city).map((v) => ({ city: { equals: v, mode: 'insensitive' } }));

  const [data, total] = await prisma.$transaction([
    prisma.localityInsight.findMany({ where, skip, take: limit, orderBy: { city: 'asc' } }),
    prisma.localityInsight.count({ where }),
  ]);
  return { data, total };
}

async function getLocalityById(id) {
  const insight = await prisma.localityInsight.findUnique({ where: { id } });
  if (!insight) throw new ApiError(404, 'Locality insight not found');
  return insight;
}

async function deleteLocality(id) {
  const insight = await prisma.localityInsight.findUnique({ where: { id } });
  if (!insight) throw new ApiError(404, 'Locality insight not found');
  const deleted = await prisma.localityInsight.delete({ where: { id } });
  cacheDel(CACHE_KEYS.CITIES_SUMMARY, CACHE_KEYS.LOCALITIES_LIST, CACHE_KEYS.localityPage(insight.city, insight.locality));
  return deleted;
}

function pickBadge(property) {
  if (property.isFeatured) return 'PREMIUM';
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (property.createdAt >= thirtyDaysAgo) return 'NEW';
  return null;
}

async function getLocalityPage(city, locality) {
  return withCache(CACHE_KEYS.localityPage(city, locality), 900, () => buildLocalityPage(city, locality));
}

async function buildLocalityPage(city, locality) {
  const insight = await prisma.localityInsight.findFirst({
    where: {
      OR: cityAliasQueryGroup(city).map((v) => ({ city: { equals: v, mode: 'insensitive' } })),
      locality: { equals: locality, mode: 'insensitive' },
    },
  });
  if (!insight) throw new ApiError(404, 'No locality data found');

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const liveWhere = { city: insight.city, locality: insight.locality, publishStatus: 'APPROVED' };

  const [total, addedThisWeek, topPicks] = await Promise.all([
    prisma.property.count({ where: liveWhere }),
    prisma.property.count({ where: { ...liveWhere, createdAt: { gte: sevenDaysAgo } } }),
    prisma.property.findMany({
      where: { ...liveWhere, isVerified: true },
      orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }],
      take: 6,
    }),
  ]);

  return {
    city: insight.city,
    locality: insight.locality,
    subtitle: insight.subtitle ?? null,
    headline: insight.headline ?? null,
    about: insight.about ?? null,
    snapshot: {
      localityScore: insight.localityScore ?? null,
      marketStage: insight.marketStage ?? null,
      rentalDemand: insight.rentalDemand ?? null,
      infrastructureStrength: insight.infrastructureStrength ?? null,
      bestFor: insight.bestFor,
    },
    stats: {
      avgPricePerSqftPaise: insight.avgPricePerSqftPaise,
      minPricePerSqftPaise: insight.minPricePerSqftPaise ?? null,
      maxPricePerSqftPaise: insight.maxPricePerSqftPaise ?? null,
      priceChangeLastMonthPct: insight.priceChangeLastMonthPct ?? null,
      medianPricePaise: insight.medianPricePaise ?? null,
      medianPricePropertyType: insight.medianPricePropertyType ?? null,
      avgRentYieldPct: insight.avgRentYieldPct ?? null,
      inventoryLive: { total, addedThisWeek },
    },
    priceTrends: insight.priceTrends ?? null,
    propertyMix: insight.propertyMix ?? null,
    microMarkets: insight.microMarkets ?? null,
    keyInfrastructure: insight.keyInfrastructure ?? null,
    connectivity: insight.connectivity ?? null,
    infrastructureProjects: insight.infrastructureProjects ?? null,
    prosAndCons: insight.prosAndCons ?? null,
    investmentScore: insight.investmentScore ?? null,
    livability: insight.livability ?? null,
    buyVsRent: insight.buyVsRent ?? null,
    localTruth: insight.localTruth ?? null,
    faqs: insight.faqs ?? null,
    topVerifiedPicks: topPicks.map((p) => ({
      badge: pickBadge(p),
      bedroomConfig: p.bhk ? `${p.bhk}BHK` : null,
      project: p.title,
      locality: p.locality,
      price: p.price,
      area: p.carpetArea ?? p.builtUpArea ?? p.plotArea ?? null,
      areaUnit: 'sqft',
      facing: p.facing ?? null,
      floorNumber: p.floorNumber ?? null,
      totalFloors: p.totalFloors ?? null,
      slug: p.slug,
    })),
    mapCenter: insight.mapCenter ?? null,
    lastReviewedBy: insight.lastReviewedBy ?? null,
    dataAsOfDate: insight.dataAsOfDate,
    updatedAt: insight.updatedAt,
  };
}

async function getLocalityReportPdf(city, locality) {
  const page = await getLocalityPage(city, locality);
  return buildLocalityReportPdf(page);
}

// New-endpoint spec, 2026-10-18 — lets the frontend list every locality
// that has a page, for the Home page and an "All locality reports" page.
// Cached 15 min same as cities-summary; the ?city filter is applied after
// the cache read so there's one cached entry, not one per city.
async function getLocalitiesList(city) {
  const all = await withCache(CACHE_KEYS.LOCALITIES_LIST, 900, buildLocalitiesList);
  if (!city) return all;
  const canonical = canonicalizeCity(city);
  return all.filter((l) => l.city === canonical);
}

async function buildLocalitiesList() {
  const [insights, grouped] = await Promise.all([
    prisma.localityInsight.findMany({
      select: {
        city: true, locality: true, avgPricePerSqftPaise: true,
        priceChangeLastMonthPct: true, localityScore: true, subtitle: true,
      },
      orderBy: [{ city: 'asc' }, { locality: 'asc' }],
    }),
    // One groupBy for every locality's live count, not a count-per-locality
    // loop — same reasoning as buildCitiesSummary's own aggregation below.
    prisma.property.groupBy({
      by: ['city', 'locality'],
      where: { publishStatus: 'APPROVED' },
      _count: { _all: true },
    }),
  ]);

  const countMap = new Map(grouped.map((g) => [`${g.city}|${g.locality}`, g._count._all]));

  return insights
    .map((i) => ({
      city: canonicalizeCity(i.city),
      locality: i.locality,
      avgPricePerSqftPaise: i.avgPricePerSqftPaise,
      priceChangeLastMonthPct: i.priceChangeLastMonthPct ?? null,
      localityScore: i.localityScore ?? null,
      subtitle: i.subtitle ?? null,
      listingsCount: countMap.get(`${i.city}|${i.locality}`) ?? 0,
    }))
    .sort((a, b) => a.city.localeCompare(b.city) || a.locality.localeCompare(b.locality));
}

async function getCitiesSummary() {
  return withCache(CACHE_KEYS.CITIES_SUMMARY, 900, buildCitiesSummary);
}

async function buildCitiesSummary() {
  const [localities, properties] = await Promise.all([
    prisma.localityInsight.findMany({
      select: { city: true, avgPricePerSqftPaise: true, priceChangeLastMonthPct: true },
    }),
    prisma.property.findMany({
      where: { publishStatus: 'APPROVED' },
      select: { city: true },
    }),
  ]);

  // Aggregate price + trend per city from LocalityInsight rows. Grouped by
  // the canonicalized spelling (#7C) as a defensive measure — write paths
  // already canonicalize, but this keeps the summary correct even for a
  // row written off that path or not yet covered by the one-off migration.
  const cityInsights = {};
  localities.forEach(({ city: rawCity, avgPricePerSqftPaise, priceChangeLastMonthPct }) => {
    const city = canonicalizeCity(rawCity);
    if (!cityInsights[city]) cityInsights[city] = { prices: [], trends: [] };
    cityInsights[city].prices.push(avgPricePerSqftPaise);
    if (priceChangeLastMonthPct != null) cityInsights[city].trends.push(priceChangeLastMonthPct);
  });

  // Count live listings per city
  const cityCounts = {};
  properties.forEach(({ city: rawCity }) => {
    const city = canonicalizeCity(rawCity);
    cityCounts[city] = (cityCounts[city] || 0) + 1;
  });

  const allCities = new Set([...Object.keys(cityInsights), ...Object.keys(cityCounts)]);
  return [...allCities]
    .map((city) => {
      const { prices = [], trends = [] } = cityInsights[city] || {};
      const avg = prices.length
        ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
        : null;
      const trend = trends.length
        ? Math.round((trends.reduce((a, b) => a + b, 0) / trends.length) * 10) / 10
        : null;
      return { city, listingsCount: cityCounts[city] || 0, avgPricePerSqftPaise: avg, trendPct: trend };
    })
    .sort((a, b) => b.listingsCount - a.listingsCount);
}

module.exports = {
  listLocalityOptions, suggestLocality, listPendingSuggestions,
  getLocality, getLocalityPage, listLocalities, getLocalityById, upsertLocality, deleteLocality,
  getCitiesSummary, getLocalityReportPdf, getLocalitiesList,
};
