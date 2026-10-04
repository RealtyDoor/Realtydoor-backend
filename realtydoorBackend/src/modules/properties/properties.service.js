const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { paginate } = require('../../utils/pagination');
const { withCache, cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const logger = require('../../lib/logger');

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
    // RENT/LEASE listings price on monthlyRent, not price — filtering price
    // unconditionally meant a rent search with a price range silently
    // excluded every rental listing (monthlyRent-only rows have price: null).
    const priceField = (query.listingType === 'RENT' || query.listingType === 'LEASE') ? 'monthlyRent' : 'price';
    where[priceField] = {};
    if (query.minPrice) where[priceField].gte = Number(query.minPrice);
    if (query.maxPrice) where[priceField].lte = Number(query.maxPrice);
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
        bhk: true, balconies: true, carpetArea: true, locality: true, city: true,
        images: true, coverImageIndex: true, isVerified: true, isFeatured: true,
        reraNumber: true, createdAt: true, facing: true, furnishing: true,
        previousPrice: true, priceChange6m: true, unitsLeft: true, viewsThisWeek: true,
        // Used by the property detail page's peer-comparison ("Better/below
        // average" tags for built-up area, age, and floor) — it fetches this
        // same search endpoint for peers and was silently getting undefined
        // for these three without them in the select.
        builtUpArea: true, ageOfProperty: true, floorNumber: true, totalFloors: true,
        // Needed for a map view (pins for every result on the listing page)
        // without round-tripping to the per-property detail endpoint.
        latitude: true, longitude: true,
      },
    }),
    prisma.property.count({ where }),
  ]);

  return paginate(data, total, page, limit);
}

async function getPropertyBySlug(slug) {
  const property = await prisma.property.findUnique({
    where: { slug, publishStatus: 'APPROVED' },
    include: {
      partner: {
        select: { id: true, name: true, companyName: true, partnerSubType: true, kycStatus: true, profileImageUrl: true },
      },
    },
  });
  // isB2BOnly listings must never be reachable by slug — searchProperties
  // already excludes them from the public list, but the direct-fetch path
  // had no equivalent check, so a known/guessed slug could still see one.
  if (!property || property.isB2BOnly) throw new ApiError(404, 'Property not found');

  // Fire-and-forget — a view counter shouldn't add latency to the page load,
  // and a lost increment under a race is harmless for this metric.
  prisma.property.update({
    where: { id: property.id },
    data: { viewsThisWeek: { increment: 1 } },
  }).catch(() => {});

  const [peers, localityInsight] = await Promise.all([
    prisma.property.findMany({
      where: {
        publishStatus: 'APPROVED', isB2BOnly: false,
        city: property.city, propertyType: property.propertyType,
        id: { not: property.id },
      },
      take: 6,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, slug: true, locality: true, city: true, images: true, propertyType: true,
        developer: true, propertyStatus: true, landAreaValue: true, landAreaUnit: true,
        openSpacePct: true, totalUnits: true,
      },
    }),
    property.city && property.locality
      ? prisma.localityInsight.findFirst({
          where: { city: { equals: property.city, mode: 'insensitive' }, locality: { equals: property.locality, mode: 'insensitive' } },
        })
      : null,
  ]);

  // Rating is never partner-self-reported — computed live from real,
  // moderated PropertyReview rows for the main property and every peer in
  // one batched query, rather than N+1 queries or a stored, gameable field.
  const ratingGroups = await prisma.propertyReview.groupBy({
    by: ['propertyId'],
    where: { propertyId: { in: [property.id, ...peers.map((p) => p.id)] }, isApproved: true },
    _avg: { rating: true },
    _count: { rating: true },
  });
  const ratingsById = new Map(ratingGroups.map((g) => [g.propertyId, { avg: g._avg.rating, count: g._count.rating }]));

  // Existing flat shape is returned untouched (nothing that already reads
  // `data.price`, `data.bhk`, `data.partner.companyName`, etc. changes) —
  // `property`/`propertyDetailsComparison`/`localityInsights` are additive,
  // for the new nested contract, built from this same real data.
  return {
    ...property,
    property: shapePropertyDetail(property, ratingsById.get(property.id)),
    propertyDetailsComparison: shapeComparison(peers, ratingsById),
    localityInsights: shapeLocalityInsights(property, localityInsight),
  };
}

// Fields with no backing data anywhere in the schema (parking, legal
// verification, agent experience/designation/stats) are returned as null
// rather than invented — never fabricate numbers for a real listing.
function shapePropertyDetail(property, ratingData) {
  const coverImage = property.images?.[property.coverImageIndex] ?? property.images?.[0] ?? null;
  const pricePerSqft = property.price && property.carpetArea
    ? Math.round(property.price / property.carpetArea) : null;
  const carpetEfficiency = property.carpetArea && property.builtUpArea
    ? Math.round((property.carpetArea / property.builtUpArea) * 100) : null;

  return {
    id: property.id,
    title: property.title,
    propertyType: property.propertyType,
    listingType: property.listingType,
    status: property.publishStatus,

    location: {
      address: property.address,
      locality: property.locality,
      city: property.city,
      state: property.state,
      country: 'India',
      pincode: property.pincode,
    },

    pricing: {
      // We store one price per listing, not a range — minPrice/maxPrice are
      // equal here. A true range only makes sense for a multi-unit project,
      // which isn't a concept this schema models.
      minPrice: property.price ?? null,
      maxPrice: property.price ?? null,
      monthlyRent: property.monthlyRent ?? null,
      priceNegotiable: property.priceNegotiable,
      currency: 'INR',
      pricePerSqft,
    },

    configuration: {
      bhk: property.bhk ?? null,
      bathrooms: property.bathrooms ?? null,
      balconies: property.balconies ?? null,
      facing: property.facing ?? null,
      furnishing: property.furnishing ?? null,
    },

    area: {
      carpetArea: property.carpetArea ?? null,
      builtUpArea: property.builtUpArea ?? null,
      plotArea: property.plotArea ?? null,
      carpetEfficiency,
      unit: 'sqft',
    },

    floorDetails: {
      floorNumber: property.floorNumber ?? null,
      totalFloors: property.totalFloors ?? null,
    },

    propertyAge: property.ageOfProperty != null ? { value: property.ageOfProperty, unit: 'years' } : null,

    parking: null, // not modeled on Property today

    // Project-level details — only meaningful for a developer-led project
    // listing (isFeaturedProject); null across the board for a regular
    // single-unit listing that was never given this info.
    projectDetails: {
      developer: property.developer ?? null,
      projectStatus: property.propertyStatus,
      // Computed live from real, moderated PropertyReview rows — never a
      // partner-self-reported number. null when there are no reviews yet.
      rating: ratingData?.avg != null ? Math.round(ratingData.avg * 10) / 10 : null,
      ratingCount: ratingData?.count ?? 0,
      landArea: (property.landAreaValue != null) ? { value: property.landAreaValue, unit: property.landAreaUnit || null } : null,
      openSpace: property.openSpacePct ?? null,
      totalUnits: property.totalUnits ?? null,
    },

    description: property.description,

    media: {
      coverImage,
      images: property.images || [],
      totalImages: property.images?.length || 0,
      videoTour: {
        available: !!(property.videoUrl || property.videos?.length),
        url: property.videoUrl || property.videos?.[0] || null,
      },
      virtualTour: {
        available: !!property.virtualTourUrl,
        url: property.virtualTourUrl || null,
      },
      floorPlanUrl: property.floorPlanUrl || null,
    },

    verification: {
      realtyDoorVerified: property.isVerified,
      // We only store the RERA registration number itself, not a separate
      // "this number was checked" flag — presence of a number is the best
      // available signal today, not a true independent verification state.
      reraVerified: !!property.reraNumber,
      reraNumber: property.reraNumber || null,
      legalVerified: null, // not modeled
      loanApproved: (property.bankApprovals?.length || 0) > 0,
      bankApprovals: property.bankApprovals || [],
    },

    badges: deriveBadges(property),

    amenities: property.amenities || [],
    societyFeatures: property.societyFeatures || [],

    propertyMetrics: {
      carpetEfficiency,
      // unitsRemaining/priceIncreaseLast6Months mirror unitsLeft/priceChange6m,
      // which nothing in this codebase currently writes to — they'll read as
      // null until a real update path exists for them.
      unitsRemaining: property.unitsLeft ?? null,
      weeklyViews: property.viewsThisWeek,
      priceIncreaseLast6Months: property.priceChange6m ?? null,
    },

    agent: {
      id: property.partner?.id ?? null,
      name: property.partner?.name ?? null,
      companyName: property.partner?.companyName ?? null,
      designation: property.partner?.partnerSubType ?? null,
      verified: property.partner?.kycStatus === 'VERIFIED',
      profileImage: property.partner?.profileImageUrl ?? null,
      // experienceYears, rating, statistics: not modeled on the partner
      // profile today — real partner ratings exist (Lead.buyerRating,
      // surfaced via GET /partner/ratings) but aren't joined into this
      // public response.
    },

    timestamps: { createdAt: property.createdAt, updatedAt: property.updatedAt },
  };
}

function deriveBadges(property) {
  const badges = [];
  if (property.isFeatured) badges.push('FEATURED');
  if (property.isVerified) badges.push('REALTYDOOR_VERIFIED');
  if (property.bankApprovals?.length > 0) badges.push('BANK_APPROVED');
  return badges;
}

// Built from the same peer listings the current property page already fetches
// client-side for its own comparison logic — reshaped, not duplicated.
// developer/rating/landArea/openSpace/totalUnits come from Property's own
// project-level fields (added specifically for this) — null on a regular
// single-unit listing that was never given project details, same as any
// other optional field, not a placeholder.
function shapeComparison(peers, ratingsById) {
  if (!peers.length) return null;
  return {
    title: 'Similar Properties',
    properties: peers.map((p) => {
      const r = ratingsById.get(p.id);
      return {
        id: p.id,
        name: p.title,
        slug: p.slug,
        location: { locality: p.locality, city: p.city },
        image: p.images?.[0] || null,
        basicInformation: {
          developer: p.developer ?? null,
          projectStatus: p.propertyStatus,
          // Computed from real PropertyReview rows, same as the main property.
          rating: r?.avg != null ? Math.round(r.avg * 10) / 10 : null,
          ratingCount: r?.count ?? 0,
          propertyType: p.propertyType,
          landArea: (p.landAreaValue != null) ? { value: p.landAreaValue, unit: p.landAreaUnit || null } : null,
          openSpace: p.openSpacePct ?? null,
          totalUnits: p.totalUnits ?? null,
        },
      };
    }),
  };
}

// Reuses the real, already-working LocalityInsight model (the same one
// powering the existing locality-insights panel) — remapped field names,
// not a second parallel data source. Returns null when no admin-curated
// row exists for this city/locality yet, same fallback as today.
function shapeLocalityInsights(property, insight) {
  if (!insight) return null;
  return {
    locality: insight.locality,
    lastUpdated: insight.dataAsOfDate,
    market: {
      averagePrice: Math.round(insight.avgPricePerSqftPaise / 100),
      currency: 'INR',
      priceUnit: 'sqft',
      oneYearAppreciation: insight.priceTrends?.growth?.oneYear ?? null,
      rentYield: insight.avgRentYieldPct ?? null,
      estimatedMonthlyRent: insight.avgRentPerMonthPaise ? Math.round(insight.avgRentPerMonthPaise / 100) : null,
    },
    // We only store landmark names (Property.nearbyLandmarks), never
    // distance/travel-time/status per landmark, so those fields are omitted
    // rather than invented.
    nearbyPlaces: (property.nearbyLandmarks || []).map((name) => ({ name })),
  };
}

async function createProperty(data, partnerId) {
  const slug = data.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') + '-' + Date.now();

  if (!data.facing) data.facing = 'East';
  if (!data.furnishing) data.furnishing = 'Unfurnished';

  // 4.6 — a stored mapLink without its parsed coordinates would describe
  // nothing, so they are derived wherever mapLink is written.
  const { withMapLinkCoords } = require('../listings/location.service');

  const property = await prisma.property.create({
    data: { ...withMapLinkCoords(data), slug, partnerId, publishStatus: 'PENDING_APPROVAL' },
  });

  // 4.4 — submission is the moment a duplicate becomes detectable, so the
  // conflict check runs here rather than waiting for an admin to ask. Required
  // lazily to avoid a circular import, and a detector failure is logged rather
  // than propagated: a transient problem finding conflicts must not reject a
  // listing the partner has legitimately submitted. Admin can re-run it on
  // demand via POST /admin/properties/:id/detect-conflicts.
  try {
    const { detectConflicts } = require('../listings/integrity.service');
    await detectConflicts(property.id);
  } catch (err) {
    logger.error('[createProperty] conflict detection failed', { propertyId: property.id, error: err.message });
  }

  return property;
}

// Compares a submitted patch against the stored row and returns only the
// fields that actually differ, as { field: { before, after } }.
//
// Values are JSON-encoded because a property carries arrays (amenities,
// images, nearbyLandmarks) and nullable scalars. Comparing those with String()
// would report [] and [''] as equal and lose the difference between null and
// an empty string, so the diff would silently drop real edits.
function diffProperty(property, data) {
  const changes = {};
  for (const [field, after] of Object.entries(data)) {
    const beforeJson = JSON.stringify(property[field] ?? null);
    const afterJson = JSON.stringify(after ?? null);
    if (beforeJson !== afterJson) changes[field] = { before: beforeJson, after: afterJson };
  }
  return changes;
}

// Docs 4.8 — a partner editing a LIVE listing no longer writes to the
// property. Previously the edit applied immediately and flipped the listing
// back to PENDING_APPROVAL, which took the approved version dark along with
// the unreviewed one, and left no record of what changed (PropertyEditLog was
// only written for admin edits). Now the live listing is left exactly as it
// is and the diff waits in a PropertyChangeRequest for an admin decision.
//
// Edits to a listing that is not live still apply directly — there is nothing
// published to protect.
async function updateProperty(id, partnerId, data) {
  const property = await prisma.property.findUnique({ where: { id } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.partnerId !== partnerId) throw new ApiError(403, 'Not your listing');

  const FORBIDDEN = ['publishStatus', 'isVerified', 'partnerId'];
  FORBIDDEN.forEach((f) => delete data[f]);

  if (property.publishStatus === 'APPROVED') {
    const changes = diffProperty(property, data);
    const fieldCount = Object.keys(changes).length;
    if (!fieldCount) {
      return { property, changeRequest: null, message: 'No changes to review' };
    }

    // Only the newest pending edit is reviewable. Older ones are marked
    // SUPERSEDED rather than deleted, so the partner's edit history stays
    // auditable and the admin queue never shows two competing diffs for the
    // same listing.
    const [, changeRequest] = await prisma.$transaction([
      prisma.propertyChangeRequest.updateMany({
        where: { propertyId: id, status: 'PENDING' },
        data: { status: 'SUPERSEDED' },
      }),
      prisma.propertyChangeRequest.create({
        data: { propertyId: id, partnerId, changes, fieldCount },
      }),
    ]);

    return { property, changeRequest, message: 'Changes submitted for admin review. Your listing stays live until they are reviewed.' };
  }

  const updated = await prisma.property.update({ where: { id }, data });
  return { property: updated, changeRequest: null, message: 'Listing updated' };
}

async function getFeaturedProperties() {
  return withCache(CACHE_KEYS.FEATURED_PROPERTIES, 600, () => prisma.property.findMany({
    where: { publishStatus: 'APPROVED', isFeatured: true },
    take: 12,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, title: true, slug: true, price: true, monthlyRent: true,
      propertyType: true, listingType: true, bhk: true, balconies: true, locality: true, city: true,
      images: true, coverImageIndex: true, isVerified: true, facing: true, furnishing: true,
      previousPrice: true, priceChange6m: true, unitsLeft: true, viewsThisWeek: true,
      latitude: true, longitude: true,
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
