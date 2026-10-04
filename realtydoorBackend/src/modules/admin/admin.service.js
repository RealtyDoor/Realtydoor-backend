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
  if (!lead.buyer) return { ...lead, ...stalled };
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
      source: data.source,
      addedByAdminId: adminId,
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

  return lead;
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
  if (lead.assignedPartnerId) throw new ApiError(409, 'Lead is already assigned to a partner');
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

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: { assignedPartnerId: partnerId, status: 'ASSIGNED', assignedAt: new Date() },
  });

  await createNotification({
    userId: partnerId,
    title: 'New Lead Assigned',
    message: `A new buyer lead has been assigned to you.`,
    type: 'LEAD_ASSIGNED',
    linkUrl: `/partner/leads/${leadId}`,
  });

  await createAuditLog({
    adminId, action: 'LEAD_ASSIGNED', targetType: 'Lead', targetId: leadId,
    before: { status: lead.status }, after: { status: 'ASSIGNED', assignedPartnerId: partnerId },
    ipAddress: ip,
  });

  // Partner: WhatsApp + email
  sendLeadAssignedNotice(partner.phone, partner.name).catch(() => {});
  sendLeadAssigned(partner.email, { buyerName: lead.buyerName, propertyTitle: lead.property.title }).catch(() => {});

  // Buyer: in-app notification (if registered) + email. Never the partner's
  // phone — "Contact agent" always dials the shared telecaller number
  // instead (platform config key telecaller_phone); the buyer only gets the
  // partner's identity (name/company), not a way to reach them directly.
  if (lead.buyerId) {
    await createNotification({
      userId: lead.buyerId,
      title: 'Your Inquiry is Being Processed',
      message: `Your inquiry ${lead.refCode} for "${lead.property.title}" has been assigned to ${partner.companyName || partner.name}. Use Contact agent to reach our team.`,
      type: 'LEAD_ASSIGNED',
      linkUrl: `/user/inquiries/${leadId}`,
    });
  }
  sendLeadInquiryConfirmed(lead.buyerEmail, lead.property.title).catch(() => {});

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

// Ranks eligible partners for one lead, most-preferred first. Returns an
// empty array rather than throwing — "no eligible partner" is a normal
// outcome for a locality nobody covers yet, not an error.
//
// Three eligibility layers, each narrowing the pool but never to zero when
// the wider pool is non-empty: an exact locality match in leadPreferredLocalities
// is preferred over coverageAreas, which is preferred over no locality signal
// at all, so a lead in an uncovered area is still assignable to SOMEONE rather
// than silently unassignable.
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
    return withLoad;
  }
  return [];
}

// Tries ranked candidates in order until one is actually assignable — a
// candidate can still fail assignLead's own gates (most likely R34) even
// after passing the eligibility filter above, and that failure should fall
// through to the next candidate rather than failing the whole pick.
async function autoAssignLead(leadId, adminId, ip) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { property: { select: { locality: true, city: true } } },
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

  const updated = await prisma.loanApplication.update({
    where: { id: loanId },
    data: { status, adminNote: adminNote || loan.adminNote, ...statusFields, ...extraFields },
  });

  await createNotification({
    userId:  loan.userId,
    title:   'Loan Application Update',
    message: `Your loan application status has been updated to ${status.replace(/_/g, ' ')}.`,
    type:    'LOAN_STATUS_UPDATE',
    linkUrl: `/dashboard/loan/${loanId}`,
  });

  sendLoanStatusUpdate(loan.user.email, status, adminNote).catch(() => {});

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

// ─── TICKET MANAGEMENT ───────────────────────────────────────────────────────

async function getTicketById(ticketId) {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: {
      user:         { select: { id: true, name: true, email: true, phone: true } },
      subscription: { include: { service: { select: { name: true, category: true } } } },
      comments:     { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  return ticket;
}

async function getAllTickets(filters, skip, limit) {
  const where = {};
  if (filters.status)   where.status   = filters.status;
  if (filters.userId)   where.userId   = filters.userId;
  if (filters.category) where.category = filters.category;
  if (filters.search) where.OR = [
    { subject:     { contains: filters.search, mode: 'insensitive' } },
    { description: { contains: filters.search, mode: 'insensitive' } },
    { vendorName:  { contains: filters.search, mode: 'insensitive' } },
  ];

  const [data, total] = await Promise.all([
    prisma.serviceTicket.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user:         { select: { name: true, email: true, phone: true } },
        subscription: { include: { service: { select: { name: true } } } },
      },
    }),
    prisma.serviceTicket.count({ where }),
  ]);
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

  const tickets = await prisma.serviceTicket.findMany({
    select: { status: true, vendorName: true, createdAt: true, resolvedAt: true },
  });

  const unassigned = tickets.filter((t) => !t.vendorName).length;
  const inProgress = tickets.filter((t) => t.status === 'IN_PROGRESS').length;
  const resolvedThisWeek = tickets.filter((t) => t.resolvedAt && t.resolvedAt >= startOfWeek).length;
  const resolved = tickets.filter((t) => t.resolvedAt);
  const avgResolutionDays = resolved.length
    ? resolved.reduce((sum, t) => sum + (t.resolvedAt - t.createdAt) / 86_400_000, 0) / resolved.length
    : 0;

  return {
    unassigned,
    inProgress,
    resolvedThisWeek,
    avgResolutionDays: Math.round(avgResolutionDays * 10) / 10,
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

// Account number and PAN are masked before returning — an admin partner page
// doesn't need the full values, and this payload is easy to copy out.
function maskPartnerPayout(p) {
  if (!p) return p;
  const tail = (v, keep = 4) => (v ? `${'X'.repeat(Math.max(0, String(v).length - keep))}${String(v).slice(-keep)}` : v);
  return { ...p, bankAccountNo: tail(p.bankAccountNo), panNumber: tail(p.panNumber) };
}

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
    ...maskPartnerPayout(partner),
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
        assignedLeads: { select: { status: true } },
        properties:    { select: { publishStatus: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where: { role: 'PARTNER', kycStatus: 'VERIFIED' } }),
  ]);

  const data = partners.map((p) => ({
    id: p.id, name: p.name, companyName: p.companyName, partnerSubType: p.partnerSubType,
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

  const [data, total] = await Promise.all([
    prisma.userDocument.findMany({
      where, skip, take: limit,
      orderBy: { uploadedAt: 'desc' },
      include: { user: { select: { name: true, email: true, phone: true } } },
    }),
    prisma.userDocument.count({ where }),
  ]);
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
    },
  });
  if (!user) throw new ApiError(404, 'Partner not found');
  return user;
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
  getPendingKyc, verifyKyc, requestKycDocuments, kycRequestEffectiveStatus,
  autoAssignLead, autoAssignUnassignedLeads,
  getRevenueSummary,
  getAuditLogs,
  getAllTickets, getTicketById, updateTicketStatus, getTicketStats,
  getAllLoans, updateLoanStatus, getLoanBankStats,
  getAllUsers, changeUserRole, suspendUser,
  getPartnerMetrics, getPartnerById,
  adminListServices, adminCreateService, adminUpdateService, adminDeleteService,
  getPropertyByIdAdmin, getKycByUserId, getUserByIdAdmin,
  listContactMessages, markContactRead,
  listNriLeads, markNriLeadRead,
  adminListTeam, adminCreateTeamMember, adminUpdateTeamMember, adminDeleteTeamMember,
  adminListDocuments, adminVerifyDocument,
  listVideoTours, updateVideoTour, uploadVideoTourFile,
  adminListVendors, adminCreateVendor, adminUpdateVendor, adminDeleteVendor,
  getAdminAnalytics,
};

// ─── VENDOR CATALOG ───────────────────────────────────────────────────────────

async function adminListVendors(filters, skip, limit) {
  const where = {};
  if (filters.category) where.category = filters.category;
  if (filters.city)     where.city     = filters.city;
  if (filters.isActive !== undefined) where.isActive = filters.isActive !== 'false';

  const [data, total] = await Promise.all([
    prisma.vendor.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }),
    prisma.vendor.count({ where }),
  ]);
  return { data, total };
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
