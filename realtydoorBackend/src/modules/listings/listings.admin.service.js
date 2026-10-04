const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const { cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');
const { withMapLinkCoords } = require('./location.service');

// Fields a partner must never set through a change request, mirroring the
// FORBIDDEN list in properties.service.js. Re-applied here at approval time
// rather than trusted from submission time, so a request stored before this
// list grew cannot slip a now-forbidden field through on approval.
const FORBIDDEN_FIELDS = ['publishStatus', 'isVerified', 'partnerId', 'slug', 'id'];

// Docs 4.13 asks to filter override history by "impact". Impact is not a
// stored concept anywhere in this schema, so rather than invent a column it is
// derived from which field changed: the fields below are the ones that change
// what a buyer is actually being sold, or where it is. Everything else is
// presentational. The list is the definition, and it is returned in the
// response so a caller can see exactly what HIGH means rather than guess.
const HIGH_IMPACT_FIELDS = [
  'price', 'monthlyRent', 'carpetArea', 'builtUpArea', 'plotArea',
  'address', 'locality', 'city', 'pincode', 'latitude', 'longitude',
  'reraNumber', 'propertyType', 'listingType', 'bhk', 'possessionDate',
];

function impactOf(field) {
  return HIGH_IMPACT_FIELDS.includes(field) ? 'HIGH' : 'NORMAL';
}

// Stored diffs hold JSON-encoded values so arrays and nulls survive. Decode
// for presentation, but never throw on a value that predates the encoding
// convention: show it raw rather than failing the whole listing.
function decode(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
}

function presentChanges(changes) {
  return Object.entries(changes || {}).map(([field, pair]) => ({
    field,
    before: decode(pair.before),
    after: decode(pair.after),
    impact: impactOf(field),
  }));
}

// ─── 4.8 / 4.9 — partner change requests on live listings ────────────────────

const CHANGE_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED'];

async function listChangeRequests(query, skip, limit) {
  const where = {};
  // Defaults to the review queue. Pass ?status=ALL for every row.
  if (query.status && query.status !== 'ALL') {
    if (!CHANGE_REQUEST_STATUSES.includes(query.status)) {
      throw new ApiError(400, `status must be one of ${CHANGE_REQUEST_STATUSES.join(', ')} or ALL`);
    }
    where.status = query.status;
  } else if (!query.status) {
    where.status = 'PENDING';
  }
  if (query.propertyId) where.propertyId = query.propertyId;
  if (query.partnerId) where.partnerId = query.partnerId;

  const [rows, total] = await Promise.all([
    prisma.propertyChangeRequest.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        property: { select: { id: true, title: true, slug: true, city: true, locality: true, publishStatus: true } },
        partner: { select: { id: true, name: true, companyName: true } },
      },
    }),
    prisma.propertyChangeRequest.count({ where }),
  ]);

  const data = rows.map((r) => {
    const changes = presentChanges(r.changes);
    return {
      id: r.id,
      status: r.status,
      fieldCount: r.fieldCount,
      // Surfaced on the list row so the queue can sort the risky ones up
      // without fetching every diff.
      hasHighImpact: changes.some((c) => c.impact === 'HIGH'),
      fields: changes.map((c) => c.field),
      property: r.property,
      partner: r.partner,
      reviewNote: r.reviewNote,
      reviewedAt: r.reviewedAt,
      createdAt: r.createdAt,
    };
  });

  return { data, total };
}

async function getChangeRequest(id) {
  const cr = await prisma.propertyChangeRequest.findUnique({
    where: { id },
    include: {
      property: true,
      partner: { select: { id: true, name: true, companyName: true, phone: true } },
    },
  });
  if (!cr) throw new ApiError(404, 'Change request not found');

  const changes = presentChanges(cr.changes);

  // A diff submitted against one version of the listing may no longer line up
  // with it: an admin edit, or an earlier approved request, can have moved the
  // same field in the meantime. Those fields are flagged so the reviewer sees
  // that approving would overwrite a later change by someone else, rather than
  // finding out afterwards from the edit log.
  const conflicts = changes
    .filter((c) => JSON.stringify(cr.property[c.field] ?? null) !== JSON.stringify(c.before))
    .map((c) => ({ field: c.field, expectedBefore: c.before, actualCurrent: cr.property[c.field] ?? null }));

  return {
    id: cr.id,
    status: cr.status,
    fieldCount: cr.fieldCount,
    changes,
    conflicts,
    hasConflicts: conflicts.length > 0,
    highImpactFields: HIGH_IMPACT_FIELDS,
    property: cr.property,
    partner: cr.partner,
    reviewNote: cr.reviewNote,
    reviewedByAdminId: cr.reviewedByAdminId,
    reviewedAt: cr.reviewedAt,
    createdAt: cr.createdAt,
  };
}

async function approveChangeRequest(id, { adminId, adminName, note, force }, ip) {
  const cr = await prisma.propertyChangeRequest.findUnique({
    where: { id },
    include: { property: true },
  });
  if (!cr) throw new ApiError(404, 'Change request not found');
  if (cr.status !== 'PENDING') {
    throw new ApiError(400, `This request is already ${cr.status} and cannot be approved`);
  }

  const property = cr.property;
  const entries = Object.entries(cr.changes || {})
    .filter(([field]) => !FORBIDDEN_FIELDS.includes(field));

  if (!entries.length) throw new ApiError(400, 'This request has no applicable changes');

  // Refuse by default when the listing moved underneath the request. Approving
  // anyway is a real choice an admin may need to make, so it is allowed with
  // force=true, but it is never the silent default.
  //
  // pair.before is ALREADY a JSON-encoded string (diffProperty in
  // properties.service.js stores JSON.stringify(value), not the raw value) —
  // it must be compared directly against JSON.stringify(property[field]),
  // not re-stringified. An earlier version wrapped it in JSON.stringify()
  // again, which turned "7500000" into "\"7500000\"" and made the two sides
  // structurally unable to match for ANY field, on ANY request, ever — every
  // normal approval 409'd as "the listing changed" even when nothing had.
  // getChangeRequest's read-only conflict check (above) never had this bug:
  // it decodes pair.before through presentChanges() before comparing, so it
  // compares real values, not JSON text. This was missed in the original
  // live verification because every test of this path happened to use
  // force=true, which bypasses the check regardless of whether it's correct
  // — the plain, no-interference approval was never actually exercised
  // without force until this was caught.
  const conflicts = entries
    .filter(([field, pair]) => JSON.stringify(property[field] ?? null) !== pair.before)
    .map(([field]) => field);
  if (conflicts.length && !force) {
    throw new ApiError(409,
      `The listing changed after this request was submitted (${conflicts.join(', ')}). `
      + 'Re-check the diff and resend with force=true to apply it anyway.');
  }

  let data = {};
  for (const [field, pair] of entries) data[field] = decode(pair.after);
  // 4.6 — if the approved diff changes mapLink, its parsed coordinates have to
  // move with it. These two derived fields are applied but deliberately not
  // written to the edit log: the log records what a human changed, and these
  // follow mechanically from mapLink.
  data = withMapLinkCoords(data);

  // Attributed to the partner who made the edit, not the admin who approved
  // it: the edit log answers "who changed this listing", and the approving
  // admin is recorded in editNote alongside their own audit-log entry.
  const logRows = entries.map(([field, pair]) => ({
    propertyId: property.id,
    editedBy: cr.partnerId,
    editedByName: 'Partner (approved by admin)',
    fieldChanged: field,
    oldValue: pair.before,
    newValue: pair.after,
    editNote: `Change request ${cr.id} approved by ${adminName}${note ? `: ${note}` : ''}`,
  }));

  const [updated] = await prisma.$transaction([
    prisma.property.update({ where: { id: property.id }, data }),
    prisma.propertyChangeRequest.update({
      where: { id },
      data: { status: 'APPROVED', reviewedByAdminId: adminId, reviewNote: note || null, reviewedAt: new Date() },
    }),
    ...logRows.map((row) => prisma.propertyEditLog.create({ data: row })),
  ]);

  await createNotification({
    userId: cr.partnerId,
    title: 'Listing changes approved',
    message: `Your ${entries.length} change(s) to "${property.title}" are now live.`,
    type: 'PROPERTY_CHANGES_APPROVED',
    linkUrl: `/partner/listings/${property.id}`,
  });

  await createAuditLog({
    adminId, action: 'PROPERTY_CHANGE_REQUEST_APPROVED', targetType: 'Property', targetId: property.id,
    before: Object.fromEntries(entries.map(([f, v]) => [f, v.before])),
    after: Object.fromEntries(entries.map(([f, v]) => [f, v.after])),
    ipAddress: ip,
  });

  // The listing is live, so its cached views now hold stale content.
  cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
  cacheDel(CACHE_KEYS.localityPage(property.city, property.locality));
  if (updated.city !== property.city || updated.locality !== property.locality) {
    cacheDel(CACHE_KEYS.localityPage(updated.city, updated.locality));
  }

  return { property: updated, appliedFields: entries.map(([f]) => f), forcedOverConflicts: conflicts };
}

async function rejectChangeRequest(id, { adminId, note }, ip) {
  const cr = await prisma.propertyChangeRequest.findUnique({
    where: { id },
    include: { property: { select: { id: true, title: true } } },
  });
  if (!cr) throw new ApiError(404, 'Change request not found');
  if (cr.status !== 'PENDING') {
    throw new ApiError(400, `This request is already ${cr.status} and cannot be rejected`);
  }

  const updated = await prisma.propertyChangeRequest.update({
    where: { id },
    data: { status: 'REJECTED', reviewedByAdminId: adminId, reviewNote: note, reviewedAt: new Date() },
  });

  await createNotification({
    userId: cr.partnerId,
    title: 'Listing changes not approved',
    message: `Your changes to "${cr.property.title}" were not applied. Reason: ${note}`,
    type: 'PROPERTY_CHANGES_REJECTED',
    linkUrl: `/partner/listings/${cr.property.id}`,
  });

  await createAuditLog({
    adminId, action: 'PROPERTY_CHANGE_REQUEST_REJECTED', targetType: 'Property', targetId: cr.property.id,
    after: { changeRequestId: id, note },
    ipAddress: ip,
  });

  return updated;
}

// ─── 4.12 / 4.13 — cross-property override history ───────────────────────────
//
// PropertyEditLog already existed but was only readable as the last 10 rows
// nested inside one property. This is the paginated, filterable list across
// every property that the override-history page needs.

async function listEditLogs(query, skip, limit) {
  const where = {};
  if (query.propertyId) where.propertyId = query.propertyId;
  if (query.editedBy) where.editedBy = query.editedBy;
  if (query.field) where.fieldChanged = query.field;
  if (query.impact === 'HIGH') where.fieldChanged = { in: HIGH_IMPACT_FIELDS };
  if (query.impact === 'NORMAL') where.fieldChanged = { notIn: HIGH_IMPACT_FIELDS };
  if (query.from || query.to) {
    where.editedAt = {};
    if (query.from) where.editedAt.gte = new Date(query.from);
    if (query.to) where.editedAt.lte = new Date(query.to);
  }

  const [rows, total] = await Promise.all([
    prisma.propertyEditLog.findMany({
      where, skip, take: limit,
      orderBy: { editedAt: 'desc' },
      include: {
        property: { select: { id: true, title: true, slug: true, city: true, publishStatus: true } },
      },
    }),
    prisma.propertyEditLog.count({ where }),
  ]);

  const data = rows.map((r) => ({
    id: r.id,
    property: r.property,
    editedBy: r.editedBy,
    editedByName: r.editedByName,
    field: r.fieldChanged,
    impact: impactOf(r.fieldChanged),
    before: decode(r.oldValue),
    after: decode(r.newValue),
    note: r.editNote,
    editedAt: r.editedAt,
  }));

  return { data, total };
}

module.exports = {
  HIGH_IMPACT_FIELDS, CHANGE_REQUEST_STATUSES,
  listChangeRequests, getChangeRequest, approveChangeRequest, rejectChangeRequest,
  listEditLogs,
};
