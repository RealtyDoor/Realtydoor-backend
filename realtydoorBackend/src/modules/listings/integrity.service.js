const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const logger = require('../../lib/logger');

// ─── 4.3 — exclusive mandates ────────────────────────────────────────────────

// Only ACTIVE and REVOKED are stored. EXPIRED is derived here, every time it
// is read, rather than written by a scheduled job — a stored "expired" flag is
// wrong for the whole window between the expiry instant and the next job run,
// and this way there is no window and no job.
function effectiveStatusOf(mandate) {
  if (mandate.status === 'REVOKED') return 'REVOKED';
  return mandate.expiryDate < new Date() ? 'EXPIRED' : 'ACTIVE';
}

function presentMandate(m) {
  return { ...m, effectiveStatus: effectiveStatusOf(m) };
}

// "Currently in force" means stored ACTIVE *and* not past its expiry date.
// Expressed as a Prisma filter so the check happens in the query rather than
// by loading every mandate and filtering in memory.
function inForceFilter(now = new Date()) {
  return { status: 'ACTIVE', expiryDate: { gt: now } };
}

function normalisePan(pan) {
  return pan ? pan.replace(/\s+/g, '').toUpperCase() : null;
}

async function createMandate(propertyId, data, adminId, ip) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, title: true, partnerId: true },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const startDate = new Date(data.startDate);
  const expiryDate = new Date(data.expiryDate);
  if (expiryDate <= startDate) {
    throw new ApiError(400, 'expiryDate must be after startDate');
  }

  // One mandate in force per listing. Checked rather than enforced by a
  // unique index, because "in force" depends on the current time and a
  // partial index cannot express that. Two admins creating a mandate for the
  // same listing in the same instant could both pass; the overlap detector
  // below catches that case and raises a MANDATE_OVERLAP conflict, so it
  // surfaces rather than going unnoticed.
  const existing = await prisma.exclusiveMandate.findFirst({
    where: { propertyId, ...inForceFilter() },
  });
  if (existing) {
    throw new ApiError(409,
      `This listing already has a mandate in force until ${existing.expiryDate.toISOString().slice(0, 10)}. `
      + 'Revoke it before issuing a new one.');
  }

  const mandate = await prisma.exclusiveMandate.create({
    data: {
      propertyId,
      // The mandate belongs to whoever is marketing the listing.
      partnerId: data.partnerId || property.partnerId,
      ownerName: data.ownerName,
      ownerPhone: data.ownerPhone,
      ownerEmail: data.ownerEmail || null,
      ownerPan: normalisePan(data.ownerPan),
      startDate,
      expiryDate,
      documentUrl: data.documentUrl || null,
      note: data.note || null,
      createdByAdminId: adminId || null,
    },
  });

  if (adminId) {
    await createAuditLog({
      adminId, action: 'MANDATE_CREATED', targetType: 'Property', targetId: propertyId,
      after: { mandateId: mandate.id, ownerName: mandate.ownerName, expiryDate },
      ipAddress: ip,
    });
  }

  // A new mandate is exactly when the agent/owner and overlap checks become
  // answerable, so run them now rather than waiting for someone to ask.
  const conflicts = await detectConflicts(propertyId).catch((err) => {
    logger.error('[createMandate] conflict detection failed', { propertyId, error: err.message });
    return [];
  });

  return { mandate: presentMandate(mandate), conflicts };
}

async function listMandates(query, skip, limit) {
  const where = {};
  if (query.propertyId) where.propertyId = query.propertyId;
  if (query.partnerId) where.partnerId = query.partnerId;
  // Filtering by the derived status has to be expressed as the underlying
  // stored condition, since effectiveStatus is not a column.
  if (query.status === 'ACTIVE') Object.assign(where, inForceFilter());
  if (query.status === 'EXPIRED') Object.assign(where, { status: 'ACTIVE', expiryDate: { lte: new Date() } });
  if (query.status === 'REVOKED') where.status = 'REVOKED';

  const [rows, total] = await Promise.all([
    prisma.exclusiveMandate.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        property: { select: { id: true, title: true, slug: true, city: true, locality: true, publishStatus: true } },
        partner: { select: { id: true, name: true, companyName: true, partnerSubType: true } },
      },
    }),
    prisma.exclusiveMandate.count({ where }),
  ]);

  return { data: rows.map(presentMandate), total };
}

async function getMandate(id) {
  const m = await prisma.exclusiveMandate.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, title: true, slug: true, city: true, locality: true, address: true, publishStatus: true } },
      partner: { select: { id: true, name: true, companyName: true, partnerSubType: true, panNumber: true } },
    },
  });
  if (!m) throw new ApiError(404, 'Mandate not found');
  return presentMandate(m);
}

async function revokeMandate(id, reason, adminId, ip) {
  const m = await prisma.exclusiveMandate.findUnique({
    where: { id },
    include: { property: { select: { id: true, title: true } } },
  });
  if (!m) throw new ApiError(404, 'Mandate not found');
  if (m.status === 'REVOKED') throw new ApiError(400, 'This mandate is already revoked');

  const updated = await prisma.exclusiveMandate.update({
    where: { id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason },
  });

  await createNotification({
    userId: m.partnerId,
    title: 'Listing mandate revoked',
    message: `Your mandate for "${m.property.title}" was revoked. Reason: ${reason}`,
    type: 'MANDATE_REVOKED',
    linkUrl: `/partner/listings/${m.propertyId}`,
  });

  await createAuditLog({
    adminId, action: 'MANDATE_REVOKED', targetType: 'Property', targetId: m.propertyId,
    before: { mandateId: id, status: 'ACTIVE' },
    after: { status: 'REVOKED', reason },
    ipAddress: ip,
  });

  return presentMandate(updated);
}

// ─── 4.4 — listing conflict detection ────────────────────────────────────────

// Words that say what a number IS rather than where the place is. Dropping
// these is what lets "Flat 302, Tower B" match "302 Tower-B" — the realistic
// duplicate, where one agent types the unit designator and the other does not.
//
// Deliberately narrow. Words like road, street, tower, block and wing are NOT
// in here, because they distinguish real addresses: dropping "road" would make
// "5 Palm Road" and "5 Palm Street" collide.
const UNIT_DESIGNATOR_WORDS = new Set([
  'flat', 'flatno', 'apt', 'apartment', 'unit', 'unitno', 'no', 'number',
  'door', 'doorno', 'house', 'houseno', 'hno', 'premises', 'shop', 'shopno',
]);

// A normalised key standing in for "the same physical unit".
//
// This is a heuristic, not an identity — there is no unit identifier anywhere
// in this schema. The address is lowercased, split on anything non
// alphanumeric, stripped of unit-designator words, and the remaining tokens
// are SORTED before joining, so word order and punctuation do not matter. That
// is combined with pincode, floor and BHK, all three of which must also match.
//
// What it catches: the same unit re-typed differently — punctuation, case,
// spacing, word order, and a leading "Flat"/"Unit"/"No.".
//
// What it will also match: two genuinely different units whose address records
// only the building and not the unit number. That is why DISMISSED exists as a
// resolution, and why the key is stored on the conflict row — a false positive
// can be traced back to exactly what matched.
//
// What it will miss: the same unit described with genuinely different wording
// ("Palm Grove" vs "Palmgrove Residency"), or a different pincode, floor or
// BHK entered for the same unit. Duplicate detection is a prompt for a human,
// not a guarantee.
//
// Returns null when the listing lacks the fields to key it at all, in which
// case duplicate detection is skipped rather than guessed at.
function unitKeyFor(property) {
  if (!property.address || !property.pincode) return null;
  const tokens = String(property.address)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !UNIT_DESIGNATOR_WORDS.has(t))
    .sort();
  if (!tokens.length) return null;
  return [tokens.join('-'), property.pincode, property.floorNumber ?? 'x', property.bhk ?? 'x'].join('|');
}

const CONFLICT_SELECT = {
  id: true, title: true, address: true, pincode: true, floorNumber: true,
  bhk: true, partnerId: true, publishStatus: true,
};

// Writes a conflict only if an OPEN one of the same shape is not already
// there, so re-running the detector is idempotent and does not pile up
// duplicate rows for the same problem.
async function upsertConflict({ propertyId, conflictingPropertyId, type, detail, unitKey }) {
  const existing = await prisma.listingConflict.findFirst({
    where: {
      propertyId, type, status: 'OPEN',
      ...(conflictingPropertyId
        ? { conflictingPropertyId }
        : { OR: [{ conflictingPropertyId: null }, { conflictingPropertyId: { isSet: false } }] }),
    },
  });
  if (existing) return null;
  return prisma.listingConflict.create({
    data: { propertyId, conflictingPropertyId: conflictingPropertyId || null, type, detail, unitKey: unitKey || null },
  });
}

async function detectConflicts(propertyId) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { ...CONFLICT_SELECT, locality: true, city: true },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const created = [];
  const unitKey = unitKeyFor(property);

  // 1. The same unit on another listing.
  if (unitKey) {
    // Narrowed in the query by the cheap, indexed parts of the key; the
    // address text is normalised in memory because Mongo cannot compare a
    // stripped-punctuation form of a field.
    const candidates = await prisma.property.findMany({
      where: {
        id: { not: propertyId },
        pincode: property.pincode,
        publishStatus: { not: 'ARCHIVED' },
      },
      select: CONFLICT_SELECT,
    });

    for (const other of candidates) {
      if (unitKeyFor(other) !== unitKey) continue;
      const samePartner = other.partnerId === property.partnerId;
      const row = await upsertConflict({
        propertyId,
        conflictingPropertyId: other.id,
        type: 'DUPLICATE_UNIT',
        unitKey,
        detail: samePartner
          ? `The same unit is already listed by this partner as "${other.title}".`
          : `The same unit is listed by a different partner as "${other.title}".`,
      });
      if (row) created.push(row);
    }
  }

  // 2. An agent whose mandate names themselves as the owner.
  const mandates = await prisma.exclusiveMandate.findMany({
    where: { propertyId, ...inForceFilter() },
    include: { partner: { select: { id: true, name: true, partnerSubType: true, panNumber: true } } },
  });

  for (const m of mandates) {
    const ownerPan = normalisePan(m.ownerPan);
    const partnerPan = normalisePan(m.partner.panNumber);
    if (ownerPan && partnerPan && ownerPan === partnerPan) {
      const row = await upsertConflict({
        propertyId,
        type: 'AGENT_OWNER_PAN_MATCH',
        detail: `Mandate ${m.id} names "${m.ownerName}" as owner, but the owner PAN matches the submitting partner's own PAN (${partnerPan}). `
          + `The partner is registered as ${m.partner.partnerSubType || 'unspecified'}.`,
      });
      if (row) created.push(row);
    }
  }

  // 3. Two unexpired mandates covering the same unit, held by different
  // partners. Only meaningful when the unit can be keyed.
  if (unitKey && mandates.length) {
    const sameUnitIds = (await prisma.property.findMany({
      where: { pincode: property.pincode, publishStatus: { not: 'ARCHIVED' } },
      select: CONFLICT_SELECT,
    })).filter((p) => unitKeyFor(p) === unitKey).map((p) => p.id);

    const others = await prisma.exclusiveMandate.findMany({
      where: { propertyId: { in: sameUnitIds }, ...inForceFilter() },
      include: { partner: { select: { id: true, name: true, companyName: true } } },
    });

    const held = new Set(mandates.map((m) => m.partnerId));
    for (const other of others) {
      if (held.has(other.partnerId)) continue;
      const row = await upsertConflict({
        propertyId,
        conflictingPropertyId: other.propertyId === propertyId ? null : other.propertyId,
        type: 'MANDATE_OVERLAP',
        unitKey,
        detail: `${other.partner.companyName || other.partner.name} also holds a mandate in force on this unit until ${other.expiryDate.toISOString().slice(0, 10)}.`,
      });
      if (row) created.push(row);
    }
  }

  return created;
}

const CONFLICT_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'];

async function listConflicts(query, skip, limit) {
  const where = {};
  if (query.status && query.status !== 'ALL') {
    if (!CONFLICT_STATUSES.includes(query.status)) {
      throw new ApiError(400, `status must be one of ${CONFLICT_STATUSES.join(', ')} or ALL`);
    }
    where.status = query.status;
  } else if (!query.status) {
    where.status = 'OPEN';
  }
  if (query.type) where.type = query.type;
  if (query.propertyId) where.propertyId = query.propertyId;

  const [rows, total] = await Promise.all([
    prisma.listingConflict.findMany({
      where, skip, take: limit,
      orderBy: { detectedAt: 'desc' },
      include: {
        property: { select: { id: true, title: true, slug: true, city: true, locality: true, publishStatus: true, partnerId: true } },
      },
    }),
    prisma.listingConflict.count({ where }),
  ]);

  // The other listing is a plain id, not a relation, so it is fetched
  // separately — in one query for the whole page rather than per row.
  const otherIds = [...new Set(rows.map((r) => r.conflictingPropertyId).filter(Boolean))];
  const others = otherIds.length
    ? await prisma.property.findMany({
        where: { id: { in: otherIds } },
        select: { id: true, title: true, slug: true, publishStatus: true, partnerId: true },
      })
    : [];
  const byId = Object.fromEntries(others.map((o) => [o.id, o]));

  const data = rows.map((r) => ({
    ...r,
    // null when the conflict is not about a second listing, or when that
    // listing has since been deleted.
    conflictingProperty: r.conflictingPropertyId ? byId[r.conflictingPropertyId] || null : null,
  }));

  return { data, total };
}

async function resolveConflict(id, { status, resolution, adminId }, ip) {
  if (!['RESOLVED', 'DISMISSED'].includes(status)) {
    throw new ApiError(400, 'status must be RESOLVED or DISMISSED');
  }
  const c = await prisma.listingConflict.findUnique({ where: { id } });
  if (!c) throw new ApiError(404, 'Conflict not found');
  if (c.status !== 'OPEN') throw new ApiError(400, `This conflict is already ${c.status}`);

  const updated = await prisma.listingConflict.update({
    where: { id },
    data: { status, resolution, resolvedByAdminId: adminId, resolvedAt: new Date() },
  });

  await createAuditLog({
    adminId, action: `LISTING_CONFLICT_${status}`, targetType: 'Property', targetId: c.propertyId,
    before: { conflictId: id, status: 'OPEN' },
    after: { status, resolution },
    ipAddress: ip,
  });

  return updated;
}

module.exports = {
  effectiveStatusOf, unitKeyFor, inForceFilter,
  createMandate, listMandates, getMandate, revokeMandate,
  detectConflicts, listConflicts, resolveConflict,
  CONFLICT_STATUSES,
};
