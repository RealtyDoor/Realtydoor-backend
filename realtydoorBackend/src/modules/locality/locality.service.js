const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { withCache, cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { buildLocalityReportPdf } = require('../../lib/pdfReport');

async function getLocality(city, locality) {
  const insight = await prisma.localityInsight.findFirst({
    where: {
      city:     { equals: city,     mode: 'insensitive' },
      locality: { equals: locality, mode: 'insensitive' },
    },
  });
  if (!insight) throw new ApiError(404, 'No locality data found');
  return insight;
}

async function upsertLocality(data, adminId) {
  const { city, locality, dataAsOfDate, ...rest } = data;
  const resolvedDataAsOfDate = dataAsOfDate ? new Date(dataAsOfDate) : new Date();
  const saved = await prisma.localityInsight.upsert({
    where:  { city_locality: { city, locality } },
    update: { ...rest, dataAsOfDate: resolvedDataAsOfDate, updatedByAdminId: adminId },
    create: { city, locality, ...rest, dataAsOfDate: resolvedDataAsOfDate, updatedByAdminId: adminId },
  });
  cacheDel(CACHE_KEYS.CITIES_SUMMARY, CACHE_KEYS.localityPage(city, locality));
  return saved;
}

async function listLocalities({ city } = {}, skip = 0, limit = 20) {
  const where = {};
  if (city) where.city = { equals: city, mode: 'insensitive' };

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
  cacheDel(CACHE_KEYS.CITIES_SUMMARY, CACHE_KEYS.localityPage(insight.city, insight.locality));
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
      city:     { equals: city,     mode: 'insensitive' },
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
    buyVsRent: insight.buyVsRent ?? null,
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
    dataAsOfDate: insight.dataAsOfDate,
    updatedAt: insight.updatedAt,
  };
}

async function getLocalityReportPdf(city, locality) {
  const page = await getLocalityPage(city, locality);
  return buildLocalityReportPdf(page);
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

  // Aggregate price + trend per city from LocalityInsight rows
  const cityInsights = {};
  localities.forEach(({ city, avgPricePerSqftPaise, priceChangeLastMonthPct }) => {
    if (!cityInsights[city]) cityInsights[city] = { prices: [], trends: [] };
    cityInsights[city].prices.push(avgPricePerSqftPaise);
    if (priceChangeLastMonthPct != null) cityInsights[city].trends.push(priceChangeLastMonthPct);
  });

  // Count live listings per city
  const cityCounts = {};
  properties.forEach(({ city }) => { cityCounts[city] = (cityCounts[city] || 0) + 1; });

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
  getLocality, getLocalityPage, listLocalities, getLocalityById, upsertLocality, deleteLocality,
  getCitiesSummary, getLocalityReportPdf,
};
