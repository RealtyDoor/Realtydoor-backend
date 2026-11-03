// Pure rules for keeping the lead pipeline clean: when two leads are the same buyer, when a lead may be moved to another partner,
// and the fixed reasons a lead can be dropped for. No database in here, so each rule is tested on its own.

const ACTIVE_STATUSES_EXCLUDED = ['CLOSED', 'DROPPED'];
const DROP_REASON_CODES = ['INVALID_NUMBER', 'UNREACHABLE', 'DUPLICATE', 'NOT_INTERESTED', 'BOUGHT_ELSEWHERE', 'PROPERTY_UNAVAILABLE', 'PARTNER_UNAVAILABLE', 'OTHER'];
const DROP_REASON_LABEL = {
  INVALID_NUMBER: 'Wrong or invalid number', UNREACHABLE: 'Could not be reached', DUPLICATE: 'Duplicate of another lead', NOT_INTERESTED: 'Not interested',
  BOUGHT_ELSEWHERE: 'Bought elsewhere', PROPERTY_UNAVAILABLE: 'Property no longer available', PARTNER_UNAVAILABLE: 'Partner could not take it', OTHER: 'Other',
};

const isActive = (lead) => !!lead && !ACTIVE_STATUSES_EXCLUDED.includes(lead.status);

/**
 * Leads that are the same buyer enquiring about the same property as a lead a partner already registered, created after it, and
 * still untouched by any partner or any money. Those are duplicates and fold into the partner's lead; anything with a visit or a
 * token on it is left alone for an admin to look at.
 */
function duplicatesOfPartnerLead(partnerLead, candidates = []) {
  return candidates.filter((c) =>
    c.id !== partnerLead.id
    && !c.addedByPartnerId
    && c.propertyId && String(c.propertyId) === String(partnerLead.propertyId)
    && c.buyerPhone === partnerLead.buyerPhone
    && ['UNASSIGNED', 'ASSIGNED'].includes(c.status)
    && !c.siteVisitScheduledAt && !c.isOtpVerified
    && !(c.escrowTransactions || []).length
    && new Date(c.createdAt) > new Date(partnerLead.createdAt));
}

const MONEY_STATUSES = ['HELD', 'HELD_PAYOUT_FAILED', 'FROZEN', 'RELEASED', 'PARTIALLY_REFUNDED'];

/**
 * Can this lead be moved from its current partner to another? Not once money is involved or the buyer has met the partner (the
 * partner already holds the buyer's real number): then it has to be settled first. A booked-but-not-done visit may move, with a
 * reason, and the old visit and OTP are cleared.
 */
function reassignCheck(lead, escrows = [], reason) {
  if (!lead.assignedPartnerId) return { ok: true, clearVisit: false };
  if (escrows.some((e) => MONEY_STATUSES.includes(e.status))) {
    return { ok: false, code: 'REASSIGN_BLOCKED_MONEY', message: 'A token is held or has been paid out on this lead. Refund or resolve it first; it cannot move to another partner.' };
  }
  if (lead.isOtpVerified || ['SITE_VISIT_DONE', 'CLOSED'].includes(lead.status)) {
    return { ok: false, code: 'REASSIGN_BLOCKED_VISIT_DONE', message: 'The buyer has already met this partner (the visit is verified), so the lead cannot move to another partner.' };
  }
  const booked = !!lead.siteVisitScheduledAt || lead.status === 'SITE_VISIT_SCHEDULED';
  if (booked && !(typeof reason === 'string' && reason.trim().length >= 5)) {
    return { ok: false, code: 'REASSIGN_REASON_REQUIRED', message: 'A site visit is already booked with this partner. Give a reason (at least 5 characters) to move the lead; the booked visit will be cancelled.' };
  }
  return { ok: true, clearVisit: booked };
}

module.exports = { DROP_REASON_CODES, DROP_REASON_LABEL, MONEY_STATUSES, isActive, duplicatesOfPartnerLead, reassignCheck };
