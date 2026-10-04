const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { getConfigValue } = require('../config/config.service');

// R34 — assignLead reads this to decide whether a partner can receive a new
// lead at all. Defaults to no requirement (null) so the gate is opt-in: it
// only blocks dispatch once the business actually sets a required version,
// rather than locking out every partner the day this ships.
const LEAD_DATA_HANDLING_VERSION_KEY = 'lead_data_handling_required_version';

async function record(partnerId, { type, version, leadId }, ip) {
  if (type === 'POST_OTP_RESTRICTED_USE' && !leadId) {
    throw new ApiError(400, 'leadId is required for POST_OTP_RESTRICTED_USE');
  }
  if (type === 'LEAD_DATA_HANDLING' && leadId) {
    throw new ApiError(400, 'leadId must not be set for LEAD_DATA_HANDLING — it is recorded once per partner, not per lead');
  }

  // Not prisma.upsert(): the generated compound-unique selector for
  // (partnerId, type, version, leadId) rejects `null` for the nullable
  // leadId outright ("Argument `leadId` must not be null") — a Prisma/Mongo
  // quirk where a compound unique including an optional field can't be
  // queried through that generated input type with null, even though the
  // schema allows it and the @@unique is what guarantees this stays a single
  // row. Plain find-then-write instead. Re-posting the same version just
  // refreshes the timestamp rather than erroring or duplicating, the same
  // tolerance acceptPartnerTerms already gives a repeated accept.
  const existing = await prisma.partnerDataAcknowledgment.findFirst({
    where: { partnerId, type, version, leadId: leadId ?? null },
  });
  if (existing) {
    return prisma.partnerDataAcknowledgment.update({
      where: { id: existing.id },
      data: { acceptedAt: new Date(), ipAddress: ip ?? null },
    });
  }
  return prisma.partnerDataAcknowledgment.create({
    data: { partnerId, type, version, leadId: leadId ?? null, ipAddress: ip ?? null },
  });
}

// Latest acceptance of a type, regardless of version — used to answer
// "has this partner accepted the current one" without assuming the caller
// already knows what "current" means.
async function getLatest(partnerId, type, leadId = null) {
  return prisma.partnerDataAcknowledgment.findFirst({
    where: { partnerId, type, leadId },
    orderBy: { acceptedAt: 'desc' },
  });
}

async function getStatus(partnerId, type, leadId = null) {
  const latest = await getLatest(partnerId, type, leadId);
  const requiredVersion = type === 'LEAD_DATA_HANDLING'
    ? await getConfigValue(LEAD_DATA_HANDLING_VERSION_KEY, null)
    : null;

  return {
    type,
    accepted: !!latest,
    version: latest?.version ?? null,
    acceptedAt: latest?.acceptedAt ?? null,
    requiredVersion,
    // null when there is no requiredVersion configured at all — "up to date"
    // has no meaning until the business sets one, so this is distinct from
    // false rather than defaulting to a value that would silently pass.
    isCurrent: requiredVersion == null ? null : latest?.version === requiredVersion,
  };
}

// R34 — called from admin.service.js::assignLead. Returns null (no
// objection) or a reason string the caller turns into a 400. Kept as a
// pure check rather than throwing here, so assignLead's existing error
// shape and message style stay in admin.service.js, not duplicated here.
async function checkLeadDataHandlingGate(partnerId) {
  const requiredVersion = await getConfigValue(LEAD_DATA_HANDLING_VERSION_KEY, null);
  if (!requiredVersion) return null; // not configured — gate is off

  const latest = await getLatest(partnerId, 'LEAD_DATA_HANDLING');
  if (latest?.version === requiredVersion) return null;

  return `This partner has not accepted the current lead-data-handling rules (version ${requiredVersion}). `
    + 'They must accept it in the app before a lead can be assigned.';
}

module.exports = { record, getStatus, checkLeadDataHandlingGate, LEAD_DATA_HANDLING_VERSION_KEY };
