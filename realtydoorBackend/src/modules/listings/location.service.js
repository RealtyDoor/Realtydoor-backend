const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createAuditLog } = require('../../lib/auditLog');
const { createNotification } = require('../../lib/notifications');
const { cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { getConfigNumber } = require('../config/config.service');
const { parseMapLink, distanceMetres, isValidLatLng } = require('../../lib/mapLink');

// How far the partner's pin may sit from the map-link coordinates before the
// listing is flagged for a human look. Admin-settable; 300 m is a default, not
// a rule handed down by the business, and it is returned in every response so
// nobody has to guess what threshold produced a flag.
const DEFAULT_TOLERANCE_M = 300;

// Any write that sets mapLink must also refresh the coordinates read out of
// it, or the stored pair silently describes the previous link. Used by every
// path that can change mapLink: listing creation, admin location edit, and the
// approval of a partner change request.
function withMapLinkCoords(data) {
  if (!Object.prototype.hasOwnProperty.call(data, 'mapLink')) return data;
  if (!data.mapLink) {
    return { ...data, mapLink: null, mapLinkLatitude: null, mapLinkLongitude: null };
  }
  const parsed = parseMapLink(data.mapLink);
  return { ...data, mapLinkLatitude: parsed.latitude, mapLinkLongitude: parsed.longitude };
}

const LOCATION_SELECT = {
  id: true, title: true, slug: true, publishStatus: true, partnerId: true,
  address: true, locality: true, city: true, state: true, pincode: true,
  latitude: true, longitude: true,
  mapLink: true, mapLinkLatitude: true, mapLinkLongitude: true,
  partnerPinLatitude: true, partnerPinLongitude: true,
  locationSource: true, locationVerifiedAt: true, locationVerifiedByAdminId: true,
};

function pointOf(lat, lng) {
  return isValidLatLng(lat, lng) ? { latitude: lat, longitude: lng } : null;
}

// ─── 4.6 — location check ────────────────────────────────────────────────────

async function getLocationCheck(propertyId) {
  const p = await prisma.property.findUnique({
    where: { id: propertyId },
    select: LOCATION_SELECT,
  });
  if (!p) throw new ApiError(404, 'Property not found');

  const toleranceMetres = await getConfigNumber('listing_pin_tolerance_metres', DEFAULT_TOLERANCE_M);

  const canonical = pointOf(p.latitude, p.longitude);
  const fromLink = pointOf(p.mapLinkLatitude, p.mapLinkLongitude);
  const pin = pointOf(p.partnerPinLatitude, p.partnerPinLongitude);

  // Re-parsed rather than read from storage, so the screen can explain WHY a
  // stored link yielded no coordinates (shortened link, wrong format) instead
  // of just showing blanks.
  const linkParse = p.mapLink ? parseMapLink(p.mapLink) : null;

  const distances = {
    // 4.6's actual ask: how far the partner's pin is from the map link.
    partnerPinToMapLink: distanceMetres(pin, fromLink),
    canonicalToPartnerPin: distanceMetres(canonical, pin),
    canonicalToMapLink: distanceMetres(canonical, fromLink),
  };

  const issues = [];
  if (!canonical) {
    issues.push({ key: 'NO_COORDINATES', detail: 'This listing has no latitude/longitude at all, so it cannot be placed on a map.' });
  }
  if (!p.mapLink) {
    issues.push({ key: 'NO_MAP_LINK', detail: 'No map link was provided for this listing.' });
  } else if (!fromLink) {
    issues.push({ key: 'UNPARSEABLE_MAP_LINK', detail: linkParse.reason });
  }
  if (!pin) {
    issues.push({ key: 'NO_PARTNER_PIN', detail: 'The partner did not drop a pin, so there is nothing to cross-check the map link against.' });
  }
  if (distances.partnerPinToMapLink != null && distances.partnerPinToMapLink > toleranceMetres) {
    issues.push({
      key: 'PIN_MAP_MISMATCH',
      detail: `The partner's pin is ${distances.partnerPinToMapLink} m from the map link, over the ${toleranceMetres} m tolerance.`,
    });
  }
  if (!p.locationVerifiedAt) {
    issues.push({ key: 'UNVERIFIED', detail: 'No admin has confirmed this location yet.' });
  }

  return {
    propertyId: p.id,
    title: p.title,
    publishStatus: p.publishStatus,
    address: {
      address: p.address, locality: p.locality, city: p.city,
      state: p.state, pincode: p.pincode,
    },
    canonical: {
      latitude: p.latitude,
      longitude: p.longitude,
      source: p.locationSource,
      verifiedAt: p.locationVerifiedAt,
      verifiedByAdminId: p.locationVerifiedByAdminId,
    },
    mapLink: {
      url: p.mapLink,
      latitude: p.mapLinkLatitude,
      longitude: p.mapLinkLongitude,
      // null when there is no link at all; otherwise says why parsing failed.
      parseReason: linkParse && linkParse.latitude == null ? linkParse.reason : null,
      parsePattern: linkParse ? linkParse.pattern || null : null,
    },
    partnerPin: {
      latitude: p.partnerPinLatitude,
      longitude: p.partnerPinLongitude,
    },
    distances,
    toleranceMetres,
    // null, not true, when there is nothing to compare — "no disagreement
    // found" and "no comparison possible" are different answers.
    withinTolerance: distances.partnerPinToMapLink == null
      ? null
      : distances.partnerPinToMapLink <= toleranceMetres,
    issues,
    // Stated explicitly rather than left as a silent gap: deriving
    // coordinates from the street address needs a third-party geocoding
    // provider, and none has been chosen. Everything above works without one.
    addressGeocoding: {
      available: false,
      reason: 'Address-to-coordinates geocoding needs a third-party provider, which has not been selected. Coordinates here come from the pasted map link and the partner pin only.',
    },
  };
}

// ─── 4.7 — admin location edit, with audit ───────────────────────────────────

async function updateLocation(propertyId, data, { adminId, adminName }, ip) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: LOCATION_SELECT,
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const { reason, mapLink, latitude, longitude } = data;

  let update = {};
  if (mapLink !== undefined) update.mapLink = mapLink || null;
  update = withMapLinkCoords(update);

  // Explicit coordinates win and are marked as an admin override. Otherwise, a
  // link that parsed supplies the canonical pair — which is the common case:
  // the admin pastes the correct link and expects the listing to move.
  if (latitude !== undefined && longitude !== undefined) {
    update.latitude = latitude;
    update.longitude = longitude;
    update.locationSource = 'ADMIN_OVERRIDE';
  } else if (update.mapLinkLatitude != null) {
    update.latitude = update.mapLinkLatitude;
    update.longitude = update.mapLinkLongitude;
    update.locationSource = 'MAP_LINK';
  }

  update.locationVerifiedAt = new Date();
  update.locationVerifiedByAdminId = adminId;

  // Only fields that actually move are logged, so an admin confirming a
  // correct location does not litter the history with no-op rows. The
  // verification stamp is excluded from the diff for the same reason: it
  // changes on every call by definition.
  const AUDIT_EXEMPT = ['locationVerifiedAt', 'locationVerifiedByAdminId'];
  const changed = Object.entries(update).filter(
    ([field, value]) => !AUDIT_EXEMPT.includes(field)
      && JSON.stringify(property[field] ?? null) !== JSON.stringify(value ?? null),
  );

  const logRows = changed.map(([field, value]) => ({
    propertyId,
    editedBy: adminId,
    editedByName: adminName,
    fieldChanged: field,
    oldValue: property[field] != null ? JSON.stringify(property[field]) : null,
    newValue: value != null ? JSON.stringify(value) : null,
    editNote: `Location edit: ${reason}`,
  }));

  const [updated] = await prisma.$transaction([
    prisma.property.update({ where: { id: propertyId }, data: update }),
    ...logRows.map((row) => prisma.propertyEditLog.create({ data: row })),
  ]);

  await createAuditLog({
    adminId, action: 'PROPERTY_LOCATION_EDITED', targetType: 'Property', targetId: propertyId,
    before: Object.fromEntries(changed.map(([f]) => [f, property[f] ?? null])),
    after: Object.fromEntries(changed.map(([f, v]) => [f, v ?? null])),
    ipAddress: ip,
  });

  // The partner is told only when something actually moved; a bare
  // confirmation is not worth a notification.
  if (changed.length) {
    await createNotification({
      userId: property.partnerId,
      title: 'Listing location updated by Admin',
      message: `Admin corrected the location on "${property.title}". Reason: ${reason}`,
      type: 'PROPERTY_LOCATION_EDITED',
      linkUrl: `/partner/listings/${propertyId}`,
    });
  }

  if (property.publishStatus === 'APPROVED') {
    cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
    cacheDel(CACHE_KEYS.localityPage(property.city, property.locality));
  }

  return {
    location: await getLocationCheck(propertyId),
    changedFields: changed.map(([f]) => f),
    confirmedOnly: changed.length === 0,
  };
}

module.exports = {
  withMapLinkCoords, getLocationCheck, updateLocation, DEFAULT_TOLERANCE_M,
};
