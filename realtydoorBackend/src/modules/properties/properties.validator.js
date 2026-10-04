const { z } = require('zod');
const { paginationSchema } = require('../../utils/validators');

const createPropertySchema = z.object({
  title: z.string().min(5).max(200),
  description: z.string().min(20),
  price: z.number().positive().optional(),
  monthlyRent: z.number().positive().optional(),
  priceNegotiable: z.boolean().optional(),
  propertyType: z.enum(['FLAT', 'INDEPENDENT_HOUSE', 'VILLA', 'PLOT', 'COMMERCIAL_OFFICE', 'RETAIL_SHOP']),
  listingType: z.enum(['SALE', 'RENT', 'LEASE']),
  // SOLD/RENTED are deliberately not partner-settable here — same as before,
  // only PRE_LAUNCH is newly added for project-status reporting.
  propertyStatus: z.enum(['PRE_LAUNCH', 'READY_TO_MOVE', 'UNDER_CONSTRUCTION']).optional(),
  bhk: z.number().int().min(1).max(10).optional(),
  bathrooms: z.number().int().min(1).optional(),
  carpetArea: z.number().positive().optional(),
  builtUpArea: z.number().positive().optional(),
  plotArea: z.number().positive().optional(),
  floorNumber: z.number().int().min(0).optional(),
  totalFloors: z.number().int().min(1).optional(),
  ageOfProperty: z.number().int().min(0).optional(),
  furnishing: z.string().optional(),
  facing: z.string().optional(),
  possessionDate: z.string().datetime().optional(),
  address: z.string().min(5),
  locality: z.string().min(2),
  city: z.string().min(2),
  state: z.string().min(2),
  pincode: z.string().regex(/^\d{6}$/),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  nearbyLandmarks: z.array(z.string()).optional(),

  // 4.6 — the partner's own location evidence. mapLink is parsed into
  // mapLinkLatitude/Longitude on write (lib/mapLink.js, no geocoding service
  // involved); partnerPin* is the pin they dropped, kept separate so admin
  // can cross-check the two rather than one overwriting the other.
  mapLink: z.string().max(2000).optional(),
  partnerPinLatitude: z.number().min(-90).max(90).optional(),
  partnerPinLongitude: z.number().min(-180).max(180).optional(),
  reraNumber: z.string().optional(),
  bankApprovals: z.array(z.string()).optional(),

  // 4.5 — a mortgaged unit cannot transfer without the lender's NOC.
  // isMortgaged is nullable rather than defaulted: null means "not recorded",
  // which is the truth for every listing that predates these fields, and is
  // a different thing from someone having actively answered "no".
  isMortgaged: z.boolean().optional(),
  mortgageLender: z.string().max(200).optional(),
  loanNocStatus: z.enum(['NOT_REQUIRED', 'PENDING', 'RECEIVED', 'REJECTED']).optional(),
  loanNocUrl: z.string().url().optional(),
  // R19 — turns on the CO_OWNER_CONSENT checklist item (checklist.service.js).
  // Nullable, same reasoning as isMortgaged: null means "not recorded".
  hasCoOwners: z.boolean().optional(),
  amenities: z.array(z.string()).optional(),
  societyFeatures: z.array(z.string()).optional(),
  metaTitle: z.string().max(60).optional(),
  metaDescription: z.string().max(160).optional(),

  // Project-level details — for a developer-led project/township listing
  // (see isFeaturedProject), not a regular single-unit listing.
  developer: z.string().max(200).optional(),
  landAreaValue: z.number().positive().optional(),
  landAreaUnit: z.string().max(20).optional(),
  openSpacePct: z.number().int().min(0).max(100).optional(),
  totalUnits: z.number().int().positive().optional(),
});

const searchSchema = paginationSchema.extend({
  q: z.string().optional(),
  city: z.string().optional(),
  locality: z.string().optional(),
  propertyType: z.string().optional(),
  listingType: z.string().optional(),
  bhk: z.coerce.number().int().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  minArea: z.coerce.number().optional(),
  maxArea: z.coerce.number().optional(),
  furnishing: z.string().optional(),
  propertyStatus: z.string().optional(),
  isVerified: z.coerce.boolean().optional(),
  amenities: z.string().optional(),
  sort: z.enum(['price_asc', 'price_desc', 'newest', 'area_asc']).optional(),
});

const constructionUpdateSchema = z.object({
  milestoneTitle: z.string().min(3).max(200),
  description:    z.string().max(2000).optional(),
  mediaUrls:      z.array(z.string().url()).max(10).optional(),
  completionPct:  z.number().int().min(0).max(100).optional(),
});

module.exports = { createPropertySchema, searchSchema, constructionUpdateSchema };
