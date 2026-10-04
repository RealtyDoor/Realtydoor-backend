const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');

// R29 — a buyer has at most one ACTIVE referral at a time, across every
// advisor, so commission.service.js's lookup by phone always has a single
// answer. Checked here rather than a unique index — same reasoning as
// ExclusiveMandate's "one mandate in force per listing".
async function createReferral(advisorId, data, adminId = null, ip = null) {
  const advisor = await prisma.user.findUnique({ where: { id: advisorId }, select: { id: true, partnerSubType: true } });
  if (!advisor) throw new ApiError(404, 'Advisor not found');
  if (advisor.partnerSubType !== 'ADVISOR') {
    throw new ApiError(400, `Only an ADVISOR-persona partner can refer a client. This partner is ${advisor.partnerSubType || 'unset'}.`);
  }

  const existing = await prisma.advisorReferral.findFirst({
    where: { buyerPhone: data.buyerPhone, status: 'ACTIVE' },
  });
  if (existing) {
    throw new ApiError(409,
      existing.advisorId === advisorId
        ? 'You already have an active referral for this phone number.'
        : 'This phone number already has an active referral from a different advisor. Ask admin to revoke it first.',
      { code: 'REFERRAL_ALREADY_ACTIVE' });
  }

  // Opportunistic link, for display only — the actual commission match in
  // previewTermsForLead is always by phone, which is guaranteed present on
  // both sides even when no account exists yet.
  const matchedBuyer = await prisma.user.findFirst({ where: { phone: data.buyerPhone, role: 'USER' }, select: { id: true } });

  const referral = await prisma.advisorReferral.create({
    data: {
      advisorId,
      buyerName: data.buyerName,
      buyerPhone: data.buyerPhone,
      buyerEmail: data.buyerEmail || null,
      buyerId: matchedBuyer?.id || null,
      note: data.note || null,
      createdByAdminId: adminId,
    },
  });

  if (adminId) {
    await createAuditLog({
      adminId, action: 'ADVISOR_REFERRAL_CREATED', targetType: 'User', targetId: advisorId,
      after: { referralId: referral.id, buyerPhone: data.buyerPhone }, ipAddress: ip,
    });
  }

  return referral;
}

async function listMyReferrals(advisorId, filters, skip, limit) {
  const where = { advisorId };
  if (filters.status) where.status = filters.status;
  const [data, total] = await Promise.all([
    prisma.advisorReferral.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.advisorReferral.count({ where }),
  ]);
  return { data, total };
}

async function listReferralsAdmin(filters, skip, limit) {
  const where = {};
  if (filters.advisorId) where.advisorId = filters.advisorId;
  if (filters.buyerPhone) where.buyerPhone = filters.buyerPhone;
  if (filters.status) where.status = filters.status;
  const [data, total] = await Promise.all([
    prisma.advisorReferral.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'desc' },
      include: { advisor: { select: { id: true, name: true, companyName: true } } },
    }),
    prisma.advisorReferral.count({ where }),
  ]);
  return { data, total };
}

// requirePartnerId, when passed, scopes this to the advisor's own referral
// (self-revoke) — the admin route omits it, matching every other
// admin-vs-partner pair in this codebase (e.g. checklist.service.js).
async function revokeReferral(id, reason, adminId, ip, requirePartnerId = null) {
  const referral = await prisma.advisorReferral.findUnique({ where: { id } });
  if (!referral) throw new ApiError(404, 'Referral not found');
  if (requirePartnerId && referral.advisorId !== requirePartnerId) {
    throw new ApiError(403, 'Not your referral');
  }
  if (referral.status === 'REVOKED') throw new ApiError(400, 'This referral is already revoked');

  const updated = await prisma.advisorReferral.update({
    where: { id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason },
  });

  if (adminId) {
    await createNotification({
      userId: referral.advisorId,
      title: 'Referral revoked',
      message: `Your referral for ${referral.buyerName} was revoked. Reason: ${reason}`,
      type: 'ADVISOR_REFERRAL_REVOKED',
      linkUrl: '/partner/referrals',
    });
    await createAuditLog({
      adminId, action: 'ADVISOR_REFERRAL_REVOKED', targetType: 'User', targetId: referral.advisorId,
      before: { referralId: id, status: 'ACTIVE' }, after: { status: 'REVOKED', reason }, ipAddress: ip,
    });
  }

  return updated;
}

// R29 — the actual commission-side lookup (commission.service.js's
// previewTermsForLead). Phone is the matching key for the reason explained
// in the schema comment: a buyer's very first lead can predate their own
// account, same as the referral itself can.
async function getActiveReferralForPhone(buyerPhone) {
  if (!buyerPhone) return null;
  return prisma.advisorReferral.findFirst({ where: { buyerPhone, status: 'ACTIVE' } });
}

module.exports = {
  createReferral, listMyReferrals, listReferralsAdmin, revokeReferral, getActiveReferralForPhone,
};
