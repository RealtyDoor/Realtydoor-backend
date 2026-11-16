'use strict';

// Is a single listing still on the market? (Inventory for flats, houses, plots, offices and shops; builder projects track their own
// units in projects/inventory.service.js.) The owner of the listing or an admin sets it. SOLD and RENTED listings leave search and the
// homepage but keep their page with a ribbon; they take no new enquiries. ON_HOLD stays listed with a ribbon.

const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const { createAuditLog } = require('../../lib/auditLog');
const { notifyAdmins } = require('../../lib/notifications');
const { cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');

const VALUES = ['AVAILABLE', 'ON_HOLD', 'SOLD', 'RENTED'];
const OFF_MARKET = ['SOLD', 'RENTED'];

// Where-fragment: the listing is not sold or rented. A missing field counts as available. (A plain NOT-in matches nothing when the
// field is missing on MongoDB, which would hide every existing listing, so the three cases are spelled out.)
const ON_MARKET = { OR: [{ availability: null }, { availability: { isSet: false } }, { availability: { in: ['AVAILABLE', 'ON_HOLD'] } }] };

async function setAvailability(propertyId, availability, { note, actor, ip }) {
  if (!VALUES.includes(availability)) throw new ApiError(400, 'Choose Available, On hold, Sold or Rented.', { code: 'INVALID_AVAILABILITY' });
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, title: true, slug: true, partnerId: true, publishStatus: true, listingType: true, availability: true, projectId: true, propertyType: true },
  });
  if (!property) throw new ApiError(404, 'Property not found');
  if (actor.role !== 'ADMIN' && property.partnerId !== actor.id) throw new ApiError(404, 'Property not found');
  if (property.publishStatus !== 'APPROVED') {
    throw new ApiError(409, 'Only a live listing can be marked sold, rented or on hold.', { code: 'LISTING_NOT_LIVE' });
  }
  const isRent = ['RENT', 'LEASE'].includes(property.listingType);
  if (availability === 'SOLD' && isRent) throw new ApiError(400, 'This is a rent listing: mark it Rented, not Sold.', { code: 'USE_RENTED' });
  if (availability === 'RENTED' && !isRent) throw new ApiError(400, 'This is a sale listing: mark it Sold, not Rented.', { code: 'USE_SOLD' });

  const before = property.availability || 'AVAILABLE';
  if (before === availability) return { property, changed: false, openLeads: 0 };

  // Conditional on what we read, so two changes at once do not both apply.
  const sameBefore = property.availability ? { availability: property.availability } : { OR: [{ availability: null }, { availability: { isSet: false } }] };
  const moved = await prisma.property.updateMany({
    where: { AND: [{ id: propertyId }, sameBefore] },
    data: { availability: availability === 'AVAILABLE' ? null : availability, availabilityChangedAt: new Date() },
  });
  if (!moved.count) throw new ApiError(409, 'This listing was just changed. Reload and try again.', { code: 'LISTING_CHANGED' });

  await createAuditLog({
    adminId: actor.id, actorRole: actor.role === 'ADMIN' ? 'ADMIN' : 'PARTNER', action: 'LISTING_AVAILABILITY', targetType: 'Property', targetId: propertyId,
    before: { availability: before }, after: { availability }, reason: note || null, ipAddress: ip,
  }).catch((err) => logger.warn('[Availability] audit write failed', { propertyId, error: err.message }));

  let openLeads = 0;
  if (OFF_MARKET.includes(availability)) {
    openLeads = await prisma.lead.count({ where: { propertyId, status: { notIn: ['DROPPED', 'CLOSED'] } } }).catch(() => 0);
    if (openLeads > 0) {
      notifyAdmins({
        title: `Listing marked ${availability.toLowerCase()} with open enquiries`,
        message: `"${property.title}" was marked ${availability.toLowerCase()} and still has ${openLeads} open lead${openLeads > 1 ? 's' : ''}. Tell those buyers or move them to another listing.`,
        type: 'LISTING_OFF_MARKET', linkUrl: `/admin/properties/${propertyId}`,
      }).catch(() => null);
    }
  }
  cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
  try { await require('../microsites/microsite.service').invalidateCacheForPropertyStatusChange(propertyId); } catch { /* a minute at most */ }
  return { property: { ...property, availability: availability === 'AVAILABLE' ? null : availability }, changed: true, openLeads };
}

module.exports = { VALUES, OFF_MARKET, ON_MARKET, setAvailability };
