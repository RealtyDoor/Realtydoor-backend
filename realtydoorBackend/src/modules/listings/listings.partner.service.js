const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');

// 4.8 — the partner side of the review queue.
//
// Without this, a partner editing a live listing has no way to tell what
// happened: the listing deliberately still shows the old, approved content,
// so the edit looks as though it was simply ignored. These endpoints are what
// make "your listing stays live until an admin reviews this" visible.

const { HIGH_IMPACT_FIELDS } = require('./listings.admin.service');

function decode(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
}

function present(cr) {
  return {
    id: cr.id,
    status: cr.status,
    fieldCount: cr.fieldCount,
    changes: Object.entries(cr.changes || {}).map(([field, pair]) => ({
      field,
      before: decode(pair.before),
      after: decode(pair.after),
      impact: HIGH_IMPACT_FIELDS.includes(field) ? 'HIGH' : 'NORMAL',
    })),
    property: cr.property,
    // The admin's rejection reason is shown verbatim, since it is the only
    // thing telling the partner what to fix.
    reviewNote: cr.reviewNote,
    reviewedAt: cr.reviewedAt,
    createdAt: cr.createdAt,
  };
}

async function listMyChangeRequests(partnerId, query, skip, limit) {
  const where = { partnerId };
  if (query.status && query.status !== 'ALL') where.status = query.status;
  if (query.propertyId) where.propertyId = query.propertyId;

  const [rows, total] = await Promise.all([
    prisma.propertyChangeRequest.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: { property: { select: { id: true, title: true, slug: true, publishStatus: true } } },
    }),
    prisma.propertyChangeRequest.count({ where }),
  ]);

  return { data: rows.map(present), total };
}

// A partner can take back an edit they have not had reviewed yet. Modelled as
// REJECTED with a fixed note rather than a delete, so the listing's edit
// history stays complete, and distinguishable from an admin rejection by the
// absence of reviewedByAdminId.
async function withdrawMyChangeRequest(id, partnerId) {
  const cr = await prisma.propertyChangeRequest.findUnique({ where: { id } });
  if (!cr || cr.partnerId !== partnerId) throw new ApiError(404, 'Change request not found');
  if (cr.status !== 'PENDING') {
    throw new ApiError(400, `This request is already ${cr.status} and cannot be withdrawn`);
  }

  return prisma.propertyChangeRequest.update({
    where: { id },
    data: { status: 'REJECTED', reviewNote: 'Withdrawn by partner', reviewedAt: new Date() },
  });
}

module.exports = { listMyChangeRequests, withdrawMyChangeRequest };
