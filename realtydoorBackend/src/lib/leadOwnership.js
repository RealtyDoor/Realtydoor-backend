// Who owns a buyer when a partner adds a lead for a phone number. One mobile number is one person, and that is the hard rule.
// Pure: the caller loads the earlier leads and the buyer account for the number, so this is easy to test.
//
//   NEW_BUYER           nobody has this number: the adding partner is credited.
//   OWN_REGISTRATION    the same partner registered it earlier and it is still valid: the partner is credited.
//   OTHER_PARTNER       another partner registered it first and it is still valid: not credited to the adder.
//   EXISTING_BUYER      the platform knew the number first (own enquiry, admin-added lead, registered account): our buyer.
//
// A partner registration stays valid while there was real activity on it (a lead, site visit, token or close) within
// `windowDays`. After that the buyer is free again, so a fresh registration is credited like a new buyer.
const DAY_MS = 86_400_000;

function lastActivity(lead) {
  const stamps = [
    lead.createdAt, lead.assignedAt, lead.siteVisitScheduledAt, lead.otpGeneratedAt, lead.otpVerifiedAt, lead.visitOutcomeAt,
    lead.closedAt,
    ...(lead.escrowTransactions || []).flatMap((e) => [e.createdAt, e.heldAt, e.releasedAt]),
  ].filter(Boolean).map((d) => new Date(d).getTime());
  return Math.max(...stamps);
}

function decideBuyerOwnership({ priorLeads = [], accountCreatedAt = null, partnerId, windowDays, asOf = new Date() }) {
  const now = new Date(asOf).getTime();
  const partnerRegs = priorLeads
    .filter((l) => l.addedByPartnerId)
    .filter((l) => now - lastActivity(l) <= windowDays * DAY_MS)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const platformTimes = [
    ...priorLeads.filter((l) => !l.addedByPartnerId).map((l) => new Date(l.createdAt).getTime()),
    ...(accountCreatedAt ? [new Date(accountCreatedAt).getTime()] : []),
  ];

  const holder = partnerRegs[0];
  const platformFirst = holder
    ? platformTimes.some((t) => t < new Date(holder.createdAt).getTime())
    : platformTimes.length > 0;

  if (holder && !platformFirst) {
    const same = String(holder.addedByPartnerId) === String(partnerId);
    return { credited: same, reason: same ? 'OWN_REGISTRATION' : 'OTHER_PARTNER', holderPartnerId: holder.addedByPartnerId };
  }
  if (platformTimes.length) return { credited: false, reason: 'EXISTING_BUYER', holderPartnerId: null };
  return { credited: true, reason: 'NEW_BUYER', holderPartnerId: null };
}

const OWNERSHIP_TEXT = {
  NEW_BUYER: 'New buyer, credited to the partner.',
  OWN_REGISTRATION: 'Registered earlier by the same partner, credited to the partner.',
  OTHER_PARTNER: 'Already registered by another partner, not credited.',
  EXISTING_BUYER: 'Already a RealtyDoor buyer, counted as our lead and not credited.',
};

module.exports = { decideBuyerOwnership, OWNERSHIP_TEXT };
