const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const {
  sendPropertyApproved, sendPropertyRejected,
  sendKycVerified, sendKycRejected,
  sendLeadAssigned, sendLeadInquiryConfirmed,
  sendLoanStatusUpdate,
} = require('../../lib/email');
const { sendLeadAssignedNotice, sendSiteVisitOtp } = require('../../lib/wati');
const { setUserRole } = require('../../lib/clerkAdmin');
const { ROLES } = require('../../utils/validators');
const { nextRefCode } = require('../../lib/refCode');
const { stalledInfoFor } = require('../leads/leads.service');
const { CONTACT_STATUSES } = require('../contact/contact.admin.validator');
const { generate, expiresAt } = require('../../lib/otp');
const logger = require('../../lib/logger');
const { cacheDel } = require('../../lib/cache');
const dataAckService = require('../partners/dataAck.service');
const partnerService = require('../partners/partners.service');
const { buildTicketChargeReceiptPdf } = require('../../lib/pdfReceipt');
const { s3Upload } = require('../../lib/fileUpload');
const { getConfigNumber } = require('../config/config.service');
const { distanceMetres } = require('../../lib/mapLink');
const {
  ADMIN_PERMISSION_SCOPES, ADMIN_STAFF_ROLES, DEFAULT_PERMISSIONS_BY_STAFF_ROLE,
} = require('../../utils/adminPermissions');
const CACHE_KEYS = require('../../lib/cacheKeys');

// ─── LEAD MANAGEMENT ─────────────────────────────────────────────────────────

// Admin sees full buyer identity (unlike the buyer-facing or partner-facing
// sanitizers) — refCode plus enough to act on a real person: contact details,
// phone-verification state, account age, and how many inquiries they've
// submitted in total (a quick signal for spotting abuse of the per-buyer
// limits in leads.service.js).
const ADMIN_LEAD_BUYER_INCLUDE = {
  select: {
    id: true, refCode: true, name: true, email: true, phone: true,
    phoneVerified: true, phoneVerifiedAt: true, createdAt: true,
    _count: { select: { buyerLeads: true } },
  },
};

function flattenBuyerInquiryCount(lead) {
  if (!lead) return lead;
  // 6.9 — the lead monitor's stalled column was computed client-side from row
  // age over a 50-row sample; this is the real per-lead value.
  const stalled = stalledInfoFor(lead);
  // Dev feedback, 2026-10-07 — inquiryCount was silently absent from the
  // response shape whenever a lead has no linked buyer account (admin-
  // created/free-text leads, legacy pre-buyerId rows — a majority of real
  // rows, not an edge case), which an API consumer reasonably reads as a
  // missing field rather than "zero, there's no buyer to count for."
  // Always present now, 0 when there's nothing to count.
  if (!lead.buyer) return { ...lead, inquiryCount: 0, ...stalled };
  const { _count, ...buyer } = lead.buyer;
  return { ...lead, buyer, inquiryCount: _count?.buyerLeads ?? 0, ...stalled };
}

async function getLeadById(leadId) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      property:        { select: { title: true, slug: true, city: true, locality: true } },
      assignedPartner: { select: { name: true, email: true, phone: true, companyName: true } },
      escrowTransactions: { orderBy: { createdAt: 'desc' } },
      buyer: ADMIN_LEAD_BUYER_INCLUDE,
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  return flattenBuyerInquiryCount(lead);
}

async function getAllLeads(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.partnerId) where.assignedPartnerId = filters.partnerId;
  if (filters.search) where.OR = [
    { refCode:    { contains: filters.search, mode: 'insensitive' } },
    { buyerName:  { contains: filters.search, mode: 'insensitive' } },
    { buyerEmail: { contains: filters.search, mode: 'insensitive' } },
  ];

  const [data, total] = await Promise.all([
    prisma.lead.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        property: { select: { title: true, slug: true, city: true } },
        assignedPartner: { select: { name: true, email: true } },
        // backend-work-still-open.md #4 — the partner-added leads page
        // needs to show who added each one, distinct from assignedPartner
        // (who it's currently assigned to — often the same partner, but
        // not always, e.g. once admin reassigns it).
        addedByPartner: { select: { name: true, companyName: true } },
        buyer: ADMIN_LEAD_BUYER_INCLUDE,
      },
    }),
    prisma.lead.count({ where }),
  ]);

  return { data: data.map(flattenBuyerInquiryCount), total };
}

// 6.4a — admin logs a lead that arrived off-platform (phone, walk-in, …).
// buyerId stays null: nobody authenticated, so this is the admin's record of
// a conversation, not an account's own inquiry (same reasoning as
// partnerAddLead in leads.service.js).
async function createLead(data, adminId, ip) {
  let property = null;
  if (data.propertyId) {
    property = await prisma.property.findUnique({
      where: { id: data.propertyId },
      select: { id: true, title: true },
    });
    if (!property) throw new ApiError(404, 'Property not found');
  }

  let partner = null;
  if (data.partnerId) {
    // Same gate as assignLead — an unverified partner must not receive work.
    partner = await prisma.user.findFirst({
      where: { id: data.partnerId, role: 'PARTNER', kycStatus: 'VERIFIED' },
      select: { id: true, name: true, companyName: true },
    });
    if (!partner) throw new ApiError(400, 'Partner not found or not KYC verified');
  }

  // docs-backend-gaps-handoff.md #4 — the partner self-sourced path (B3.2)
  // already refuses a duplicate (same buyer phone, same property, still
  // active); the admin path never had the same check. Only meaningful when
  // a real listing is named — an admin-logged lead can legitimately be
  // free-text-only (propertyInterest, no propertyId), and there is nothing
  // to deduplicate a free-text interest against.
  if (data.propertyId) {
    const duplicate = await prisma.lead.findFirst({
      where: { propertyId: data.propertyId, buyerPhone: data.buyerPhone, status: { notIn: ['CLOSED', 'DROPPED'] } },
      select: { id: true, refCode: true, status: true },
    });
    if (duplicate) {
      throw new ApiError(409, 'There is already an active lead for this buyer and property', {
        code: 'DUPLICATE_LEAD', lead: duplicate,
      });
    }
  }

  // Repeat buyer: link to this phone's most recent lead, same as the partner path.
  const earlier = await prisma.lead.findFirst({
    where: { buyerPhone: data.buyerPhone },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  const refCode = await nextRefCode('lead');
  const lead = await prisma.lead.create({
    data: {
      refCode,
      buyerName: data.buyerName,
      buyerPhone: data.buyerPhone,
      buyerEmail: data.buyerEmail ?? '',
      buyerMessage: data.note,
      budget: data.budget,
      propertyId: data.propertyId ?? null,
      propertyInterest: data.propertyInterest,
      // backend-work-still-open.md #3 — only meaningful (and only required
      // by the validator) when there's no propertyId; a real listing's own
      // city is always used instead once one exists.
      city: data.propertyId ? null : data.city,
      source: data.source,
      addedByAdminId: adminId,
      // The validator only accepts the literal boolean true, so by the time
      // this runs consent was given — recorded as the timestamp admin
      // actually attested it, not a bare echo of the request body.
      buyerConsentAt: new Date(),
      ...(earlier && { relatedLeadId: earlier.id }),
      ...(partner
        ? { assignedPartnerId: partner.id, status: 'ASSIGNED', assignedAt: new Date() }
        : { status: 'UNASSIGNED' }),
    },
  });

  if (partner) {
    await createNotification({
      userId: partner.id,
      title: 'New Lead Assigned',
      message: `${lead.refCode} · ${lead.buyerName}${property ? ` for "${property.title}"` : ''} has been assigned to you.`,
      type: 'LEAD_ASSIGNED',
      linkUrl: `/partners/leads/${lead.id}`,
    });
  }

  await createAuditLog({
    adminId, action: 'LEAD_CREATED', targetType: 'Lead', targetId: lead.id,
    after: { refCode: lead.refCode, source: lead.source, assignedPartnerId: lead.assignedPartnerId },
    ipAddress: ip,
  });

  // docs-backend-gaps-handoff.md #4 / backend-work-still-open.md #2 — terms
  // are now pre-filled AND locked the moment a lead becomes ASSIGNED, here
  // or in assignLead below (see prefillCommissionTermsSafely). Previously
  // gated on lead.propertyId — a real listing to resolve a rate card
  // against — but #3's lead.city now gives a free-text-only lead a city to
  // look up a rate card by too, so that gate is gone; resolveRateCard
  // falls through to the platform default if neither ever resolves a card,
  // same as it always has. A pre-fill/lock failure must never undo an
  // assignment that already succeeded.
  if (partner) {
    await prefillCommissionTermsSafely(lead.id, adminId, ip);
  }

  return lead;
}

// backend-work-still-open.md #2 — reverses the earlier "pre-fill only,
// admin locks separately and deliberately" decision: terms are now locked
// the moment a lead is assigned, not left editable. Still entirely
// best-effort — a pre-fill or lock failure (e.g. no rate card resolves, or
// the resolved lines don't clear setLeadTerms' own validation) must never
// undo an assignment that already succeeded; it's logged for admin to
// finish manually via the existing prefill/lock endpoints instead.
async function prefillCommissionTermsSafely(leadId, adminId, ip) {
  const commissionService = require('../commission/commission.service');
  try {
    await commissionService.prefillLeadTerms(leadId, adminId, ip);
  } catch (err) {
    logger.error('[prefillCommissionTermsSafely] pre-fill failed', { leadId, error: err.message });
    return;
  }
  try {
    await commissionService.lockLeadTerms(leadId, adminId, ip);
  } catch (err) {
    logger.error('[prefillCommissionTermsSafely] auto-lock failed', { leadId, error: err.message });
  }
}

// 6.3 — admin vets a partner-added lead. Confirming moves it out of
// AWAITING_ADMIN into the normal pipeline, optionally assigning in one step
// (passing a different partnerId is the "reassign" case).
async function confirmLead(leadId, partnerId, adminId, ip) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { property: { select: { title: true } } } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.status !== 'AWAITING_ADMIN') {
    throw new ApiError(400, `Only a lead awaiting admin review can be confirmed (this one is ${lead.status})`);
  }

  let partner = null;
  if (partnerId) {
    partner = await prisma.user.findFirst({
      where: { id: partnerId, role: 'PARTNER', kycStatus: 'VERIFIED' },
      select: { id: true },
    });
    if (!partner) throw new ApiError(400, 'Partner not found or not KYC verified');
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: partner
      ? { assignedPartnerId: partner.id, status: 'ASSIGNED', assignedAt: new Date() }
      : { status: 'UNASSIGNED' },
  });

  if (partner) {
    await createNotification({
      userId: partner.id,
      title: 'Lead Confirmed',
      message: `${lead.refCode} · ${lead.buyerName} is confirmed and assigned to you.`,
      type: 'LEAD_ASSIGNED',
      linkUrl: `/partners/leads/${leadId}`,
    });
  } else if (lead.addedByPartnerId) {
    await createNotification({
      userId: lead.addedByPartnerId,
      title: 'Lead Confirmed',
      message: `${lead.refCode} · ${lead.buyerName} has been confirmed and is now in the assignment queue.`,
      type: 'LEAD_ASSIGNED',
      linkUrl: `/partners/leads/${leadId}`,
    });
  }

  await createAuditLog({
    adminId, action: 'LEAD_CONFIRMED', targetType: 'Lead', targetId: leadId,
    before: { status: lead.status }, after: { status: updated.status, assignedPartnerId: updated.assignedPartnerId },
    ipAddress: ip,
  });

  return updated;
}

// 6.3 — admin rejects a partner-added lead outright.
async function rejectLead(leadId, reason, adminId, ip) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.status !== 'AWAITING_ADMIN') {
    throw new ApiError(400, `Only a lead awaiting admin review can be rejected (this one is ${lead.status})`);
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'DROPPED',
      droppedReason: reason,
      droppedAt: new Date(),
      droppedByAdminId: adminId,
    },
  });

  if (lead.addedByPartnerId) {
    await createNotification({
      userId: lead.addedByPartnerId,
      title: 'Lead Not Accepted',
      message: `${lead.refCode} · ${lead.buyerName} was not accepted. Reason: ${reason}`,
      type: 'LEAD_DROPPED',
      linkUrl: `/partners/leads/${leadId}`,
    });
  }

  await createAuditLog({
    adminId, action: 'LEAD_REJECTED', targetType: 'Lead', targetId: leadId,
    before: { status: lead.status }, after: { status: 'DROPPED', reason },
    ipAddress: ip,
  });

  return updated;
}

// 6.6 — admin clears a locked site-visit OTP. Partners could already REQUEST
// an override (POST /leads/partner/:id/request-otp-override sets a flag and
// notifies admins), but there was no endpoint for an admin to actually act on
// it, so the queue had no exit. Resets the attempt counter and lock and issues
// a fresh code so the partner can retry; it deliberately does NOT mark the
// visit verified — only the buyer reading out a real OTP can do that.
async function overrideLeadOtp(leadId, adminId, ip, note) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.isOtpVerified) throw new ApiError(400, 'This site visit is already verified');
  if (!lead.siteVisitScheduledAt) throw new ApiError(400, 'No site visit scheduled for this lead');

  const otp = generate();
  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      siteVisitOTP: otp,
      otpGeneratedAt: new Date(),
      otpExpiresAt: expiresAt(),
      otpAttempts: 0,
      otpLockedUntil: null,
      otpOverrideRequestedByPartner: false,
      otpOverrideRequestedAt: null,
      ...(note && { adminNotes: note }),
    },
  });

  try {
    await sendSiteVisitOtp(lead.buyerPhone, otp);
  } catch (err) {
    logger.error('[overrideLeadOtp] WATI OTP send failed', { leadId, error: err.message });
  }

  if (lead.assignedPartnerId) {
    await createNotification({
      userId: lead.assignedPartnerId,
      title: 'OTP Unlocked',
      message: `${lead.refCode} · the site-visit OTP has been unlocked and a fresh code sent to the buyer.`,
      type: 'OTP_OVERRIDE_REQUESTED',
      linkUrl: `/partners/leads/${leadId}`,
    });
  }

  await createAuditLog({
    adminId, action: 'LEAD_OTP_OVERRIDE', targetType: 'Lead', targetId: leadId,
    before: { otpAttempts: lead.otpAttempts, otpLockedUntil: lead.otpLockedUntil },
    after: { otpAttempts: 0, otpLockedUntil: null, note: note ?? null },
    ipAddress: ip,
  });

  // The new code itself is never returned — it goes to the buyer only.
  return { leadId: updated.id, otpAttempts: 0, otpLockedUntil: null, otpExpiresAt: updated.otpExpiresAt };
}

async function assignLead(leadId, partnerId, adminId, ip) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { property: { select: { title: true } } },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  // Dev feedback, 2026-10-07 — admin can reassign an already-assigned lead
  // to a different partner (the original partner went unresponsive, the
  // area shifted, etc.); this was previously a hard 409 with no escape
  // hatch at all. Reassigning to the SAME partner is still refused — it's
  // a no-op the UI shouldn't be sending, not a real reassignment.
  const isReassign = !!lead.assignedPartnerId && lead.assignedPartnerId !== partnerId;
  if (lead.assignedPartnerId === partnerId) {
    throw new ApiError(409, 'Lead is already assigned to this partner');
  }
  if (['CLOSED', 'DROPPED'].includes(lead.status)) {
    throw new ApiError(400, `Cannot assign a ${lead.status.toLowerCase()} lead`);
  }

  const partner = await prisma.user.findFirst({ where: { id: partnerId, role: 'PARTNER', kycStatus: 'VERIFIED' } });
  if (!partner) throw new ApiError(400, 'Partner not found or not KYC verified');

  // R34 — gate the first (and every) lead dispatch on the current
  // lead-data-handling acknowledgment. Off by default: checkLeadDataHandlingGate
  // returns null until the business configures a required version, so this
  // cannot lock out every partner the day it ships.
  const gateReason = await dataAckService.checkLeadDataHandlingGate(partnerId);
  if (gateReason) throw new ApiError(400, gateReason);

  const previousPartnerId = lead.assignedPartnerId;
  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: { assignedPartnerId: partnerId, status: 'ASSIGNED', assignedAt: new Date() },
  });

  if (isReassign && previousPartnerId) {
    await createNotification({
      userId: previousPartnerId,
      title: 'Lead reassigned',
      message: `${lead.refCode || 'A lead'} has been reassigned to another partner.`,
      type: 'LEAD_ASSIGNED',
      linkUrl: `/partner/leads`,
    });
  }

  await createNotification({
    userId: partnerId,
    title: isReassign ? 'Lead Reassigned To You' : 'New Lead Assigned',
    message: isReassign ? 'A lead has been reassigned to you.' : 'A new buyer lead has been assigned to you.',
    type: 'LEAD_ASSIGNED',
    linkUrl: `/partner/leads/${leadId}`,
  });

  await createAuditLog({
    adminId, action: isReassign ? 'LEAD_REASSIGNED' : 'LEAD_ASSIGNED', targetType: 'Lead', targetId: leadId,
    before: { status: lead.status, assignedPartnerId: previousPartnerId },
    after: { status: 'ASSIGNED', assignedPartnerId: partnerId },
    ipAddress: ip,
  });

  // backend-work-still-open.md #3 — a free-text (propertyInterest-only)
  // lead has no property relation at all; this unconditionally read
  // lead.property.title, which threw as soon as such a lead could reach
  // this function (previously it couldn't get this far with a resolvable
  // rate card, but assignLead itself never actually required a property).
  const propertyLabel = lead.property?.title || lead.propertyInterest || 'their inquiry';

  // Partner: WhatsApp + email
  sendLeadAssignedNotice(partner.phone, partner.name).catch(() => {});
  sendLeadAssigned(partner.email, { buyerName: lead.buyerName, propertyTitle: propertyLabel }).catch(() => {});

  // Buyer: in-app notification (if registered) + email. Never the partner's
  // phone — "Contact agent" always dials the shared telecaller number
  // instead (platform config key telecaller_phone); the buyer only gets the
  // partner's identity (name/company), not a way to reach them directly.
  if (lead.buyerId) {
    await createNotification({
      userId: lead.buyerId,
      title: 'Your Inquiry is Being Processed',
      message: `Your inquiry ${lead.refCode} for "${propertyLabel}" has been assigned to ${partner.companyName || partner.name}. Use Contact agent to reach our team.`,
      type: 'LEAD_ASSIGNED',
      linkUrl: `/user/inquiries/${leadId}`,
    });
  }
  sendLeadInquiryConfirmed(lead.buyerEmail, propertyLabel).catch(() => {});

  // docs-backend-gaps-handoff.md #4 — pre-fill commission terms the moment a
  // lead becomes ASSIGNED here, same as createLead's own assign-at-creation
  // path above. Also locks them (backend-work-still-open.md #2) — see
  // prefillCommissionTermsSafely. On a reassign where terms are already
  // locked to the PREVIOUS partner, prefillLeadTerms refuses
  // (COMMISSION_LOCKED) and that failure is logged and swallowed same as
  // any other pre-fill failure — the reassignment itself still succeeds,
  // and admin revises the now-stale terms by hand via the existing
  // set-terms endpoint (writes a new version, same as any post-lock edit).
  await prefillCommissionTermsSafely(leadId, adminId, ip);

  return updated;
}

// ─── AUTO-ASSIGN ──────────────────────────────────────────────────────────────
//
// Picks a partner for a lead and assigns it through the exact same assignLead
// above, so every guard that function already enforces (KYC-verified, not
// already assigned, not closed/dropped, the R34 data-handling gate) applies
// identically whether a human or this picked the partner. This file never
// writes assignedPartnerId directly — it only decides WHO, and leaves HOW to
// assignLead.

const UNASSIGNABLE_LEAD_STATUSES = ['CLOSED', 'DROPPED'];

// Workload used to rank candidates: currently active leads, not lifetime
// volume — a partner who closed 200 leads last year but has none open right
// now should rank above one sitting on 10 open leads today.
const ACTIVE_LEAD_STATUSES = { notIn: ['CLOSED', 'DROPPED'] };

// backend-work-still-open.md #7 — the first active rule for this
// entityType, in priority order (lowest first), whose every SET condition
// matches `attrs`. An unset rule condition matches anything; a rule with
// no conditions at all matches everything of that entityType (a
// deliberate catch-all, same as leaving a filter blank).
async function findMatchingRoutingRule(entityType, attrs) {
  const rules = await prisma.routingRule.findMany({
    where: { entityType, isActive: true },
    orderBy: { priority: 'asc' },
  });
  const CONDITION_FIELDS = ['city', 'locality', 'source', 'propertyType', 'category'];
  return rules.find((rule) => CONDITION_FIELDS.every((f) => {
    if (rule[f] == null) return true;
    return attrs[f] != null && String(attrs[f]).toLowerCase() === String(rule[f]).toLowerCase();
  })) || null;
}

// Ranks eligible partners for one lead, most-preferred first. Returns an
// empty array rather than throwing — "no eligible partner" is a normal
// outcome for a locality nobody covers yet, not an error.
//
// Three eligibility layers, each narrowing the pool but never to zero when
// the wider pool is non-empty: an exact locality match in leadPreferredLocalities
// is preferred over coverageAreas, which is preferred over no locality signal
// at all, so a lead in an uncovered area is still assignable to SOMEONE rather
// than silently unassignable.
//
// backend-work-still-open.md #7 — a matching LEAD routing rule is tried
// FIRST, ahead of all three layers below: admin named this partner
// deliberately for leads matching this rule, so they get first refusal
// even over a less-loaded candidate. Still only a preference, not a
// bypass — the named partner still has to be KYC-verified and not
// currently signalling overload (leadPauseOverloaded), and if they fail
// assignLead's own gates, autoAssignLead falls through to the rest of
// this ranking exactly as it would for any other candidate.
async function rankCandidatePartners(lead) {
  const base = {
    role: 'PARTNER', kycStatus: 'VERIFIED', deletedAt: { isSet: false },
    // leadAutoAccept defaults to FALSE and leadPauseOverloaded defaults to
    // TRUE (both deliberately conservative — see user.prisma) — together they
    // mean a brand-new partner who has never touched Settings is excluded
    // from auto-assign by default on BOTH counts, not just one. A partner is
    // only eligible once they have explicitly opted in (leadAutoAccept) AND
    // are not currently signalling overload (leadPauseOverloaded).
    //
    // An earlier version of this filter checked only leadPauseOverloaded and
    // missed leadAutoAccept entirely. Caught by checking the schema's actual
    // defaults against this filter before shipping, not by a failing test —
    // the test's own setup had reset both fields on its fixtures, so it would
    // have passed either way and never surfaced the gap on its own.
    leadAutoAccept: true,
    leadPauseOverloaded: { not: true },
  };

  const locality = lead.property?.locality;
  const city = lead.property?.city;

  const routed = [];
  const rule = await findMatchingRoutingRule('LEAD', {
    city, locality, source: lead.source, propertyType: lead.property?.propertyType,
  });
  if (rule?.targetPartnerId) {
    // Admin named this partner deliberately — leadAutoAccept (an opt-in for
    // the generic ranking below) doesn't apply here, but a partner actively
    // signalling overload is still skipped, same as everywhere else.
    const routedPartner = await prisma.user.findFirst({
      where: {
        id: rule.targetPartnerId, role: 'PARTNER', kycStatus: 'VERIFIED',
        deletedAt: { isSet: false }, leadPauseOverloaded: { not: true },
      },
      select: { id: true, name: true, companyName: true },
    });
    if (routedPartner) {
      routed.push({
        ...routedPartner,
        activeLeads: await prisma.lead.count({ where: { assignedPartnerId: routedPartner.id, status: ACTIVE_LEAD_STATUSES } }),
      });
    }
  }

  const pools = [];
  if (locality) {
    pools.push({ ...base, leadPreferredLocalities: { has: locality } });
    pools.push({ ...base, coverageAreas: { has: locality } });
  }
  if (city) {
    pools.push({ ...base, leadPreferredLocalities: { has: city } });
    pools.push({ ...base, coverageAreas: { has: city } });
  }
  pools.push(base); // no locality signal at all — every eligible partner

  for (const where of pools) {
    const candidates = await prisma.user.findMany({
      where, select: { id: true, name: true, companyName: true },
    });
    if (!candidates.length) continue;

    const withLoad = await Promise.all(candidates.map(async (c) => ({
      ...c,
      activeLeads: await prisma.lead.count({ where: { assignedPartnerId: c.id, status: ACTIVE_LEAD_STATUSES } }),
    })));
    withLoad.sort((a, b) => a.activeLeads - b.activeLeads);
    return [...routed, ...withLoad.filter((c) => c.id !== routed[0]?.id)];
  }
  return routed;
}

// Tries ranked candidates in order until one is actually assignable — a
// candidate can still fail assignLead's own gates (most likely R34) even
// after passing the eligibility filter above, and that failure should fall
// through to the next candidate rather than failing the whole pick.
async function autoAssignLead(leadId, adminId, ip) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { property: { select: { locality: true, city: true, propertyType: true } } },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.assignedPartnerId) throw new ApiError(409, 'Lead is already assigned to a partner');
  if (UNASSIGNABLE_LEAD_STATUSES.includes(lead.status)) {
    throw new ApiError(400, `Cannot assign a ${lead.status.toLowerCase()} lead`);
  }

  const candidates = await rankCandidatePartners(lead);
  if (!candidates.length) {
    throw new ApiError(400,
      'No eligible, KYC-verified partner is available to auto-assign this lead to. '
      + 'Most likely cause: no partner has turned on "auto-accept leads" in Settings yet.');
  }

  const attempted = [];
  for (const candidate of candidates) {
    try {
      const updated = await assignLead(leadId, candidate.id, adminId, ip);
      return { lead: updated, assignedTo: candidate, candidatesConsidered: attempted.length + 1 };
    } catch (err) {
      // Only skip to the next candidate for a gate this function can
      // reasonably expect to differ between candidates (R34). Anything
      // else (lead already assigned by a racing request, lead closed) is
      // a real failure and should surface immediately rather than being
      // masked by "no eligible partner".
      if (err.statusCode === 400 && /data-handling rules/.test(err.message)) {
        attempted.push({ partnerId: candidate.id, reason: err.message });
        continue;
      }
      throw err;
    }
  }

  throw new ApiError(400,
    `${candidates.length} candidate(s) were eligible but none could actually be assigned `
    + `(all failed: ${attempted.map((a) => a.reason).join('; ')})`);
}

// Batch form — every currently UNASSIGNED lead (optionally narrowed by
// propertyId/city), each picked and assigned independently. One lead's
// failure (e.g. no eligible partner for its locality) does not stop the
// rest; the response reports both lists so nothing is silently dropped.
async function autoAssignUnassignedLeads(query, adminId, ip) {
  const where = { status: 'UNASSIGNED', assignedPartnerId: { isSet: false } };
  if (query.propertyId) where.propertyId = query.propertyId;
  if (query.city) where.property = { city: { equals: query.city, mode: 'insensitive' } };

  const leads = await prisma.lead.findMany({ where, select: { id: true, refCode: true }, orderBy: { createdAt: 'asc' } });

  const assigned = [];
  const failed = [];
  for (const lead of leads) {
    try {
      const result = await autoAssignLead(lead.id, adminId, ip);
      assigned.push({ leadId: lead.id, refCode: lead.refCode, partnerId: result.assignedTo.id, partnerName: result.assignedTo.name });
    } catch (err) {
      failed.push({ leadId: lead.id, refCode: lead.refCode, reason: err.message });
    }
  }

  return { totalConsidered: leads.length, assignedCount: assigned.length, failedCount: failed.length, assigned, failed };
}

// ─── ROUTING RULES (backend-work-still-open.md #7) ──────────────────────────

async function listRoutingRules(filters, skip, limit) {
  const where = {};
  if (filters.entityType) where.entityType = filters.entityType;
  const [data, total] = await Promise.all([
    prisma.routingRule.findMany({ where, skip, take: limit, orderBy: [{ entityType: 'asc' }, { priority: 'asc' }] }),
    prisma.routingRule.count({ where }),
  ]);
  return { data, total };
}

async function createRoutingRule(data, adminId, ip) {
  if (data.targetPartnerId) {
    const partner = await prisma.user.findFirst({ where: { id: data.targetPartnerId, role: 'PARTNER' } });
    if (!partner) throw new ApiError(404, 'Target partner not found');
  }
  if (data.targetVendorId) {
    const vendor = await prisma.vendor.findUnique({ where: { id: data.targetVendorId } });
    if (!vendor) throw new ApiError(404, 'Target vendor not found');
  }

  const rule = await prisma.routingRule.create({ data: { ...data, createdByAdminId: adminId } });
  await createAuditLog({
    adminId, action: 'ROUTING_RULE_CREATED', targetType: 'RoutingRule', targetId: rule.id,
    after: rule, ipAddress: ip,
  });
  return rule;
}

async function updateRoutingRule(id, data, adminId, ip) {
  const existing = await prisma.routingRule.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Routing rule not found');

  if (data.targetPartnerId && existing.entityType !== 'LEAD') {
    throw new ApiError(400, 'targetPartnerId only applies to a LEAD rule');
  }
  if (data.targetVendorId && existing.entityType !== 'TICKET') {
    throw new ApiError(400, 'targetVendorId only applies to a TICKET rule');
  }

  const rule = await prisma.routingRule.update({ where: { id }, data });
  await createAuditLog({
    adminId, action: 'ROUTING_RULE_UPDATED', targetType: 'RoutingRule', targetId: id,
    before: existing, after: rule, ipAddress: ip,
  });
  return rule;
}

async function deleteRoutingRule(id, adminId, ip) {
  const existing = await prisma.routingRule.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Routing rule not found');

  await prisma.routingRule.delete({ where: { id } });
  await createAuditLog({
    adminId, action: 'ROUTING_RULE_DELETED', targetType: 'RoutingRule', targetId: id,
    before: existing, ipAddress: ip,
  });
  return { id };
}

// Mirrors autoAssignLead's pattern for tickets: this file never writes
// vendorId directly, it only decides WHO and leaves HOW to dispatchTicket
// (which still enforces its own gates — ticket not terminal, vendor active).
// Unlike leads, there is no ranked fallback pool for vendors (no existing
// workload/coverage model for them) — purely rule-driven, so "no rule
// matches" is a plain refusal rather than a partial pick.
async function dispatchTicketAutomatically(ticketId, adminId, ip) {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: { property: { select: { city: true } } },
  });
  if (!ticket) throw new ApiError(404, 'Ticket not found');

  const rule = await findMatchingRoutingRule('TICKET', {
    category: ticket.category, city: ticket.property?.city,
  });
  if (!rule?.targetVendorId) {
    throw new ApiError(400, 'No routing rule matches this ticket. Dispatch a vendor manually from the directory instead.');
  }

  const vendor = await prisma.vendor.findUnique({ where: { id: rule.targetVendorId } });
  if (!vendor?.isActive) {
    throw new ApiError(400, 'The vendor named by the matching routing rule is not active. Dispatch a vendor manually instead.');
  }

  return dispatchTicket(ticketId, { vendorId: vendor.id }, adminId, ip);
}

// ─── PROPERTY APPROVAL ───────────────────────────────────────────────────────

async function getPendingProperties(filters, skip, limit) {
  const where = { publishStatus: filters.status || 'PENDING_APPROVAL' };

  const [data, total] = await Promise.all([
    prisma.property.findMany({
      where,
      skip, take: limit,
      include: { partner: { select: { name: true, email: true, companyName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.property.count({ where }),
  ]);
  return { data, total };
}

// 4.14 — approval now takes a visibility choice. The three levels are
// independent rungs, not a single setting:
//
//   public   -> publishStatus APPROVED; reachable at its own URL. Always set
//               by approving, since that is what approval means.
//   search   -> isSearchable; appears in search and related-listing results.
//   homepage -> isFeatured; appears in the featured strip.
//
// Omitting the visibility object keeps the previous behaviour exactly: public
// and searchable, not featured. So existing callers are unaffected.
async function approveProperty(propertyId, adminId, ip, visibility = {}) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { partner: { select: { email: true } } },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const updated = await prisma.property.update({
    where: { id: propertyId },
    data: {
      publishStatus: 'APPROVED',
      rejectionNote: null,
      // Written explicitly rather than left missing, so an approved listing
      // always has a definite answer for the search filter.
      isSearchable: visibility.searchable !== undefined ? visibility.searchable : true,
      ...(visibility.homepageFeatured !== undefined ? { isFeatured: visibility.homepageFeatured } : {}),
      // Approving clears any outstanding change checklist: the fixes were
      // either made or no longer being asked for.
      requestedChanges: [],
      requestedChangesNote: null,
      changesRequestedAt: null,
      changesRequestedByAdminId: null,
    },
  });

  await createNotification({
    userId: property.partnerId,
    title: 'Listing Approved!',
    message: `Your listing "${property.title}" is now live.`,
    type: 'PROPERTY_APPROVED',
    linkUrl: `/properties/${property.slug}`,
  });

  await createAuditLog({
    adminId, action: 'PROPERTY_APPROVED', targetType: 'Property', targetId: propertyId,
    before: {
      publishStatus: property.publishStatus,
      isSearchable: property.isSearchable,
      isFeatured: property.isFeatured,
    },
    after: {
      publishStatus: 'APPROVED',
      isSearchable: updated.isSearchable,
      isFeatured: updated.isFeatured,
    },
    ipAddress: ip,
  });

  sendPropertyApproved(property.partner.email, property.title).catch(() => {});
  cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
  cacheDel(CACHE_KEYS.localityPage(property.city, property.locality));
  return updated;
}

async function rejectProperty(propertyId, note, adminId, ip) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { partner: { select: { email: true } } },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const updated = await prisma.property.update({
    where: { id: propertyId },
    data: { publishStatus: 'REJECTED', rejectionNote: note },
  });

  await createNotification({
    userId: property.partnerId,
    title: 'Listing Needs Changes',
    message: `Your listing "${property.title}" was not approved. Reason: ${note}`,
    type: 'PROPERTY_REJECTED',
    linkUrl: `/partner/listings/${propertyId}`,
  });

  await createAuditLog({
    adminId, action: 'PROPERTY_REJECTED', targetType: 'Property', targetId: propertyId,
    after: { publishStatus: 'REJECTED', note },
    ipAddress: ip,
  });

  sendPropertyRejected(property.partner.email, property.title, note).catch(() => {});
  cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
  cacheDel(CACHE_KEYS.localityPage(property.city, property.locality));
  return updated;
}

// 4.15 — ask the partner for specific fixes instead of rejecting outright.
//
// Distinct from rejectProperty: REJECTED is a refusal, CHANGES_REQUESTED is a
// live submission the partner is expected to correct and resend. Both are
// hidden from every public surface.
//
// Refused on an APPROVED listing on purpose. Moving a live listing to
// CHANGES_REQUESTED would pull it out of public view as a side effect of
// asking for a correction, which is rarely what anyone intends. Use the
// change-request flow for edits to live listings, or reject to take it down
// deliberately.
async function requestPropertyChanges(propertyId, { items, note }, adminId, adminName, ip) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { partner: { select: { email: true } } },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  if (property.publishStatus === 'APPROVED') {
    throw new ApiError(400,
      'This listing is live. Requesting changes would remove it from public view. '
      + 'Edit it directly, or reject it if it should come down.');
  }
  if (property.publishStatus === 'ARCHIVED') {
    throw new ApiError(400, 'This listing is archived');
  }

  const updated = await prisma.property.update({
    where: { id: propertyId },
    data: {
      publishStatus: 'CHANGES_REQUESTED',
      requestedChanges: items,
      requestedChangesNote: note || null,
      changesRequestedAt: new Date(),
      changesRequestedByAdminId: adminId,
      // The listing is no longer refused, so a stale rejection note would
      // contradict the checklist the partner is now being shown.
      rejectionNote: null,
    },
  });

  await createNotification({
    userId: property.partnerId,
    title: 'Changes requested on your listing',
    message: `Admin asked for ${items.length} fix(es) on "${property.title}"${note ? `: ${note}` : ''}`,
    type: 'PROPERTY_CHANGES_REQUESTED',
    linkUrl: `/partner/listings/${propertyId}`,
  });

  await createAuditLog({
    adminId, action: 'PROPERTY_CHANGES_REQUESTED', targetType: 'Property', targetId: propertyId,
    before: { publishStatus: property.publishStatus },
    after: { publishStatus: 'CHANGES_REQUESTED', items, note: note || null },
    ipAddress: ip,
  });

  // Reuses the rejection email rather than adding a near-identical template:
  // the partner needs the checklist, and this is the existing channel for
  // "your listing needs work". The subject line is the template's own.
  sendPropertyRejected(
    property.partner.email,
    property.title,
    `${note ? note + ' ' : ''}Requested fixes: ${items.join('; ')}`,
  ).catch(() => {});

  return updated;
}

// ─── KYC MANAGEMENT ──────────────────────────────────────────────────────────

async function getPendingKyc(skip, limit, statusFilter) {
  // Defaults to PENDING_REVIEW so the admin queue still works unchanged;
  // pass ?status=VERIFIED|REJECTED|NOT_SUBMITTED to see other buckets.
  const kycStatus = statusFilter || 'PENDING_REVIEW';
  const where = { role: 'PARTNER', kycStatus };

  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where, skip, take: limit,
      select: {
        id: true, name: true, email: true, companyName: true, partnerSubType: true,
        kycDocumentUrls: true, kycStatus: true, kycRejectionNote: true, kycVerifiedAt: true,
        createdAt: true,
        // 5.x — advisory automated-check results, surfaced alongside the
        // manual review queue, never replacing it.
        panVerificationStatus: true, panVerifiedName: true,
        gstinVerificationStatus: true, gstinVerifiedName: true,
        reraVerificationStatus: true, reraVerifiedName: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.count({ where }),
  ]);
  return { data, total };
}

// R9 — ask for specific documents instead of rejecting outright.
//
// dueInDays is informational, not enforced server-side: nothing auto-rejects
// when it passes. kycRequestEffectiveStatus reports it as overdue, for an
// admin to act on, the same non-destructive default already used for the
// listing change-request and owner-confirmation timeouts in this codebase.
async function requestKycDocuments(userId, { items, note, dueInDays }, adminId, ip) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.kycStatus === 'VERIFIED') throw new ApiError(400, 'KYC is already verified');

  const dueAt = dueInDays ? new Date(Date.now() + dueInDays * 86400000) : null;

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      kycStatus: 'DOCUMENTS_REQUESTED',
      kycRequestedDocuments: items,
      kycRequestedNote: note || null,
      kycRequestedAt: new Date(),
      kycRequestedDueAt: dueAt,
      kycRequestedByAdminId: adminId,
      // A stale rejection note would contradict the checklist now being shown.
      kycRejectionNote: null,
    },
    select: { id: true, name: true, kycStatus: true, kycRequestedDocuments: true, kycRequestedDueAt: true },
  });

  await createNotification({
    userId,
    title: 'Additional KYC documents needed',
    message: `Admin asked for ${items.length} document(s)${note ? `: ${note}` : ''}`,
    type: 'KYC_UPDATE',
    linkUrl: '/partner/profile',
  });

  await createAuditLog({
    adminId, action: 'KYC_DOCUMENTS_REQUESTED', targetType: 'User', targetId: userId,
    before: { kycStatus: user.kycStatus },
    after: { kycStatus: 'DOCUMENTS_REQUESTED', items, note: note || null, dueAt },
    ipAddress: ip,
  });

  return updated;
}

// Overdue is derived at read time, never stored — a stored flag would need a
// scheduled job and would be wrong for the whole window between the deadline
// and the next run.
function kycRequestEffectiveStatus(user) {
  if (user.kycStatus !== 'DOCUMENTS_REQUESTED') return user.kycStatus;
  if (user.kycRequestedDueAt && user.kycRequestedDueAt < new Date()) return 'DOCUMENTS_REQUESTED_OVERDUE';
  return 'DOCUMENTS_REQUESTED';
}

async function verifyKyc(userId, action, note, adminId, ip) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found');

  const kycStatus = action === 'APPROVE' ? 'VERIFIED' : 'REJECTED';

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      kycStatus,
      kycVerifiedAt: action === 'APPROVE' ? new Date() : null,
      kycRejectionNote: note || null,
    },
    select: { id: true, name: true, email: true, kycStatus: true, kycVerifiedAt: true, kycRejectionNote: true },
  });

  await createNotification({
    userId,
    title: action === 'APPROVE' ? 'Account Verified!' : 'KYC Needs Attention',
    message: action === 'APPROVE'
      ? 'Your KYC has been verified. You can now list properties and receive leads.'
      : `Your KYC was rejected. Reason: ${note}`,
    type: 'KYC_UPDATE',
    linkUrl: '/partner/profile',
  });

  await createAuditLog({
    adminId, action: `KYC_${action}`, targetType: 'User', targetId: userId,
    after: { kycStatus }, ipAddress: ip,
  });

  if (action === 'APPROVE') {
    sendKycVerified(user.email).catch(() => {});
  } else {
    sendKycRejected(user.email, note).catch(() => {});
  }

  return updated;
}

// ─── REVENUE DASHBOARD ───────────────────────────────────────────────────────

async function getRevenueSummary() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [escrowHeld, escrowReleased, servicesRevenue, closedLeads, totalLeads] = await Promise.all([
    prisma.escrowTransaction.aggregate({ where: { status: 'HELD' }, _sum: { amount: true }, _count: true }),
    prisma.escrowTransaction.aggregate({
      where: { status: 'RELEASED', releasedAt: { gte: startOfMonth } },
      _sum: { amount: true }, _count: true,
    }),
    prisma.userSubscription.aggregate({
      where: { paymentStatus: 'SUCCESS', startDate: { gte: startOfMonth } },
      _sum: { amountPaid: true }, _count: true,
    }),
    prisma.lead.count({ where: { status: 'CLOSED', updatedAt: { gte: startOfMonth } } }),
    prisma.lead.count(),
  ]);

  return {
    escrowHeld:        { amount: escrowHeld._sum.amount || 0,         count: escrowHeld._count },
    escrowReleasedMTD: { amount: escrowReleased._sum.amount || 0,      count: escrowReleased._count },
    serviceRevenueMTD: { amount: servicesRevenue._sum.amountPaid || 0, count: servicesRevenue._count },
    closedLeadsMTD: closedLeads,
    totalLeads,
  };
}

// ─── PROPERTY EDIT (Admin) ───────────────────────────────────────────────────

async function editProperty(propertyId, data, adminId, adminName, ip) {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property) throw new ApiError(404, 'Property not found');

  const FORBIDDEN = ['partnerId', 'slug'];
  FORBIDDEN.forEach((f) => delete data[f]);

  const editLogRows = Object.entries(data)
    .filter(([field, newVal]) => String(property[field] ?? '') !== String(newVal ?? ''))
    .map(([field, newVal]) => ({
      propertyId,
      editedBy:     adminId,
      editedByName: adminName,
      fieldChanged: field,
      oldValue:     property[field] != null ? JSON.stringify(property[field]) : null,
      newValue:     newVal     != null ? JSON.stringify(newVal)              : null,
    }));

  const [updated] = await prisma.$transaction([
    prisma.property.update({ where: { id: propertyId }, data }),
    ...editLogRows.map((row) => prisma.propertyEditLog.create({ data: row })),
  ]);

  if (editLogRows.length > 0) {
    await createNotification({
      userId:  property.partnerId,
      title:   'Your listing was edited by Admin',
      message: `Admin updated ${editLogRows.length} field(s) on "${property.title}". Changes are visible on your listing.`,
      type:    'PROPERTY_EDITED_BY_ADMIN',
      linkUrl: `/partner/listings/${propertyId}`,
    });

    await createAuditLog({
      adminId, action: 'PROPERTY_EDITED', targetType: 'Property', targetId: propertyId,
      before: Object.fromEntries(editLogRows.map((r) => [r.fieldChanged, r.oldValue])),
      after:  Object.fromEntries(editLogRows.map((r) => [r.fieldChanged, r.newValue])),
      ipAddress: ip,
    });
  }

  if (property.publishStatus === 'APPROVED' || updated.publishStatus === 'APPROVED') {
    cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
    cacheDel(CACHE_KEYS.localityPage(property.city, property.locality));
    if (updated.city !== property.city || updated.locality !== property.locality) {
      cacheDel(CACHE_KEYS.localityPage(updated.city, updated.locality));
    }
  }

  return updated;
}

// ─── LOAN MANAGEMENT (Admin) ─────────────────────────────────────────────────

async function getAllLoans(filters, skip, limit) {
  const where = {};
  if (filters.status) {
    where.status = Array.isArray(filters.status) ? { in: filters.status } : filters.status;
  }
  if (filters.userId) where.userId = filters.userId;

  const [data, total] = await Promise.all([
    prisma.loanApplication.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user:     { select: { name: true, email: true, phone: true } },
        property: { select: { title: true, slug: true, city: true } },
      },
    }),
    prisma.loanApplication.count({ where }),
  ]);
  return { data, total };
}

// Per-bank aggregate for the admin loan page's bank cards (§4.3) — real
// groupBy over the full table, not computed client-side from one page.
async function getLoanBankStats() {
  const loans = await prisma.loanApplication.findMany({
    where: { preferredBank: { not: null } },
    select: { preferredBank: true, status: true, loanAmountRequestedPaise: true },
  });

  const byBank = {};
  for (const loan of loans) {
    const bank = loan.preferredBank;
    byBank[bank] ??= { bank, applications: 0, sanctioned: 0, totalRequestedPaise: 0 };
    byBank[bank].applications += 1;
    if (['SANCTIONED', 'DISBURSED'].includes(loan.status)) byBank[bank].sanctioned += 1;
    byBank[bank].totalRequestedPaise += loan.loanAmountRequestedPaise || 0;
  }

  return Object.values(byBank).map((b) => ({
    bank: b.bank,
    applications: b.applications,
    sanctioned: b.sanctioned,
    closeRatePct: b.applications ? Math.round((b.sanctioned / b.applications) * 1000) / 10 : 0,
    avgRequestedPaise: b.applications ? Math.round(b.totalRequestedPaise / b.applications) : 0,
  }));
}

async function updateLoanStatus(loanId, status, adminNote, adminId, extraFields = {}) {
  const loan = await prisma.loanApplication.findUnique({
    where: { id: loanId },
    include: { user: { select: { email: true } } },
  });
  if (!loan) throw new ApiError(404, 'Loan application not found');

  const statusFields = {};
  if (status === 'SANCTIONED') statusFields.sanctionedAt = new Date();
  if (status === 'DISBURSED')  statusFields.disbursedAt  = new Date();

  // Dev feedback, 2026-10-08 (L4) — statusHistory existed on the model
  // but nothing ever wrote to it, so the tracker's step list could only
  // ever show the current status, never when each stage was actually
  // reached or why. Json[] of plain objects (not JSON-encoded strings —
  // the field type changed to match), carrying `note` — the reason for
  // THIS specific transition, not the lead-level adminNote it may fall
  // back to — so a dated timeline can show what changed and why at each
  // step.
  const historyEntry = { status, at: new Date().toISOString(), note: adminNote || null };

  const updated = await prisma.loanApplication.update({
    where: { id: loanId },
    data: {
      status, adminNote: adminNote || loan.adminNote, ...statusFields, ...extraFields,
      statusHistory: [...loan.statusHistory, historyEntry],
    },
  });

  await createNotification({
    userId:  loan.userId,
    title:   'Loan Application Update',
    message: `Your loan application status has been updated to ${status.replace(/_/g, ' ')}.`,
    type:    'LOAN_STATUS_UPDATE',
    // Dev feedback, 2026-10-08 (L5) — /dashboard/loan/:id doesn't exist
    // in the frontend. SANCTIONED has its own detail screen
    // (/user/loans/sanctioned?id=...); every other status just goes to
    // the list, since there's no per-status detail route for those.
    linkUrl: status === 'SANCTIONED' ? `/user/loans/sanctioned?id=${loanId}` : '/user/loans',
  });

  sendLoanStatusUpdate(loan.user.email, status, adminNote, loanId).catch(() => {});

  return updated;
}

// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────

async function getAllUsers(filters, skip, limit) {
  // Soft-deleted rows (clerk.handler.js's user.deleted) are kept only to
  // preserve foreign keys on records they used to own — they should never
  // show up as if still a real account. isSet: false, not deletedAt: null —
  // every pre-existing row has the field missing entirely (added after they
  // were created), and a plain `null` filter only matches an *explicit*
  // null, so it would have matched zero rows and emptied this whole list.
  const where = { deletedAt: { isSet: false } };
  if (filters.role)   where.role = filters.role;
  if (filters.search) where.OR   = [
    { name:    { contains: filters.search, mode: 'insensitive' } },
    { email:   { contains: filters.search, mode: 'insensitive' } },
    { refCode: { contains: filters.search, mode: 'insensitive' } },
  ];

  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where, skip, take: limit,
      select: { id: true, refCode: true, name: true, email: true, phone: true, phoneVerified: true, role: true, kycStatus: true, partnerSubType: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  return { data, total };
}

async function changeUserRole(targetUserId, newRole, adminId, ip) {
  if (targetUserId === adminId) throw new ApiError(400, 'Cannot change your own role');
  if (!ROLES.includes(newRole)) throw new ApiError(400, 'Invalid role');

  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw new ApiError(404, 'User not found');

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data:  { role: newRole },
    select: { id: true, name: true, email: true, role: true, clerkId: true },
  });

  // The DB role is already authoritative here (every backend auth check reads
  // it, never Clerk's), but anything that trusts Clerk's own copy directly —
  // e.g. a frontend portal gate reading publicMetadata.role — would keep
  // showing the old role until this sync succeeds. One immediate retry (same
  // pattern as auth.service.js's createAccount sign-in token) cuts how often
  // a transient Clerk blip leaves that copy stale; a failure that survives
  // the retry is logged at `error` (not the original silent `warn`) and
  // flagged in the response so the admin UI can surface it, not just a log line.
  let clerkSyncFailed = false;
  try {
    await setUserRole(user.clerkId, newRole);
  } catch (firstErr) {
    try {
      await setUserRole(user.clerkId, newRole);
    } catch (err) {
      clerkSyncFailed = true;
      logger.error('[changeUserRole] Clerk publicMetadata sync failed after retry', { clerkId: user.clerkId, error: err.message });
    }
  }

  await createAuditLog({
    adminId, action: 'ROLE_CHANGED', targetType: 'User', targetId: targetUserId,
    before: { role: user.role }, after: { role: newRole, clerkSyncFailed },
    ipAddress: ip,
  });

  return { ...updated, ...(clerkSyncFailed && { clerkSyncFailed }) };
}

async function suspendUser(targetUserId, suspend, reason, adminId, ip) {
  if (targetUserId === adminId) throw new ApiError(400, 'Cannot suspend yourself');
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.role === 'ADMIN') throw new ApiError(403, 'Cannot suspend an admin account');

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: {
      isSuspended:  suspend,
      suspendedAt:  suspend ? new Date() : null,
      suspendReason: suspend ? (reason || null) : null,
    },
    select: { id: true, name: true, email: true, role: true, isSuspended: true, suspendedAt: true, suspendReason: true },
  });

  await createAuditLog({
    adminId, action: suspend ? 'USER_SUSPENDED' : 'USER_UNSUSPENDED',
    targetType: 'User', targetId: targetUserId,
    before: { isSuspended: user.isSuspended },
    after:  { isSuspended: suspend, suspendReason: reason || null },
    ipAddress: ip,
  });

  return updated;
}

// ─── STAFF DIRECTORY / PERMISSION MATRIX (16.x) ──────────────────────────────
// Internal RealtyDoor staff — every ADMIN-role User, with a staffRole label
// and the adminPermissions scopes middleware/requirePermission.js actually
// authorizes against. Distinct from TeamMember (the public About-page
// roster, no auth implications) and from Vendor (external contractors).

async function listStaff(skip, limit) {
  const where = { role: 'ADMIN' };
  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'asc' },
      select: {
        id: true, name: true, email: true, phone: true,
        staffRole: true, adminPermissions: true, isSuspended: true, createdAt: true,
      },
    }),
    prisma.user.count({ where }),
  ]);
  return { data, total };
}

// Promotes an existing account to staff. Reuses changeUserRole for the
// actual role flip (+ its Clerk sync) if not already ADMIN, then layers the
// staffRole/permissions on top. staffRole is required here — unlike
// updateStaffPermissions, a brand-new staff member should never land in the
// "staffRole unset = full access" fail-open state by accident.
async function createStaffMember(targetUserId, { staffRole, permissions }, adminId, ip) {
  if (!ADMIN_STAFF_ROLES.includes(staffRole)) {
    throw new ApiError(400, `staffRole must be one of ${ADMIN_STAFF_ROLES.join(', ')}`);
  }
  const grantedPermissions = permissions ?? DEFAULT_PERMISSIONS_BY_STAFF_ROLE[staffRole] ?? [];
  const invalid = grantedPermissions.filter((p) => !ADMIN_PERMISSION_SCOPES.includes(p));
  if (invalid.length) throw new ApiError(400, `Unknown permission(s): ${invalid.join(', ')}`);

  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new ApiError(404, 'User not found');

  if (target.role !== 'ADMIN') {
    await changeUserRole(targetUserId, 'ADMIN', adminId, ip);
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { staffRole, adminPermissions: grantedPermissions },
    select: { id: true, name: true, email: true, role: true, staffRole: true, adminPermissions: true },
  });

  await createAuditLog({
    adminId, action: 'STAFF_MEMBER_CREATED', targetType: 'User', targetId: targetUserId,
    after: { staffRole, permissions: grantedPermissions }, ipAddress: ip,
  });

  return updated;
}

async function updateStaffPermissions(targetUserId, { staffRole, permissions }, adminId, ip) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new ApiError(404, 'User not found');
  if (target.role !== 'ADMIN') throw new ApiError(400, 'This user is not a staff member');

  if (staffRole !== undefined && staffRole !== null && !ADMIN_STAFF_ROLES.includes(staffRole)) {
    throw new ApiError(400, `staffRole must be one of ${ADMIN_STAFF_ROLES.join(', ')}`);
  }
  if (permissions !== undefined) {
    const invalid = permissions.filter((p) => !ADMIN_PERMISSION_SCOPES.includes(p));
    if (invalid.length) throw new ApiError(400, `Unknown permission(s): ${invalid.join(', ')}`);
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: {
      ...(staffRole !== undefined && { staffRole }),
      ...(permissions !== undefined && { adminPermissions: permissions }),
    },
    select: { id: true, name: true, email: true, staffRole: true, adminPermissions: true },
  });

  await createAuditLog({
    adminId, action: 'STAFF_PERMISSIONS_UPDATED', targetType: 'User', targetId: targetUserId,
    before: { staffRole: target.staffRole, adminPermissions: target.adminPermissions },
    after: { staffRole: updated.staffRole, adminPermissions: updated.adminPermissions },
    ipAddress: ip,
  });

  return updated;
}

// Offboards a staff member back to a plain USER account — distinct from
// suspendUser above, which still refuses to touch an ADMIN account at all
// (unrelated to this feature; left as-is).
async function removeStaffMember(targetUserId, adminId, ip) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new ApiError(404, 'User not found');
  if (target.role !== 'ADMIN') throw new ApiError(400, 'This user is not a staff member');

  await changeUserRole(targetUserId, 'USER', adminId, ip);
  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { staffRole: null, adminPermissions: [] },
    select: { id: true, name: true, email: true, role: true },
  });

  await createAuditLog({
    adminId, action: 'STAFF_MEMBER_REMOVED', targetType: 'User', targetId: targetUserId,
    before: { staffRole: target.staffRole }, after: { role: 'USER' }, ipAddress: ip,
  });

  return updated;
}

// ─── TICKET MANAGEMENT ───────────────────────────────────────────────────────

// 7.3 — SLA by priority, admin-configurable per tier (mirrors
// commission.service.js's getConfigNumber pattern), with sensible defaults.
// Computed at read time, never stored: the same reasoning as every other
// derived-status field in this codebase (ExclusiveMandate.effectiveStatus,
// OwnerConfirmation's TIMED_OUT) — a stored "breached" flag would need a
// scheduled job and would be wrong in the window before it next ran.
const TICKET_SLA_HOURS_KEYS = {
  URGENT: 'ticket_sla_hours_urgent',
  HIGH:   'ticket_sla_hours_high',
  NORMAL: 'ticket_sla_hours_normal',
};
const TICKET_SLA_HOURS_DEFAULT = { URGENT: 12, HIGH: 24, NORMAL: 72 };
const TICKET_TERMINAL_STATUSES = ['RESOLVED', 'VERIFIED_BY_USER'];

async function slaHoursFor(priority) {
  const key = TICKET_SLA_HOURS_KEYS[priority] || TICKET_SLA_HOURS_KEYS.NORMAL;
  return getConfigNumber(key, TICKET_SLA_HOURS_DEFAULT[priority] ?? TICKET_SLA_HOURS_DEFAULT.NORMAL);
}

// over12h is deliberately a flat, priority-independent threshold distinct
// from slaBreached (which is priority-tiered) — it's the "needs eyes on it
// regardless of how it's classified" signal for the admin unassigned list.
async function presentTicket(ticket) {
  const hours = await slaHoursFor(ticket.priority);
  const deadline = new Date(ticket.createdAt.getTime() + hours * 3_600_000);
  const terminal = TICKET_TERMINAL_STATUSES.includes(ticket.status);
  const ageMs = Date.now() - ticket.createdAt.getTime();
  return {
    ...ticket,
    slaDeadline: deadline,
    slaBreached: !terminal && Date.now() > deadline,
    over12h: !terminal && ageMs > 12 * 3_600_000,
  };
}

async function getTicketById(ticketId) {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: {
      user:         { select: { id: true, name: true, email: true, phone: true } },
      // 7.7 — price/features were on Service all along; nothing selected them.
      subscription: { include: { service: { select: { name: true, category: true, price: true, features: true } } } },
      comments:     { orderBy: { createdAt: 'asc' } },
      vendor:       { select: { id: true, name: true, phone: true, category: true } },
      lead:         { select: { id: true, refCode: true } },
    },
  });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  return presentTicket(ticket);
}

async function getAllTickets(filters, skip, limit) {
  const where = {};
  if (filters.status)   where.status   = filters.status;
  if (filters.userId)   where.userId   = filters.userId;
  if (filters.category) where.category = filters.category;
  if (filters.vendorId) where.vendorId = filters.vendorId;
  if (filters.search) where.OR = [
    { subject:     { contains: filters.search, mode: 'insensitive' } },
    { description: { contains: filters.search, mode: 'insensitive' } },
    { vendorName:  { contains: filters.search, mode: 'insensitive' } },
  ];

  const [rows, total] = await Promise.all([
    prisma.serviceTicket.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user:         { select: { name: true, email: true, phone: true } },
        subscription: { include: { service: { select: { name: true, price: true } } } },
        vendor:       { select: { id: true, name: true, category: true } },
      },
    }),
    prisma.serviceTicket.count({ where }),
  ]);
  const data = await Promise.all(rows.map(presentTicket));
  return { data, total };
}

// Fetches the whole table once and computes in JS rather than filtering
// `vendorName: null` in the query — on MongoDB that filter only matches rows
// where the field was explicitly set to null, not ones where it was never
// written at all (confirmed empirically — see escrowAutoEscalate.js), which
// would silently undercount "unassigned" for most existing tickets.
async function getTicketStats() {
  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const [tickets, slaHours] = await Promise.all([
    prisma.serviceTicket.findMany({
      select: {
        status: true, vendorName: true, priority: true, createdAt: true, resolvedAt: true,
        vendorRating: true, wasReopened: true,
      },
    }),
    Promise.all(['URGENT', 'HIGH', 'NORMAL'].map(async (p) => [p, await slaHoursFor(p)])).then(Object.fromEntries),
  ]);

  const unassigned = tickets.filter((t) => !t.vendorName).length;
  const inProgress = tickets.filter((t) => t.status === 'IN_PROGRESS').length;
  const resolvedThisWeek = tickets.filter((t) => t.resolvedAt && t.resolvedAt >= startOfWeek).length;
  const resolved = tickets.filter((t) => t.resolvedAt);
  const avgResolutionDays = resolved.length
    ? resolved.reduce((sum, t) => sum + (t.resolvedAt - t.createdAt) / 86_400_000, 0) / resolved.length
    : 0;

  // 7.3 — unassigned tickets whose SLA is already blown, the admin screen's
  // "needs attention right now" count.
  const now = Date.now();
  const nonTerminal = tickets.filter((t) => !TICKET_TERMINAL_STATUSES.includes(t.status));
  const unassignedSlaBreached = nonTerminal.filter((t) =>
    !t.vendorName && now > t.createdAt.getTime() + (slaHours[t.priority] ?? slaHours.NORMAL) * 3_600_000
  ).length;
  const over12hCount = nonTerminal.filter((t) => now - t.createdAt.getTime() > 12 * 3_600_000).length;

  // 7.6 — rated tickets only (most tickets are never rated); "first-time"
  // means verified without ever having been reopened first.
  const rated = tickets.filter((t) => t.vendorRating != null);
  const avgVendorRating = rated.length ? rated.reduce((s, t) => s + t.vendorRating, 0) / rated.length : null;
  const verified = tickets.filter((t) => t.status === 'VERIFIED_BY_USER');
  const firstTimeVerifyRate = verified.length
    ? Math.round((verified.filter((t) => !t.wasReopened).length / verified.length) * 1000) / 10
    : null;

  return {
    unassigned,
    inProgress,
    resolvedThisWeek,
    avgResolutionDays: Math.round(avgResolutionDays * 10) / 10,
    unassignedSlaBreached,
    over12hCount,
    avgVendorRating: avgVendorRating != null ? Math.round(avgVendorRating * 10) / 10 : null,
    firstTimeVerifyRatePct: firstTimeVerifyRate,
  };
}

const TICKET_TRANSITIONS = {
  OPEN:             ['IN_PROGRESS'],
  IN_PROGRESS:      ['RESOLVED', 'OPEN'],
  RESOLVED:         ['IN_PROGRESS'],
  VERIFIED_BY_USER: [],
};

async function updateTicketStatus(ticketId, status, vendorName, vendorPhone) {
  const ticket = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');

  const data = {};

  if (status !== undefined) {
    const allowed = TICKET_TRANSITIONS[ticket.status] ?? [];
    if (!allowed.includes(status)) {
      throw new ApiError(400, `Cannot transition ticket from ${ticket.status} to ${status}`);
    }
    data.status = status;
  }

  if (vendorName  !== undefined) data.vendorName  = vendorName;
  if (vendorPhone !== undefined) data.vendorPhone = vendorPhone;

  return prisma.serviceTicket.update({ where: { id: ticketId }, data });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 7.2 — a real Vendor link (vendorId) plus the scheduling/contact/quote
// details dispatch actually needs, instead of the free-text vendorName/
// vendorPhone updateTicketStatus above still supports for a quick manual
// edit. vendorName/vendorPhone are still written here too (denormalized
// display cache from the chosen Vendor, same pattern as Lead.buyerName
// alongside buyerId) so existing list views keep working unchanged.
//
// 7.9 — also doubles as the reassign action: calling this again with a
// different vendorId on the same ticket reassigns it. Distinguished in the
// audit log and the user-facing notification, not by a separate endpoint.
async function dispatchTicket(ticketId, data, adminId, ip) {
  const ticket = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  if (TICKET_TERMINAL_STATUSES.includes(ticket.status)) {
    throw new ApiError(400, `Cannot dispatch a vendor on a ${ticket.status} ticket`);
  }

  const vendor = await prisma.vendor.findUnique({ where: { id: data.vendorId } });
  if (!vendor) throw new ApiError(404, 'Vendor not found');
  if (!vendor.isActive) throw new ApiError(400, 'This vendor is not active');

  const isReassign = !!ticket.vendorId && ticket.vendorId !== vendor.id;

  const updated = await prisma.serviceTicket.update({
    where: { id: ticketId },
    data: {
      vendorId: vendor.id, vendorName: vendor.name, vendorPhone: vendor.phone,
      // Dispatching is when work actually starts; a still-OPEN ticket moves
      // to IN_PROGRESS as a side effect. A reassignment (already IN_PROGRESS
      // or RESOLVED-bounced-back) leaves status untouched.
      ...(ticket.status === 'OPEN' && { status: 'IN_PROGRESS' }),
      ...(data.scheduledSlot !== undefined && { scheduledSlot: new Date(data.scheduledSlot) }),
      ...(data.tenantContactName !== undefined && { tenantContactName: data.tenantContactName }),
      ...(data.tenantContactPhone !== undefined && { tenantContactPhone: data.tenantContactPhone }),
      ...(data.quotedChargeAmount !== undefined && { quotedChargeAmount: data.quotedChargeAmount }),
    },
  });

  await createNotification({
    userId: ticket.userId,
    title: isReassign ? 'Vendor reassigned' : 'Vendor dispatched',
    message: `${vendor.name} has been ${isReassign ? 're-' : ''}assigned to your ticket "${ticket.subject}"`
      + `${data.scheduledSlot ? ` for ${new Date(data.scheduledSlot).toLocaleString('en-IN')}` : ''}.`,
    type: isReassign ? 'TICKET_VENDOR_REASSIGNED' : 'TICKET_VENDOR_DISPATCHED',
    linkUrl: `/user/tickets/${ticketId}`,
  });

  await createAuditLog({
    adminId, action: isReassign ? 'TICKET_VENDOR_REASSIGNED' : 'TICKET_VENDOR_DISPATCHED',
    targetType: 'ServiceTicket', targetId: ticketId,
    before: { vendorId: ticket.vendorId }, after: { vendorId: vendor.id }, ipAddress: ip,
  });

  return updated;
}

// 7.5 — resolving with an itemised charge breakdown and a receipt, instead
// of the bare status flip updateTicketStatus does. 7.4's before/after split:
// resolutionUrls (the vendor/admin's "after" evidence) is written here for
// the first time anywhere in the codebase — it existed on the schema but
// nothing ever set it.
async function resolveTicket(ticketId, data, adminId, ip) {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: { user: { select: { name: true } } },
  });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  const allowed = TICKET_TRANSITIONS[ticket.status] ?? [];
  if (!allowed.includes('RESOLVED')) {
    throw new ApiError(400, `Cannot resolve a ticket from status ${ticket.status}`);
  }

  const visitCharge = data.visitCharge ?? 0;
  const partsCharge = data.partsCharge ?? 0;
  const totalCharge = round2(visitCharge + partsCharge);

  // A zero-charge resolution (most tickets, covered by the subscription) has
  // nothing to issue a receipt for.
  let invoiceUrl = null;
  if (totalCharge > 0) {
    const resolvedAt = new Date();
    const pdfBuffer = await buildTicketChargeReceiptPdf({
      ticketSubject: ticket.subject, userName: ticket.user?.name,
      visitCharge, partsCharge, totalCharge, resolvedAt,
    });
    const { url } = await s3Upload(pdfBuffer, 'receipts', `ticket-charge-${ticketId}.pdf`, 'application/pdf');
    invoiceUrl = url;
  }

  const updated = await prisma.serviceTicket.update({
    where: { id: ticketId },
    data: {
      status: 'RESOLVED', resolvedAt: new Date(),
      ...(data.resolutionUrls !== undefined && { resolutionUrls: data.resolutionUrls }),
      visitCharge, partsCharge, totalCharge,
      ...(invoiceUrl && { invoiceUrl }),
      ...(data.note !== undefined && {
        adminNotes: `${ticket.adminNotes ? `${ticket.adminNotes} | ` : ''}${data.note}`,
      }),
    },
  });

  await createNotification({
    userId: ticket.userId,
    title: 'Service ticket resolved',
    message: `Your ticket "${ticket.subject}" has been resolved`
      + `${totalCharge > 0 ? ` — total charge ₹${totalCharge.toLocaleString('en-IN')}` : ''}. Please verify.`,
    type: 'TICKET_RESOLVED',
    linkUrl: `/user/tickets/${ticketId}`,
  });

  await createAuditLog({
    adminId, action: 'TICKET_RESOLVED', targetType: 'ServiceTicket', targetId: ticketId,
    after: { visitCharge, partsCharge, totalCharge, invoiceUrl }, ipAddress: ip,
  });

  return updated;
}

// 7.8 — links a post-purchase ticket back to the deal (Lead) it traces to.
// Separate from the generic update above since it's a distinct, narrow
// correction admin makes once, not a field that changes with ticket status.
async function linkTicketToDeal(ticketId, leadId, adminId, ip) {
  const ticket = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, refCode: true } });
  if (!lead) throw new ApiError(404, 'Lead not found');

  const updated = await prisma.serviceTicket.update({ where: { id: ticketId }, data: { leadId } });

  await createAuditLog({
    adminId, action: 'TICKET_LINKED_TO_DEAL', targetType: 'ServiceTicket', targetId: ticketId,
    before: { leadId: ticket.leadId }, after: { leadId, leadRef: lead.refCode }, ipAddress: ip,
  });

  return updated;
}

// backend-work-still-open.md #9 — the admin side of the same thread the
// user already sees, not a separate admin-only one. No userId scope (admin
// can read/reply on any ticket); the user-facing
// GET/POST /user/tickets/:id/comments stay USER-only, unchanged.
async function getAdminTicketComments(ticketId) {
  const ticket = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  return prisma.ticketComment.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
}

async function addAdminTicketComment(ticketId, adminId, { text, photos }) {
  const ticket = await prisma.serviceTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');

  const comment = await prisma.ticketComment.create({
    data: { ticketId, authorId: adminId, authorRole: 'ADMIN', text, photos: photos || [] },
  });

  await createNotification({
    userId: ticket.userId,
    title: 'New reply on your ticket',
    message: `${text.slice(0, 150)}${text.length > 150 ? '…' : ''}`,
    type: 'TICKET_ADMIN_REPLY',
    linkUrl: `/user/tickets/${ticketId}`,
  });

  return comment;
}

// ─── AUDIT LOGS ──────────────────────────────────────────────────────────────

async function getAuditLogs(filters, skip, limit) {
  const where = {};
  if (filters.action)     where.action     = filters.action;
  if (filters.adminId)    where.adminId    = filters.adminId;
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.targetId)   where.targetId   = filters.targetId;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to)   where.createdAt.lte = new Date(filters.to);
  }

  const [data, total] = await Promise.all([
    prisma.auditLog.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.auditLog.count({ where }),
  ]);
  return { data, total };
}

// ─── PARTNER DRILL-DOWN ───────────────────────────────────────────────────────

async function getPartnerById(partnerId) {
  const partner = await prisma.user.findFirst({
    where: { id: partnerId, role: 'PARTNER' },
    select: {
      id: true, name: true, email: true, phone: true, companyName: true,
      partnerSubType: true, bio: true, profileImageUrl: true, websiteUrl: true,
      kycStatus: true, kycRejectionNote: true, kycVerifiedAt: true, kycConsentAt: true,
      isPremiumPartner: true, premiumValidUntil: true,
      // 3.2/3.3 — structured identity instead of reading the KYC PDFs.
      reraNumber: true, gstin: true, coverageAreas: true, address: true,
      partnerTermsVersion: true, partnerTermsAcceptedAt: true,
      // 3.4/B5.8 — RazorpayX payout account (not Route; see user.prisma).
      payoutAccountStatus: true, payoutAccountNote: true, payoutValidatedAt: true,
      razorpayContactId: true, razorpayFundAccountId: true,
      bankName: true, bankIfsc: true, bankHolderName: true, bankAccountNo: true,
      bankLinkedAt: true, panNumber: true,
      isSuspended: true, suspendedAt: true, suspendReason: true,
      createdAt: true,
      assignedLeads: {
        select: {
          id: true, status: true, buyerName: true, createdAt: true,
          property: { select: { title: true, slug: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
      properties: {
        select: {
          id: true, title: true, slug: true, publishStatus: true,
          price: true, city: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });
  if (!partner) throw new ApiError(404, 'Partner not found');

  const [totalLeads, closedLeads, droppedLeads, totalListings, activeListings] = await Promise.all([
    prisma.lead.count({ where: { assignedPartnerId: partnerId } }),
    prisma.lead.count({ where: { assignedPartnerId: partnerId, status: 'CLOSED' } }),
    prisma.lead.count({ where: { assignedPartnerId: partnerId, status: 'DROPPED' } }),
    prisma.property.count({ where: { partnerId } }),
    prisma.property.count({ where: { partnerId, publishStatus: 'APPROVED' } }),
  ]);

  return {
    // Account number and PAN are masked before returning — an admin
    // partner page doesn't need the full values, and this payload is easy
    // to copy out. Reuses partners.service.js's maskPayout rather than a
    // second, separately-maintained copy of the same masking logic.
    ...partnerService.maskPayout(partner),
    metrics: { totalLeads, closedLeads, droppedLeads, totalListings, activeListings },
  };
}

// ─── SERVICE CATALOG MANAGEMENT ──────────────────────────────────────────────

async function adminListServices() {
  return prisma.service.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    include: { _count: { select: { subscriptions: true } } },
  });
}

async function adminCreateService(data) {
  const svc = await prisma.service.create({ data });
  cacheDel(CACHE_KEYS.SERVICES_LIST);
  return svc;
}

async function adminUpdateService(id, data) {
  const svc = await prisma.service.findUnique({ where: { id } });
  if (!svc) throw new ApiError(404, 'Service not found');
  const updated = await prisma.service.update({ where: { id }, data });
  cacheDel(CACHE_KEYS.SERVICES_LIST);
  return updated;
}

async function adminDeleteService(id) {
  const svc = await prisma.service.findUnique({ where: { id } });
  if (!svc) throw new ApiError(404, 'Service not found');
  // Soft-delete — keeps existing subscriptions resolvable
  const deactivated = await prisma.service.update({ where: { id }, data: { isActive: false } });
  cacheDel(CACHE_KEYS.SERVICES_LIST);
  return deactivated;
}

// ─── PARTNER METRICS ─────────────────────────────────────────────────────────

async function getPartnerMetrics(skip, limit) {
  const [partners, total] = await Promise.all([
    prisma.user.findMany({
      where: { role: 'PARTNER', kycStatus: 'VERIFIED' },
      skip, take: limit,
      select: {
        id: true, name: true, companyName: true, partnerSubType: true,
        // backend-work-still-open.md #12 — the suspend/unsuspend button on
        // this list needs to know the current state to render correctly;
        // it was never selected here.
        isSuspended: true,
        assignedLeads: { select: { status: true } },
        properties:    { select: { publishStatus: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where: { role: 'PARTNER', kycStatus: 'VERIFIED' } }),
  ]);

  const data = partners.map((p) => ({
    id: p.id, name: p.name, companyName: p.companyName, partnerSubType: p.partnerSubType,
    isSuspended: p.isSuspended,
    totalLeads:    p.assignedLeads.length,
    closedLeads:   p.assignedLeads.filter((l) => l.status === 'CLOSED').length,
    totalListings: p.properties.length,
    activeListings: p.properties.filter((l) => l.publishStatus === 'APPROVED').length,
  }));

  return { data, total };
}

// ─── USER DOCUMENT VAULT REVIEW ──────────────────────────────────────────────

async function adminListDocuments(filters, skip, limit) {
  const where = {};
  if (filters.userId) where.userId = filters.userId;
  if (filters.status) where.status = filters.status;
  if (filters.documentType) where.documentType = filters.documentType;

  // UserDocument.user is a required relation, but a row can still outlive
  // the user it points to (e.g. a since-deleted account) — Mongo has no FK
  // enforcement. include: { user } makes Prisma throw on the whole page the
  // moment one such row is in it ("Field user is required to return data,
  // got null instead"), not just that row — reported as GET
  // /admin/documents 500ing once an orphaned row aged into the default
  // page size. Loaded separately instead, so one dangling row degrades to
  // user: null on just that row, not a 500 for the whole list.
  const [docs, total] = await Promise.all([
    prisma.userDocument.findMany({ where, skip, take: limit, orderBy: { uploadedAt: 'desc' } }),
    prisma.userDocument.count({ where }),
  ]);
  const userIds = [...new Set(docs.map((d) => d.userId))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, phone: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, { name: u.name, email: u.email, phone: u.phone }]));
  const data = docs.map((d) => ({ ...d, user: byId.get(d.userId) ?? null }));
  return { data, total };
}

async function adminVerifyDocument(docId, action, note, adminId) {
  const doc = await prisma.userDocument.findUnique({ where: { id: docId } });
  if (!doc) throw new ApiError(404, 'Document not found');
  if (doc.status === 'APPROVED') throw new ApiError(409, 'Document is already approved');

  const isApprove = action === 'APPROVE';
  if (!isApprove && !note) throw new ApiError(400, 'Rejection note is required');

  return prisma.userDocument.update({
    where: { id: docId },
    data: {
      status:            isApprove ? 'APPROVED' : 'REJECTED',
      isVerified:        isApprove,
      verifiedAt:        isApprove ? new Date() : null,
      verifiedByAdminId: adminId,
      rejectionNote:     isApprove ? null : note,
    },
  });
}

// ─── ADMIN DETAIL VIEWS ───────────────────────────────────────────────────────

async function getPropertyByIdAdmin(propertyId) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      partner:  { select: { name: true, email: true, phone: true, companyName: true, partnerSubType: true } },
      editLogs: { orderBy: { editedAt: 'desc' }, take: 10 },
    },
  });
  if (!property) throw new ApiError(404, 'Property not found');
  return property;
}

async function getKycByUserId(userId) {
  const user = await prisma.user.findFirst({
    where: { id: userId, role: 'PARTNER' },
    select: {
      id: true, name: true, email: true, companyName: true, partnerSubType: true,
      kycStatus: true, kycDocumentUrls: true, kycRejectionNote: true, kycVerifiedAt: true,
      createdAt: true,
      // backend-work-still-open.md #12 — the admin screen shows what was
      // requested, and by when, while a document request is still open;
      // selected on the list (getPendingKyc) but never here on the detail.
      kycRequestedDocuments: true, kycRequestedNote: true, kycRequestedAt: true, kycRequestedDueAt: true,
      panNumber: true, panVerificationStatus: true, panVerifiedName: true, panVerifiedAt: true,
      gstin: true, gstinVerificationStatus: true, gstinVerifiedName: true, gstinVerifiedAt: true,
      reraNumber: true, reraVerificationStatus: true, reraVerifiedName: true, reraVerifiedAt: true,
    },
  });
  if (!user) throw new ApiError(404, 'Partner not found');
  return user;
}

// 5.x — admin can re-trigger the automated checks on demand (e.g. it
// wasn't configured at submission time, or the partner corrected a number
// afterward). Reuses the exact same logic submitKyc fires automatically.
async function reRunKycAutoVerification(userId, adminId, ip) {
  const result = await partnerService.runAutomatedKycChecks(userId);
  await createAuditLog({
    adminId, action: 'KYC_AUTO_VERIFICATION_RERUN', targetType: 'User', targetId: userId,
    after: result || { note: 'No PAN/GSTIN/RERA on file to check' }, ipAddress: ip,
  });
  return result;
}

async function getUserByIdAdmin(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, email: true, phone: true, phoneVerified: true, role: true,
      isNRI: true, partnerSubType: true, companyName: true, bio: true,
      profileImageUrl: true, websiteUrl: true,
      isPremiumPartner: true, premiumValidUntil: true,
      kycStatus: true, kycRejectionNote: true, kycVerifiedAt: true,
      isSuspended: true, deletedAt: true,
      reraNumber: true, gstin: true, panNumber: true, coverageAreas: true,
      partnerTermsVersion: true, partnerTermsAcceptedAt: true, kycConsentAt: true,
      createdAt: true, updatedAt: true,
    },
  });
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

// ─── CONTACT INBOX ────────────────────────────────────────────────────────────

async function listContactMessages(filters, skip, limit) {
  const where = {};
  if (filters.isRead !== undefined) where.isRead = filters.isRead === 'true';
  // 11.2 / 11.5 — inbox tabs and channel grouping.
  if (filters.status) where.status = filters.status;
  if (filters.source) where.source = filters.source;
  if (filters.search) where.OR = [
    { name:    { contains: filters.search, mode: 'insensitive' } },
    { email:   { contains: filters.search, mode: 'insensitive' } },
    { subject: { contains: filters.search, mode: 'insensitive' } },
  ];

  const [data, total, statusCounts] = await Promise.all([
    prisma.contactMessage.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { name: true, email: true, role: true } },
        // Reply count rather than the bodies — the list doesn't need them,
        // and the thread endpoint serves the full conversation.
        _count: { select: { replies: true } },
      },
    }),
    prisma.contactMessage.count({ where }),
    // Tab counts are deliberately NOT narrowed by the current status filter,
    // or every tab would read as its own total once one was selected.
    //
    // Explicit per-status counts rather than a groupBy: groupBy on an enum
    // throws outright ("non-enum-compatible value 'null'") for rows written
    // before the field existed, since Mongo doesn't apply @default
    // retroactively. Counts just don't match those rows, which is accurate
    // and can't take the endpoint down.
    Promise.all(CONTACT_STATUSES.map(async (st) => [st, await prisma.contactMessage.count({ where: { status: st } })])),
  ]);

  return {
    data: data.map(({ _count, ...m }) => ({ ...m, replyCount: _count.replies })),
    total,
    statusCounts: Object.fromEntries(statusCounts),
  };
}

async function markContactRead(id) {
  const msg = await prisma.contactMessage.findUnique({ where: { id } });
  if (!msg) throw new ApiError(404, 'Contact message not found');
  return prisma.contactMessage.update({ where: { id }, data: { isRead: true } });
}

// ─── NRI LEADS INBOX ────────────────────────────────────────────────────────

async function listNriLeads(filters, skip, limit) {
  const where = {};
  if (filters.isRead !== undefined) where.isRead = filters.isRead === 'true';

  const [data, total] = await Promise.all([
    prisma.nriLead.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.nriLead.count({ where }),
  ]);
  return { data, total };
}

async function markNriLeadRead(id) {
  const lead = await prisma.nriLead.findUnique({ where: { id } });
  if (!lead) throw new ApiError(404, 'NRI lead not found');
  return prisma.nriLead.update({ where: { id }, data: { isRead: true } });
}

// ─── TEAM MEMBER CRUD ─────────────────────────────────────────────────────────

async function adminListTeam() {
  return prisma.teamMember.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
}

async function adminCreateTeamMember(data) {
  return prisma.teamMember.create({ data });
}

async function adminUpdateTeamMember(id, data) {
  const member = await prisma.teamMember.findUnique({ where: { id } });
  if (!member) throw new ApiError(404, 'Team member not found');
  return prisma.teamMember.update({ where: { id }, data });
}

async function adminDeleteTeamMember(id) {
  const member = await prisma.teamMember.findUnique({ where: { id } });
  if (!member) throw new ApiError(404, 'Team member not found');
  return prisma.teamMember.delete({ where: { id } });
}

module.exports = {
  getLeadById, getAllLeads, assignLead, createLead, confirmLead, rejectLead, overrideLeadOtp,
  getPendingProperties, approveProperty, rejectProperty, editProperty,
  requestPropertyChanges,
  getPendingKyc, verifyKyc, requestKycDocuments, kycRequestEffectiveStatus, reRunKycAutoVerification,
  autoAssignLead, autoAssignUnassignedLeads,
  listRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule, dispatchTicketAutomatically,
  getRevenueSummary,
  getAuditLogs,
  getAllTickets, getTicketById, updateTicketStatus, getTicketStats,
  dispatchTicket, resolveTicket, linkTicketToDeal, getAdminTicketComments, addAdminTicketComment,
  getAllLoans, updateLoanStatus, getLoanBankStats,
  getAllUsers, changeUserRole, suspendUser,
  listStaff, createStaffMember, updateStaffPermissions, removeStaffMember,
  getPartnerMetrics, getPartnerById,
  adminListServices, adminCreateService, adminUpdateService, adminDeleteService,
  getPropertyByIdAdmin, getKycByUserId, getUserByIdAdmin,
  listContactMessages, markContactRead,
  listNriLeads, markNriLeadRead,
  adminListTeam, adminCreateTeamMember, adminUpdateTeamMember, adminDeleteTeamMember,
  adminListDocuments, adminVerifyDocument,
  listVideoTours, updateVideoTour, uploadVideoTourFile,
  adminListVendors, getVendorById, adminCreateVendor, adminUpdateVendor, adminDeleteVendor,
  addVendorAvailabilitySlot, listVendorAvailability, deleteVendorAvailabilitySlot,
  getAdminAnalytics,
};

// ─── VENDOR CATALOG ───────────────────────────────────────────────────────────

// 7.1 — rating and jobs count, aggregated from ServiceTicket now that
// dispatchTicket actually links a real vendorId (previously vendorName was
// free text, so there was nothing to aggregate against). "Availability
// "distance" needs a reference point — there's no single fixed "distance
// from where" for a vendor in the abstract, so it's only ever computed when
// the caller supplies one (nearLat/nearLng, or nearPropertyId to resolve a
// property's own coordinates), same nullable-when-no-reference pattern as
// everywhere else: null, not a guess, when there's nothing to compare.
async function withVendorStats(vendors, { nearLat, nearLng } = {}) {
  if (!vendors.length) return vendors;
  const vendorIds = vendors.map((v) => v.id);
  const [stats, slots] = await Promise.all([
    prisma.serviceTicket.groupBy({
      by: ['vendorId'],
      where: { vendorId: { in: vendorIds } },
      _count: { _all: true },
      _avg: { vendorRating: true },
    }),
    prisma.vendorAvailabilitySlot.findMany({
      where: { vendorId: { in: vendorIds } },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    }),
  ]);
  const statsByVendorId = new Map(stats.map((s) => [s.vendorId, s]));
  const slotsByVendorId = new Map();
  for (const slot of slots) {
    if (!slotsByVendorId.has(slot.vendorId)) slotsByVendorId.set(slot.vendorId, []);
    slotsByVendorId.get(slot.vendorId).push(slot);
  }

  const hasReference = nearLat != null && nearLng != null;
  return vendors.map((v) => {
    const s = statsByVendorId.get(v.id);
    return {
      ...v,
      jobsCount: s?._count._all ?? 0,
      rating: s?._avg.vendorRating != null ? Math.round(s._avg.vendorRating * 10) / 10 : null,
      availableSlots: slotsByVendorId.get(v.id) ?? [],
      distanceMetres: hasReference
        ? distanceMetres({ latitude: v.latitude, longitude: v.longitude }, { latitude: nearLat, longitude: nearLng })
        : null,
    };
  });
}

// `near` resolves a reference point either directly (nearLat/nearLng) or
// via a property's own coordinates (nearPropertyId) — the common case is
// "which vendors are close to THIS ticket's property", not an arbitrary
// lat/lng admin happens to have on hand.
async function resolveNearPoint(filters) {
  if (filters.nearLat != null && filters.nearLng != null) {
    return { nearLat: Number(filters.nearLat), nearLng: Number(filters.nearLng) };
  }
  if (filters.nearPropertyId) {
    const property = await prisma.property.findUnique({
      where: { id: filters.nearPropertyId }, select: { latitude: true, longitude: true },
    });
    if (property?.latitude != null && property?.longitude != null) {
      return { nearLat: property.latitude, nearLng: property.longitude };
    }
  }
  return {};
}

async function adminListVendors(filters, skip, limit) {
  const where = {};
  if (filters.category) where.category = filters.category;
  if (filters.city)     where.city     = filters.city;
  if (filters.isActive !== undefined) where.isActive = filters.isActive !== 'false';

  const [rows, total, near] = await Promise.all([
    prisma.vendor.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }),
    prisma.vendor.count({ where }),
    resolveNearPoint(filters),
  ]);
  return { data: await withVendorStats(rows, near), total };
}

async function getVendorById(id, filters = {}) {
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) throw new ApiError(404, 'Vendor not found');
  const near = await resolveNearPoint(filters);
  const [withStats] = await withVendorStats([vendor], near);
  return withStats;
}

async function adminCreateVendor(data) {
  return prisma.vendor.create({ data });
}

async function adminUpdateVendor(id, data) {
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) throw new ApiError(404, 'Vendor not found');
  return prisma.vendor.update({ where: { id }, data });
}

async function adminDeleteVendor(id) {
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) throw new ApiError(404, 'Vendor not found');
  return prisma.vendor.update({ where: { id }, data: { isActive: false } });
}

// 7.1 — recurring weekly availability. No overlap check: a vendor plausibly
// has split hours in a day (e.g. 09:00-13:00 and 15:00-19:00), so two slots
// on the same day is normal, not a duplicate.
async function addVendorAvailabilitySlot(vendorId, data) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new ApiError(404, 'Vendor not found');
  return prisma.vendorAvailabilitySlot.create({ data: { ...data, vendorId } });
}

async function listVendorAvailability(vendorId) {
  return prisma.vendorAvailabilitySlot.findMany({
    where: { vendorId }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  });
}

async function deleteVendorAvailabilitySlot(vendorId, slotId) {
  const slot = await prisma.vendorAvailabilitySlot.findFirst({ where: { id: slotId, vendorId } });
  if (!slot) throw new ApiError(404, 'Availability slot not found for this vendor');
  await prisma.vendorAvailabilitySlot.delete({ where: { id: slotId } });
}

// ─── PLATFORM ANALYTICS ───────────────────────────────────────────────────────

async function getAdminAnalytics() {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [
    leadFunnel,
    propertyFunnel,
    userGrowth,
    revenueMonthly,
    totalUsers,
    totalPartners,
    totalProperties,
  ] = await Promise.all([
    // Lead pipeline funnel
    prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),

    // Property approval funnel
    prisma.property.groupBy({ by: ['publishStatus'], _count: { _all: true } }),

    // User signups per month (last 6 months)
    prisma.user.findMany({
      where: { createdAt: { gte: sixMonthsAgo } },
      select: { createdAt: true, role: true },
    }),

    // Service revenue per month (last 6 months)
    prisma.userSubscription.findMany({
      where: { paymentStatus: 'SUCCESS', startDate: { gte: sixMonthsAgo } },
      select: { startDate: true, amountPaid: true },
    }),

    prisma.user.count({ where: { role: 'USER' } }),
    prisma.user.count({ where: { role: 'PARTNER' } }),
    prisma.property.count({ where: { publishStatus: 'APPROVED' } }),
  ]);

  // Build monthly buckets (last 6 months)
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  const growthByMonth = Object.fromEntries(months.map((m) => [m, { users: 0, partners: 0 }]));
  userGrowth.forEach(({ createdAt, role }) => {
    const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, '0')}`;
    if (growthByMonth[key]) {
      if (role === 'USER')    growthByMonth[key].users++;
      if (role === 'PARTNER') growthByMonth[key].partners++;
    }
  });

  const revenueByMonth = Object.fromEntries(months.map((m) => [m, 0]));
  revenueMonthly.forEach(({ startDate, amountPaid }) => {
    const key = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;
    if (revenueByMonth[key] !== undefined) revenueByMonth[key] += amountPaid;
  });

  return {
    totals: { users: totalUsers, partners: totalPartners, activeListings: totalProperties },
    leadFunnel: Object.fromEntries(leadFunnel.map((r) => [r.status, r._count._all])),
    propertyFunnel: Object.fromEntries(propertyFunnel.map((r) => [r.publishStatus, r._count._all])),
    userGrowth: months.map((m) => ({ month: m, ...growthByMonth[m] })),
    revenueByMonth: months.map((m) => ({ month: m, revenue: revenueByMonth[m] })),
  };
}

// ─── VIDEO TOUR MANAGEMENT ────────────────────────────────────────────────────

async function listVideoTours(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.assignedTo) where.assignedTo = filters.assignedTo;

  const [data, total] = await prisma.$transaction([
    prisma.videoTourRequest.findMany({
      where, skip, take: limit,
      include: {
        user:     { select: { id: true, name: true, email: true, phone: true, isNRI: true } },
        property: { select: { id: true, title: true, slug: true, city: true, images: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.videoTourRequest.count({ where }),
  ]);
  return { data, total };
}

async function uploadVideoTourFile(id, fileUrl) {
  const tour = await prisma.videoTourRequest.findUnique({ where: { id } });
  if (!tour) throw new ApiError(404, 'Video tour request not found');

  return prisma.videoTourRequest.update({
    where: { id },
    data: { videoUrl: fileUrl, status: 'COMPLETED', completedAt: new Date() },
  });
}

async function updateVideoTour(id, { assignedTo, videoUrl, scheduledAt, adminNote, status }) {
  const tour = await prisma.videoTourRequest.findUnique({ where: { id } });
  if (!tour) throw new ApiError(404, 'Video tour request not found');

  const data = {};
  if (assignedTo !== undefined) { data.assignedTo = assignedTo; data.status = 'ASSIGNED'; }
  if (videoUrl    !== undefined) { data.videoUrl   = videoUrl;   data.status = 'COMPLETED'; data.completedAt = new Date(); }
  if (scheduledAt !== undefined) data.scheduledAt = new Date(scheduledAt);
  if (adminNote   !== undefined) data.adminNote   = adminNote;
  if (status      !== undefined) data.status      = status;

  return prisma.videoTourRequest.update({ where: { id }, data });
}
