const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { paginate } = require('../../utils/pagination');
const { withCache, cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');

const SORT_MAP = {
  price_asc: { price: 'asc' },
  price_desc: { price: 'desc' },
  newest: { createdAt: 'desc' },
  area_asc: { carpetArea: 'asc' },
};

async function searchProperties(query, skip, limit, page) {
  const where = {
    publishStatus: 'APPROVED',
    isB2BOnly: false,
  };

  if (query.q) {
    where.OR = [
      { title: { contains: query.q, mode: 'insensitive' } },
      { description: { contains: query.q, mode: 'insensitive' } },
      { locality: { contains: query.q, mode: 'insensitive' } },
    ];
  }
  if (query.city) where.city = { equals: query.city, mode: 'insensitive' };
  if (query.locality) where.locality = { contains: query.locality, mode: 'insensitive' };
  if (query.propertyType) where.propertyType = query.propertyType;
  if (query.listingType) where.listingType = query.listingType;
  if (query.bhk) where.bhk = Number(query.bhk);
  if (query.minPrice || query.maxPrice) {
    where.price = {};
    if (query.minPrice) where.price.gte = Number(query.minPrice);
    if (query.maxPrice) where.price.lte = Number(query.maxPrice);
  }
  if (query.minArea || query.maxArea) {
    where.carpetArea = {};
    if (query.minArea) where.carpetArea.gte = Number(query.minArea);
    if (query.maxArea) where.carpetArea.lte = Number(query.maxArea);
  }
  if (query.furnishing) where.furnishing = query.furnishing;
  if (query.propertyStatus) where.propertyStatus = query.propertyStatus;
  if (query.isVerified !== undefined) where.isVerified = query.isVerified;
  if (query.amenities) {
    // D.2: search both amenities[] AND societyFeatures[] — property must have
    // each selected amenity in at least one of the two arrays
    const selected = query.amenities.split(',').map((a) => a.trim()).filter(Boolean);
    if (!where.AND) where.AND = [];
    selected.forEach((amenity) => {
      where.AND.push({
        OR: [
          { amenities:       { has: amenity } },
          { societyFeatures: { has: amenity } },
        ],
      });
    });
  }

  const orderBy = SORT_MAP[query.sort] || { createdAt: 'desc' };

  const [data, total] = await prisma.$transaction([
    prisma.property.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select: {
        id: true, title: true, slug: true, price: true, monthlyRent: true,
        propertyType: true, listingType: true, propertyStatus: true,
        bhk: true, carpetArea: true, locality: true, city: true,
        images: true, coverImageIndex: true, isVerified: true, isFeatured: true,
        reraNumber: true, createdAt: true, facing: true, furnishing: true,
      },
    }),
    prisma.property.count({ where }),
  ]);

  return paginate(data, total, page, limit);
}

async function getPropertyBySlug(slug) {
  const property = await prisma.property.findUnique({
    where: { slug, publishStatus: 'APPROVED' },
    include: { partner: { select: { companyName: true, partnerSubType: true } } },
  });
  if (!property) throw new ApiError(404, 'Property not found');
  return property;
}

async function createProperty(data, partnerId) {
  const slug = data.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') + '-' + Date.now();

  if (!data.facing) data.facing = 'East';
  if (!data.furnishing) data.furnishing = 'Unfurnished';

  return prisma.property.create({
    data: { ...data, slug, partnerId, publishStatus: 'PENDING_APPROVAL' },
  });
}

async function updateProperty(id, partnerId, data) {
  const property = await prisma.property.findUnique({ where: { id } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.partnerId !== partnerId) throw new ApiError(403, 'Not your listing');

  const FORBIDDEN = ['publishStatus', 'isVerified', 'partnerId'];
  FORBIDDEN.forEach((f) => delete data[f]);

  // Re-trigger admin review so edited content doesn't go live unreviewed
  if (property.publishStatus === 'APPROVED') {
    data.publishStatus = 'PENDING_APPROVAL';
    data.rejectionNote = null;
  }

  const updated = await prisma.property.update({ where: { id }, data });

  if (property.publishStatus === 'APPROVED') {
    cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
    cacheDel(CACHE_KEYS.localityPage(property.city, property.locality));
    if (updated.city !== property.city || updated.locality !== property.locality) {
      cacheDel(CACHE_KEYS.localityPage(updated.city, updated.locality));
    }
  }

  return updated;
}

async function getFeaturedProperties() {
  return withCache(CACHE_KEYS.FEATURED_PROPERTIES, 600, () => prisma.property.findMany({
    where: { publishStatus: 'APPROVED', isFeatured: true },
    take: 12,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, title: true, slug: true, price: true, monthlyRent: true,
      propertyType: true, listingType: true, bhk: true, locality: true, city: true,
      images: true, coverImageIndex: true, isVerified: true, facing: true, furnishing: true,
    },
  }));
}

async function addImages(id, partnerId, urls) {
  const property = await prisma.property.findUnique({ where: { id } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.partnerId !== partnerId) throw new ApiError(403, 'Not your listing');
  return prisma.property.update({
    where: { id },
    data: { images: { push: urls } },
  });
}

async function addVideos(id, partnerId, urls) {
  const property = await prisma.property.findUnique({ where: { id } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.partnerId !== partnerId) throw new ApiError(403, 'Not your listing');
  return prisma.property.update({
    where: { id },
    data: { videos: { push: urls } },
  });
}

async function addDocuments(id, partnerId, files) {
  const property = await prisma.property.findUnique({ where: { id } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.partnerId !== partnerId) throw new ApiError(403, 'Not your listing');

  const docs = files.map((f) => ({
    name: f.originalname,
    url: f.path,
    uploadedAt: new Date().toISOString(),
  }));

  return prisma.property.update({
    where: { id },
    data: { documents: { push: docs } },
  });
}

async function getPropertyEditLogs(propertyId, partnerId) {
  const property = await prisma.property.findFirst({ where: { id: propertyId, partnerId } });
  if (!property) throw new ApiError(404, 'Property not found');
  return prisma.propertyEditLog.findMany({
    where: { propertyId },
    orderBy: { editedAt: 'desc' },
  });
}

async function getConstructionUpdates(propertyId) {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, publishStatus: 'APPROVED' },
    select: { id: true },
  });
  if (!property) throw new ApiError(404, 'Property not found');
  return prisma.constructionUpdate.findMany({
    where: { propertyId },
    orderBy: { postedAt: 'desc' },
  });
}

async function addConstructionUpdate(propertyId, partnerId, data) {
  const property = await prisma.property.findFirst({ where: { id: propertyId, partnerId } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.propertyStatus !== 'UNDER_CONSTRUCTION') {
    throw new ApiError(400, 'Construction updates are only for under-construction properties');
  }
  return prisma.constructionUpdate.create({ data: { ...data, propertyId } });
}

module.exports = {
  searchProperties, getPropertyBySlug, createProperty, updateProperty, getFeaturedProperties,
  addImages, addVideos, addDocuments, getPropertyEditLogs,
  getConstructionUpdates, addConstructionUpdate,
};
