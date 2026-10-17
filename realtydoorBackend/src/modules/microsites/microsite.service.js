const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { withCache, cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { createAuditLog } = require('../../lib/auditLog');
const { getPropertyByIdOrSlug } = require('../properties/properties.service');
const { throwForDuplicateKey } = require('./microsite.errors');

// Public lookup — reuses getPropertyByIdOrSlug (not rebuilt here) so the
// APPROVED + !isB2BOnly rules, the safe partner fetch and the full
// property response shape all stay in exactly one place. countView:false
// — a microsite view is deliberately not counted toward the property's
// own viewsThisWeek (decided: don't count microsite views for now).
//
// "Property not found" is returned (same message/shape as the real
// property page) for every reason the spec lists: slug doesn't exist,
// enabled:false, property not APPROVED, property isB2BOnly — the last two
// are already enforced inside getPropertyByIdOrSlug itself.
async function getBySlug(slug) {
  return withCache(CACHE_KEYS.micrositeSlug(slug), 60, async () => {
    const microsite = await prisma.microsite.findUnique({ where: { slug } });
    if (!microsite || !microsite.enabled) throw new ApiError(404, 'Property not found');

    const result = await getPropertyByIdOrSlug(microsite.propertyId, { countView: false });
    return { ...result, micrositeSlug: microsite.slug };
  });
}

// BE-16's safety net gives this the default NOT_FOUND code (no code
// attached here); errors thrown through withCache above propagate
// unchanged, so a 404 raised deep inside getPropertyByIdOrSlug is never
// itself cached — only a successful lookup is memoized, same as every
// other withCache call site in this codebase.

async function listForAdmin(skip, limit) {
  const [data, total] = await prisma.$transaction([
    prisma.microsite.findMany({
      skip, take: limit, orderBy: { createdAt: 'desc' },
      select: { id: true, propertyId: true, slug: true, enabled: true, createdAt: true },
    }),
    prisma.microsite.count(),
  ]);
  return { data, total };
}

async function create({ propertyId, slug }, adminId, ip) {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, publishStatus: true } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.publishStatus !== 'APPROVED') {
    throw new ApiError(400, `Only an APPROVED property can have a microsite (current status: ${property.publishStatus})`);
  }

  let microsite;
  try {
    microsite = await prisma.microsite.create({ data: { propertyId, slug, createdBy: adminId } });
  } catch (err) {
    if (err.code === 'P2002') throwForDuplicateKey(err);
    throw err;
  }

  await createAuditLog({
    adminId, action: 'MICROSITE_CREATED', targetType: 'Microsite', targetId: microsite.id,
    after: { propertyId, slug }, ipAddress: ip,
  });

  return microsite;
}

async function update(id, data, adminId, ip) {
  const existing = await prisma.microsite.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Microsite not found');

  let updated;
  try {
    updated = await prisma.microsite.update({ where: { id }, data });
  } catch (err) {
    if (err.code === 'P2002') throwForDuplicateKey(err);
    throw err;
  }

  await createAuditLog({
    adminId, action: 'MICROSITE_UPDATED', targetType: 'Microsite', targetId: id,
    before: { slug: existing.slug, enabled: existing.enabled }, after: data, ipAddress: ip,
  });

  // The old slug must stop resolving immediately on a slug change — clear
  // both, not just the new one (there's nothing to clear for the new slug
  // yet, but it's harmless/cheap to do so defensively).
  cacheDel(CACHE_KEYS.micrositeSlug(existing.slug));
  if (updated.slug !== existing.slug) cacheDel(CACHE_KEYS.micrositeSlug(updated.slug));

  return updated;
}

async function remove(id, adminId, ip) {
  const existing = await prisma.microsite.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Microsite not found');

  await prisma.microsite.delete({ where: { id } });

  await createAuditLog({
    adminId, action: 'MICROSITE_DELETED', targetType: 'Microsite', targetId: id,
    before: { propertyId: existing.propertyId, slug: existing.slug }, ipAddress: ip,
  });

  cacheDel(CACHE_KEYS.micrositeSlug(existing.slug));
}

// Called from admin.service.js's approveProperty/rejectProperty — a
// microsite's visibility is gated on its property's publishStatus at READ
// time (getBySlug, via getPropertyByIdOrSlug), but the 60s cache can mask
// that for up to a minute without this. Fire-and-forget from the caller's
// side; a no-op (not an error) when the property has no microsite.
async function invalidateCacheForPropertyStatusChange(propertyId) {
  const microsite = await prisma.microsite.findUnique({ where: { propertyId }, select: { slug: true } });
  if (microsite) cacheDel(CACHE_KEYS.micrositeSlug(microsite.slug));
}

module.exports = { getBySlug, listForAdmin, create, update, remove, invalidateCacheForPropertyStatusChange };
