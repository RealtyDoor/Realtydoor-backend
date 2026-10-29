const prisma = require('../../lib/prisma');
const { canonicalizeCity } = require('../../lib/cityAlias');
const ApiError = require('../../utils/ApiError');
const { createNotification, markNotificationsRead } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const {
  sendPropertyApproved, sendPropertyRejected,
  sendKycVerified, sendKycRejected,
  sendLeadAssigned, sendLeadInquiryConfirmed,
  sendLoanStatusUpdate,
  sendTicketUpdate, sendVideoTourUpdate,
} = require('../../lib/email');
const { sendLeadAssignedNotice, sendSiteVisitOtp, sendTicketVendorDispatched, notifyUser } = require('../../lib/wati');
const { setUserRole } = require('../../lib/clerkAdmin');
const { ROLES } = require('../../utils/validators');
const { normalizePhone } = require('../../lib/phoneUtils');
const { nextRefCode } = require('../../lib/refCode');
const { stalledInfoFor, evaluateBuyerOwnership } = require('../leads/leads.service');
const { OWNERSHIP_TEXT } = require('../../lib/leadOwnership');
const { CONTACT_STATUSES } = require('../contact/contact.admin.validator');
const { generate, expiresAt } = require('../../lib/otp');
const logger = require('../../lib/logger');
const { cacheDel, cacheDelPattern } = require('../../lib/cache');
const dataAckService = require('../partners/dataAck.service');
const { attachLoanDocuments } = require('../../lib/loanEligibility');
const { canLinkLeadToUser } = require('../../lib/leadClaim');
const { countInquiriesByUser, inquiryWhereForUser } = require('../../lib/inquiryCounts');
const { averageResolutionDays } = require('../../lib/ticketStats');
const { isLoanTransitionAllowed, hasVerifiedDocument } = require('../../lib/loanTransitions');
const { assertLeadNotPaused } = require('../../lib/accountDeletion');
const partnerService = require('../partners/partners.service');
const { kycApprovalBlocker } = require('../../lib/kycApproval');
const { buildTicketChargeReceiptPdf } = require('../../lib/pdfReceipt');
const { s3Upload } = require('../../lib/fileUpload');
const { getConfigNumber } = require('../config/config.service');
const { csvCell } = require('../money/ledger.service');
const { distanceMetres } = require('../../lib/mapLink');
const { invalidateCacheForPropertyStatusChange: invalidateMicrositeCache } = require('../microsites/microsite.service');
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

  // The partner-added review queue shows, per lead, whether the partner would be credited (one mobile number is one buyer).
  const rows = await Promise.all(data.map(async (lead) => {
    const row = flattenBuyerInquiryCount(lead);
    if (lead.status !== 'AWAITING_ADMIN' || !lead.addedByPartnerId) return row;
    const ownership = await evaluateBuyerOwnership(lead.buyerPhone, lead.addedByPartnerId, { excludeLeadId: lead.id, before: lead.createdAt });
    return { ...row, ownership: { ...ownership, note: OWNERSHIP_TEXT[ownership.reason] } };
  }));

  return { data: rows, total };
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

  // B12 — a partner-added lead stays with the partner who brought the buyer
  // (the Confirm dialog and the partner's own form both say so). With no
  // explicit partner chosen, assign it to the adding partner instead of
  // dropping it into UNASSIGNED, where it vanished from their list.
  // One mobile number is one buyer: a partner is credited only for a buyer the platform did not already have, or one that
  // partner registered earlier and is still valid. An explicit partner choice by the admin always stands.
  const ownership = lead.addedByPartnerId
    ? await evaluateBuyerOwnership(lead.buyerPhone, lead.addedByPartnerId, { excludeLeadId: leadId, before: lead.createdAt })
    : null;
  const creditAdder = !ownership || ownership.credited;
  const targetPartnerId = partnerId || (creditAdder ? lead.addedByPartnerId : null) || null;
  let partner = null;
  if (targetPartnerId) {
    partner = await prisma.user.findFirst({
      where: { id: targetPartnerId, role: 'PARTNER', kycStatus: 'VERIFIED' },
      select: { id: true },
    });
    if (!partner && partnerId) throw new ApiError(400, 'Partner not found or not KYC verified');
  }

  // B21 — if a verified buyer account owns this phone number, link the lead to
  // it now (the admin has just reviewed it), so it shows up in their inquiries
  // and the escrow token can be paid. Otherwise it stays unlinked and the buyer
  // can claim it from the app (GET /user/leads/claimable).
  const buyerAccount = !lead.buyerId && lead.buyerPhone
    ? await prisma.user.findFirst({
        where: { phone: lead.buyerPhone, role: 'USER', phoneVerified: true, deletedAt: { isSet: false }, isSuspended: false },
        select: { id: true, role: true, phone: true, phoneVerified: true, deletedAt: true, isSuspended: true },
      })
    : null;
  const linkBuyer = buyerAccount && canLinkLeadToUser({ ...lead, status: 'ASSIGNED' }, buyerAccount) ? buyerAccount : null;

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      ...(partner
        ? { assignedPartnerId: partner.id, status: 'ASSIGNED', assignedAt: new Date() }
        : { status: 'UNASSIGNED' }),
      ...(linkBuyer && { buyerId: linkBuyer.id }),
    },
  });

  if (linkBuyer) {
    await createNotification({
      userId: linkBuyer.id,
      title: 'An inquiry was added for you',
      message: `${lead.refCode} for "${lead.property?.title || lead.propertyInterest || 'a property'}" was added by a RealtyDoor partner using your phone number. You can follow it, and pay the token if you wish to proceed, from your inquiries.`,
      type: 'LEAD_ASSIGNED',
      linkUrl: `/user/inquiries/${leadId}`,
    }).catch(() => null);
  }

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
      message: creditAdder
        ? `${lead.refCode} · ${lead.buyerName} has been confirmed and is now in the assignment queue.`
        : `${lead.refCode} · ${lead.buyerName} is in the assignment queue. ${OWNERSHIP_TEXT[ownership.reason]}`,
      type: 'LEAD_ASSIGNED',
      linkUrl: `/partners/leads/${leadId}`,
    });
  }

  // B16 — "Partner-added lead needs review" stayed unread after the review.
  await markNotificationsRead({ linkUrl: `/admin/leads/${leadId}`, types: ['LEAD_NEW'] });

  await createAuditLog({
    adminId, action: 'LEAD_CONFIRMED', targetType: 'Lead', targetId: leadId,
    before: { status: lead.status },
    after: { status: updated.status, assignedPartnerId: updated.assignedPartnerId, ...(ownership && { buyerOwnership: ownership.reason }) },
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
    include: { property: { select: { title: true, partnerId: true } } },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  // BUG-039: the listing's owner cannot earn commission on their own listing, so a lead for it must not be assigned to them
  // (it used to be accepted here and only fail at release).
  if (lead.property?.partnerId && String(lead.property.partnerId) === String(partnerId)) {
    throw new ApiError(400, 'This partner owns the listing, so they cannot be assigned its lead (they cannot earn commission on their own listing). Choose another partner.', { code: 'PARTNER_OWNS_LISTING' });
  }
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
  await assertLeadNotPaused(lead.buyerId);

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
      linkUrl: `/partners/leads`,
    });
  }

  await createNotification({
    userId: partnerId,
    title: isReassign ? 'Lead Reassigned To You' : 'New Lead Assigned',
    // B5 — name the lead so the partner can tell which one without opening it.
    message: `${isReassign ? 'Lead reassigned to you' : 'New buyer lead assigned to you'}: ${lead.refCode || 'a buyer lead'}${lead.buyerName ? ` (${lead.buyerName})` : ''}.`,
    type: 'LEAD_ASSIGNED',
    linkUrl: `/partners/leads/${leadId}`,
  });

  // B16 — "New Unassigned Lead" entries persisted for leads that were assigned.
  await markNotificationsRead({ linkUrl: `/admin/leads/${leadId}`, types: ['LEAD_NEW'] });

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
  sendLeadAssignedNotice(partner.phone, partner.name, {}, partner).catch(() => {});
  sendLeadAssigned(partner.email, { buyerName: lead.buyerName, propertyTitle: propertyLabel }, partner).catch(() => {});

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
  // T37 — optional text search so a list capped at 50 per page can still reach
  // every listing (the microsites page uses it).
  const q = typeof filters.search === 'string' ? filters.search.trim().slice(0, 100) : '';
  if (q) {
    where.OR = ['title', 'locality', 'city'].map((f) => ({ [f]: { contains: q, mode: 'insensitive' } }));
  }

  const [rows, total] = await Promise.all([
    prisma.property.findMany({ where, skip, take: limit, orderBy: { createdAt: 'asc' } }),
    prisma.property.count({ where }),
  ]);

  // Fixed 2026-10-12 — partner fetched separately, not via `include`, which
  // throws for the WHOLE queue the moment any single row's partner can't
  // resolve. Confirmed live: several PENDING_APPROVAL properties currently
  // have a partnerId pointing at a hard-deleted partner — this was 500ing
  // the admin's entire pending-approval queue, not just those rows.
  const partnerIds = [...new Set(rows.map((p) => p.partnerId))];
  const partnersById = new Map((await prisma.user.findMany({
    where: { id: { in: partnerIds } }, select: { id: true, name: true, email: true, companyName: true },
  })).map((p) => [p.id, p]));
  const data = rows.map((p) => ({ ...p, partner: partnersById.get(p.partnerId) || null }));

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
// Fixed 2026-10-12 — shared by approveProperty/rejectProperty/
// requestPropertyChanges below, all of which need property.partner for the
// email notification. Fetched separately, not via `include`, for the same
// reason as getPendingProperties above — a hard-deleted partner must
// degrade that one property to `partner: null`, not throw.
async function fetchPropertyWithPartner(propertyId) {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property) return null;
  property.partner = await prisma.user.findUnique({
    where: { id: property.partnerId }, select: { email: true, notifEmail: true },
  });
  return property;
}

async function approveProperty(propertyId, adminId, ip, visibility = {}) {
  const property = await fetchPropertyWithPartner(propertyId);
  if (!property) throw new ApiError(404, 'Property not found');
  // B50 — the approval gate was empty: ~35 live listings had no photos at all.
  // Photos are the minimum bar; RERA stays advisory (plots/older stock may not
  // have one, and the public page only claims "RERA Verified" when isVerified).
  if (!property.images?.length) {
    throw new ApiError(400, 'Cannot approve a listing with no photos', { code: 'LISTING_NO_PHOTOS' });
  }

  // A partner can list in a locality we have no details for yet (it was added from the listing form). Such a listing waits until
  // an admin has filled the locality in or corrected its name, so the public page never shows a place with no market data.
  const pendingLocality = await prisma.localitySuggestion.findFirst({
    where: { status: 'PENDING', key: `${canonicalizeCity(property.city).trim().toLowerCase()}|${String(property.locality).trim().toLowerCase()}` },
    select: { id: true, city: true, locality: true },
  });
  if (pendingLocality) {
    throw new ApiError(409, `${pendingLocality.locality}, ${pendingLocality.city} is a new locality with no details yet. Fill it in, or correct its name, under CMS > Locality insights, then approve this listing.`, {
      code: 'LOCALITY_NOT_SET_UP', city: pendingLocality.city, locality: pendingLocality.locality, suggestionId: pendingLocality.id,
    });
  }

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
    // The partner's own page, not the public one: the public page 404s if the listing is later rejected or hidden.
    linkUrl: `/partners/listings/${propertyId}`,
  });
  notifyUser(property.partnerId, 'listing_approved', { partner_name: '$userName', property_title: property.title });

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

  if (property.partner) sendPropertyApproved(property.partner.email, property.title, property.partner).catch(() => {});
  cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
  cacheDel(CACHE_KEYS.localityPage(property.city, property.locality));
  invalidateMicrositeCache(propertyId).catch(() => {});
  return updated;
}

async function rejectProperty(propertyId, note, adminId, ip) {
  const property = await fetchPropertyWithPartner(propertyId);
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
    linkUrl: `/partners/listings/${propertyId}`,
  });

  await createAuditLog({
    adminId, action: 'PROPERTY_REJECTED', targetType: 'Property', targetId: propertyId,
    after: { publishStatus: 'REJECTED', note },
    ipAddress: ip,
  });

  if (property.partner) sendPropertyRejected(property.partner.email, property.title, note, property.partner).catch(() => {});
  notifyUser(property.partnerId, 'listing_rejected', { partner_name: '$userName', property_title: property.title, reason: note || 'Please check the app for details' });
  cacheDel(CACHE_KEYS.FEATURED_PROPERTIES, CACHE_KEYS.CITIES_SUMMARY);
  cacheDel(CACHE_KEYS.localityPage(property.city, property.locality));
  invalidateMicrositeCache(propertyId).catch(() => {});
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
  const property = await fetchPropertyWithPartner(propertyId);
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
    linkUrl: `/partners/listings/${propertyId}`,
  });
  notifyUser(property.partnerId, 'listing_changes_requested', {
    partner_name: '$userName', property_title: property.title,
    reason: (note || `${items.length} fix(es) requested`).slice(0, 200),
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
  if (property.partner) sendPropertyRejected(
    property.partner.email,
    property.title,
    `${note ? note + ' ' : ''}Requested fixes: ${items.join('; ')}`,
    property.partner,
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
    linkUrl: '/partners/profile',
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

  // B53 — partners were being marked VERIFIED with zero documents on file.
  // The PAN number is checked here too: without one the commission is taxed at the higher no-PAN rate.
  const blocker = action === 'APPROVE' ? kycApprovalBlocker(user) : null;
  if (blocker) throw new ApiError(400, blocker.message, { code: blocker.code });

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
    linkUrl: '/partners/profile',
  });

  await createAuditLog({
    adminId, action: `KYC_${action}`, targetType: 'User', targetId: userId,
    after: { kycStatus }, ipAddress: ip,
  });

  if (action === 'APPROVE') {
    sendKycVerified(user.email, user).catch(() => {});
    // WhatsApp copy of the same news; stays silent until `kyc_approved` is live in WATI (see wati-templates/16).
    notifyUser(userId, 'kyc_approved', { partner_name: '$userName' });
    // M5/BE-23 followup — promote a payout account that was only ever
    // held back by KYC (see partners.service.js's createPayoutAccount),
    // instead of leaving it PENDING_VALIDATION until an admin separately
    // remembers to flip it by hand.
    partnerService.promotePayoutAccountOnKycApproval(userId).catch((err) =>
      logger.warn('[verifyKyc] Failed to auto-promote payout account', { userId, error: err.message })
    );
  } else {
    sendKycRejected(user.email, note, user).catch(() => {});
    // Stays silent until `kyc_rejected` is live in WATI (see wati-templates/17).
    notifyUser(userId, 'kyc_rejected', { partner_name: '$userName', reason: note || 'Please check the app for details' });
  }

  return updated;
}

// ─── REVENUE DASHBOARD ───────────────────────────────────────────────────────

async function getRevenueSummary() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [escrowHeld, escrowReleased, escrowPlatformFee, servicesRevenue, closedLeads, totalLeads] = await Promise.all([
    prisma.escrowTransaction.aggregate({ where: { status: 'HELD' }, _sum: { amount: true }, _count: true }),
    prisma.escrowTransaction.aggregate({
      where: { status: 'RELEASED', releasedAt: { gte: startOfMonth } },
      _sum: { amount: true }, _count: true,
    }),
    // BE-17 — the platform fee actually RETAINED on releases this month,
    // from platformFeePaise (stamped on the row at release() time, see
    // BE-9/BE-17 schema), not re-derived from the CURRENT
    // escrow_platform_fee_pct config — a rate change mid-month must never
    // alter what an already-released row is counted as having kept.
    prisma.escrowTransaction.aggregate({
      where: { status: 'RELEASED', releasedAt: { gte: startOfMonth } },
      _sum: { platformFeePaise: true }, _count: true,
    }),
    prisma.userSubscription.aggregate({
      where: { paymentStatus: 'SUCCESS', startDate: { gte: startOfMonth } },
      _sum: { amountPaid: true }, _count: true,
    }),
    // closedAt, with updatedAt for deals closed before closedAt existed (T16).
    prisma.lead.count({ where: { status: 'CLOSED', OR: [{ closedAt: { gte: startOfMonth } }, { closedAt: { isSet: false }, updatedAt: { gte: startOfMonth } }] } }),
    prisma.lead.count(),
  ]);

  return {
    escrowHeld:        { amount: escrowHeld._sum.amount || 0,         count: escrowHeld._count },
    escrowReleasedMTD: { amount: escrowReleased._sum.amount || 0,      count: escrowReleased._count },
    // Paise-summed, then converted to rupees for the response — older rows
    // released before BE-9/BE-17 shipped have no platformFeePaise, so this
    // undercounts them specifically (that's a known gap: the audit doc
    // mentions backfilling from the audit log's after.platformFee where
    // available, which is a separate one-off migration, not done here).
    escrowPlatformFeeMTD: { amount: round2((escrowPlatformFee._sum.platformFeePaise || 0) / 100), count: escrowPlatformFee._count },
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
  // Same spelling rules as a partner edit: one canonical city name.
  if (data.city) data.city = canonicalizeCity(data.city);
  // verifiedAt follows the verified switch: stamped when it turns on, cleared when it turns off.
  if (data.isVerified === true && !property.isVerified) data.verifiedAt = new Date();
  if (data.isVerified === false && property.isVerified) data.verifiedAt = null;

  // Lists and dates compare by value; String() on an array or a Date made every untouched one look changed.
  const norm = (v) => (v instanceof Date ? v.toISOString() : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const sameValue = (a, b) => {
    if (typeof a === 'string' && typeof b === 'object' && b instanceof Date) return new Date(a).getTime() === b.getTime();
    if (a instanceof Date && typeof b === 'string') return a.getTime() === new Date(b).getTime();
    return norm(a) === norm(b);
  };

  const editLogRows = Object.entries(data)
    .filter(([field, newVal]) => field !== 'verifiedAt' && !sameValue(property[field], newVal))
    .map(([field, newVal]) => ({
      propertyId,
      editedBy:     adminId,
      editedByName: adminName,
      fieldChanged: field,
      oldValue:     property[field] != null ? JSON.stringify(property[field]) : null,
      newValue:     newVal     != null ? JSON.stringify(newVal)              : null,
    }));

  // A changed map link carries its parsed coordinates with it (same helper listing creation and the location edit use).
  const { withMapLinkCoords } = require('../listings/location.service');
  const [updated] = await prisma.$transaction([
    prisma.property.update({ where: { id: propertyId }, data: withMapLinkCoords(data) }),
    ...editLogRows.map((row) => prisma.propertyEditLog.create({ data: row })),
  ]);

  if (editLogRows.length > 0) {
    await createNotification({
      userId:  property.partnerId,
      title:   'Your listing was edited by Admin',
      message: `Admin updated ${editLogRows.length} field(s) on "${property.title}". Changes are visible on your listing.`,
      type:    'PROPERTY_EDITED_BY_ADMIN',
      linkUrl: `/partners/listings/${propertyId}`,
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

  const [rows, total] = await Promise.all([
    prisma.loanApplication.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.loanApplication.count({ where }),
  ]);

  // Backend gaps handoff, 2026-10-10 (#6) — the list view only needs enough
  // to show a document count/chip, not full objects (that's what
  // GET /admin/loan/:id below is for) — kept light since this list can be
  // large. userId is already present on every row (a plain scalar).
  //
  // Fixed 2026-10-12 — user/property are fetched separately rather than via
  // Prisma `include`, which throws "Inconsistent query result" for the
  // whole list the moment ONE row's required `user` relation can't resolve
  // (found live: a LoanApplication whose userId pointed at a hard-deleted
  // User, predating the soft-delete-only convention this codebase relies on
  // everywhere else — see User.deletedAt's own comment on exactly this
  // class of bug for Property/Notification/PartnerSupportTicket). A single
  // bad row degrading that one row's `user` to `null` beats a 500 for the
  // entire admin loan list.
  const userIds = [...new Set(rows.map((l) => l.userId))];
  const propertyIds = [...new Set(rows.map((l) => l.propertyId).filter(Boolean))];
  const docIds = [...new Set(rows.flatMap((l) => l.submittedDocIds || []))];

  const leadIds = [...new Set(rows.map((l) => l.leadId).filter(Boolean))];
  const [users, properties, docs, inquiries] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, phone: true } }),
    propertyIds.length
      ? prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { id: true, title: true, slug: true, city: true, locality: true, propertyType: true, listingType: true, price: true } })
      : [],
    docIds.length
      ? prisma.userDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, documentType: true, status: true } })
      : [],
    leadIds.length
      ? prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, refCode: true, status: true } })
      : [],
  ]);
  const inquiriesById = new Map(inquiries.map((l) => [l.id, { id: l.id, refCode: l.refCode, status: l.status }]));
  const usersById = new Map(users.map((u) => [u.id, u]));
  const propertiesById = new Map(properties.map((p) => [p.id, p]));
  const docsById = new Map(docs.map((d) => [d.id, d]));

  const data = rows.map((loan) => ({
    ...loan,
    user: usersById.get(loan.userId) || null,
    property: loan.propertyId ? (propertiesById.get(loan.propertyId) || null) : null,
    inquiry: loan.leadId ? (inquiriesById.get(loan.leadId) || null) : null,
    documents: (loan.submittedDocIds || []).map((id) => docsById.get(id)).filter(Boolean),
    documentCount: (loan.submittedDocIds || []).length,
  }));

  return { data, total };
}

async function getLoanById(loanId) {
  const loan = await prisma.loanApplication.findUnique({ where: { id: loanId } });
  if (!loan) throw new ApiError(404, 'Loan application not found');

  // Fetched separately, not via `include` — same reasoning as getAllLoans
  // above: a required relation that can't resolve (a hard-deleted user)
  // must degrade to null, not throw for the whole request.
  const [user, property, inquiry] = await Promise.all([
    prisma.user.findUnique({ where: { id: loan.userId }, select: { name: true, email: true, phone: true } }),
    loan.propertyId
      ? prisma.property.findUnique({ where: { id: loan.propertyId }, select: { title: true, slug: true, city: true, locality: true, propertyType: true, listingType: true, price: true } })
      : null,
    loan.leadId ? prisma.lead.findUnique({ where: { id: loan.leadId }, select: { id: true, refCode: true, status: true } }) : null,
  ]);
  loan.user = user || null;
  loan.property = property || null;
  loan.inquiry = inquiry || null;

  const { documents } = await attachLoanDocuments(loan);

  // "Admin responses include the verifying admin per document" — a second,
  // small lookup rather than folding into attachLoanDocuments itself, since
  // the user-facing version of this helper has no business exposing which
  // admin reviewed a document.
  const adminIds = [...new Set(documents.map((d) => d.verifiedByAdminId).filter(Boolean))];
  const adminsById = adminIds.length
    ? new Map((await prisma.user.findMany({
        where: { id: { in: adminIds } },
        select: { id: true, name: true, email: true },
      })).map((a) => [a.id, a]))
    : new Map();

  return {
    ...loan,
    documents: documents.map((d) => ({
      ...d,
      verifiedByAdmin: d.verifiedByAdminId ? (adminsById.get(d.verifiedByAdminId) || null) : null,
    })),
  };
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

// Free-text internal note on a lead (Lead.adminNotes); never shown to the buyer or partner.
async function setLeadAdminNote(leadId, note, adminId, ip) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, adminNotes: true } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  const updated = await prisma.lead.update({ where: { id: leadId }, data: { adminNotes: note || null }, select: { id: true, adminNotes: true } });
  await createAuditLog({
    adminId, action: 'LEAD_ADMIN_NOTE_UPDATED', targetType: 'Lead', targetId: leadId,
    before: { adminNotes: lead.adminNotes }, after: { adminNotes: updated.adminNotes }, ipAddress: ip,
  });
  return updated;
}

async function updateLoanStatus(loanId, status, adminNote, adminId, extraFields = {}) {
  const loan = await prisma.loanApplication.findUnique({
    where: { id: loanId },
    include: { user: { select: { email: true, notifEmail: true, marketingOptIn: true } } },
  });
  if (!loan) throw new ApiError(404, 'Loan application not found');
  if (!isLoanTransitionAllowed(loan.status, status)) {
    throw new ApiError(400, `Cannot move a loan from ${loan.status} to ${status}`, { code: 'INVALID_LOAN_TRANSITION' });
  }

  if (status === 'DOCUMENTS_VERIFIED') {
    const { documents } = await attachLoanDocuments(loan);
    if (!hasVerifiedDocument(documents)) {
      throw new ApiError(400, 'Cannot mark documents verified: no approved document is attached to this application', { code: 'LOAN_NO_VERIFIED_DOCUMENTS' });
    }
  }

  const statusFields = {};
  if (status === 'SANCTIONED') statusFields.sanctionedAt = new Date();
  if (status === 'DISBURSED')  statusFields.disbursedAt  = new Date();
  // The buyer's loan screen reads rejectionReason, so a reject note must land there too.
  if (status === 'REJECTED' && adminNote) statusFields.rejectionReason = adminNote;

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
    message: status === 'REJECTED' && adminNote
      ? `Your loan application was not approved. Reason: ${adminNote}`
      : `Your loan application status has been updated to ${status.replace(/_/g, ' ')}.`,
    type:    'LOAN_STATUS_UPDATE',
    // Dev feedback, 2026-10-08 (L5) — /dashboard/loan/:id doesn't exist
    // in the frontend. SANCTIONED has its own detail screen
    // (/user/loans/sanctioned?id=...); every other status just goes to
    // the list, since there's no per-status detail route for those.
    linkUrl: status === 'SANCTIONED' ? `/user/loans/sanctioned?id=${loanId}` : '/user/loans',
  });
  notifyUser(loan.userId, 'loan_status_update', {
    name: '$userName', bank: loan.preferredBank || 'your lender', status: status.replace(/_/g, ' ').toLowerCase(),
  });

  sendLoanStatusUpdate(loan.user.email, status, adminNote, loanId, loan.user).catch(() => {});

  return updated;
}

// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────

// User.prisma has no `status` column — derived from isSuspended/phoneVerified
// (see utils/validators.js's USER_STATUSES, the single source of truth for
// the three values this endpoint recognizes). Mirrors deriveUserStatus below.
function deriveUserStatus(user) {
  if (user.isSuspended) return 'SUSPENDED';
  if (!user.phoneVerified) return 'PHONE_UNVERIFIED';
  return 'ACTIVE';
}

// B90 — user list/detail showed no inquiry or spend figures at all. One
// grouped query per source for the whole page, not one per row. Spend counts
// money actually taken: escrow tokens that were captured (HELD/RELEASED) and
// successful service subscriptions.
async function buyerActivityFor(users) {
  const userIds = users.map((u) => u.id);
  const empty = () => ({ inquiryCount: 0, totalSpend: 0 });
  const byId = new Map(userIds.map((id) => [id, empty()]));
  if (!userIds.length) return byId;
  const phones = users.map((u) => u.phone).filter(Boolean);
  const [leads, escrows, subs] = await Promise.all([
    prisma.lead.findMany({
      where: { OR: [{ buyerId: { in: userIds } }, ...(phones.length ? [{ buyerPhone: { in: phones } }] : [])] },
      select: { buyerId: true, buyerPhone: true },
    }),
    prisma.escrowTransaction.groupBy({
      by: ['buyerId'], where: { buyerId: { in: userIds }, status: { in: ['HELD', 'RELEASED'] } }, _sum: { amount: true },
    }),
    prisma.userSubscription.groupBy({
      by: ['userId'], where: { userId: { in: userIds }, paymentStatus: 'SUCCESS' }, _sum: { amountPaid: true },
    }),
  ]);
  countInquiriesByUser(users, leads).forEach((n, id) => { byId.get(id).inquiryCount = n; });
  escrows.forEach((r) => { byId.get(r.buyerId).totalSpend += r._sum.amount || 0; });
  subs.forEach((r) => { byId.get(r.userId).totalSpend += r._sum.amountPaid || 0; });
  return byId;
}

async function getAllUsers(filters, skip, limit) {
  // Soft-deleted rows (clerk.handler.js's user.deleted) are kept only to
  // preserve foreign keys on records they used to own — they should never
  // show up as if still a real account. isSet: false, not deletedAt: null —
  // every pre-existing row has the field missing entirely (added after they
  // were created), and a plain `null` filter only matches an *explicit*
  // null, so it would have matched zero rows and emptied this whole list.
  // Built without `status` — the status tab is layered on separately below,
  // since the same base (role/isNRI/search) also drives the per-tab
  // summary counts, which must NOT themselves be scoped to one tab.
  const baseWhere = { deletedAt: { isSet: false } };
  if (filters.role) baseWhere.role = filters.role;
  if (filters.isNRI !== undefined) baseWhere.isNRI = filters.isNRI;

  if (filters.search) {
    // refCode/name/email all do a case-insensitive substring match. Phone
    // is different: numbers are stored in E.164 (phoneUtils.js's
    // phoneField, applied at signup) but admins type a bare national
    // number — normalizePhone resolves a COMPLETE number to the same
    // E.164 form for an exact match, while a partial fragment (e.g.
    // "9000000") fails to normalize (it isn't a valid number) and falls
    // back to a plain digits-only substring match instead. Normalizing a
    // partial number to a full +91… form isn't possible — there's nothing
    // to pad it with — so the two paths are deliberately not merged into one.
    const normalizedPhone = normalizePhone(filters.search);
    const digitsOnly = filters.search.replace(/\D/g, '');
    baseWhere.OR = [
      { name:    { contains: filters.search, mode: 'insensitive' } },
      { email:   { contains: filters.search, mode: 'insensitive' } },
      { refCode: { contains: filters.search, mode: 'insensitive' } },
      ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
      // Guarded to 4+ digits — a shorter fragment would match an
      // unreasonably large slice of the phone index for little benefit.
      ...(!normalizedPhone && digitsOnly.length >= 4 ? [{ phone: { contains: digitsOnly } }] : []),
    ];
  }

  const where = { ...baseWhere };
  if (filters.status === 'SUSPENDED') {
    where.isSuspended = true;
  } else if (filters.status === 'PHONE_UNVERIFIED') {
    where.phoneVerified = false;
  } else if (filters.status === 'ACTIVE') {
    where.isSuspended = false;
    where.phoneVerified = true;
  }

  const [data, total, suspendedCount, phoneUnverifiedCount, activeCount] = await Promise.all([
    prisma.user.findMany({
      where, skip, take: limit,
      select: {
        id: true, refCode: true, name: true, email: true, phone: true, phoneVerified: true,
        role: true, kycStatus: true, partnerSubType: true, isNRI: true, isSuspended: true, createdAt: true,
        address: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
    // Summary — per-status counts for the filter tabs, scoped to the SAME
    // role/isNRI/search filters but deliberately NOT the status filter
    // itself, so switching tabs doesn't reset what the other tabs show.
    prisma.user.count({ where: { ...baseWhere, isSuspended: true } }),
    prisma.user.count({ where: { ...baseWhere, phoneVerified: false } }),
    prisma.user.count({ where: { ...baseWhere, isSuspended: false, phoneVerified: true } }),
  ]);

  const activity = await buyerActivityFor(data);

  return {
    data: data.map((u) => ({ ...u, ...activity.get(u.id), status: deriveUserStatus(u) })),
    total,
    summary: { active: activeCount, suspended: suspendedCount, phoneUnverified: phoneUnverifiedCount },
  };
}

// An ADMIN with no staff role (or SUPER_ADMIN) holds every permission. Only such an admin may create, change or remove another
// one: otherwise a limited staff member (for example one who may only manage users) could make themselves or a friend unrestricted.
const isUnrestrictedAdmin = (u) => !!u && u.role === 'ADMIN' && (u.staffRole == null || u.staffRole === 'SUPER_ADMIN');

function assertCanTouchAdmin(actor, target, what) {
  if (actor && !isUnrestrictedAdmin(actor) && isUnrestrictedAdmin(target)) {
    throw new ApiError(403, `Only an unrestricted admin can ${what} an unrestricted admin`, { code: 'ADMIN_OUTRANKS_YOU' });
  }
}

// A limited admin who manages staff may hand out only what they hold themselves, and never the unrestricted levels.
function assertCanGrant(actor, { staffRole, permissions }) {
  if (!actor || isUnrestrictedAdmin(actor)) return;
  if (staffRole === null || staffRole === 'SUPER_ADMIN') {
    throw new ApiError(403, 'Only an unrestricted admin can give the SUPER_ADMIN level or remove a staff role', { code: 'CANNOT_GRANT_UNRESTRICTED' });
  }
  const held = new Set(actor.adminPermissions || []);
  const beyond = (permissions || []).filter((p) => !held.has(p));
  if (beyond.length) {
    throw new ApiError(403, `You cannot grant permissions you do not hold yourself: ${beyond.join(', ')}`, { code: 'CANNOT_GRANT_BEYOND_OWN', permissions: beyond });
  }
}

// `actor` is the signed-in admin making the request (req.user). It is left out only by trusted internal callers (createStaffMember
// below, which has already checked the same rules), never by a route.
async function changeUserRole(targetUserId, newRole, adminId, ip, actor = null) {
  if (targetUserId === adminId) throw new ApiError(400, 'Cannot change your own role');
  if (!ROLES.includes(newRole)) throw new ApiError(400, 'Invalid role');

  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (actor && !isUnrestrictedAdmin(actor) && (newRole === 'ADMIN' || user.role === 'ADMIN')) {
    throw new ApiError(403, 'Only an unrestricted admin can make someone an admin or change an admin\'s role. Use the staff directory.', { code: 'ADMIN_OUTRANKS_YOU' });
  }

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

  // A buyer who is made a partner (from here or by hand in the database) otherwise learns nothing: tell them
  // what to do next. Failures here must not undo the role change.
  if (newRole === 'PARTNER' && user.role !== 'PARTNER') {
    await createNotification({
      userId: targetUserId,
      title: 'You can now use the partner app',
      message: 'Your account has been set up as a partner. Open the partner app and complete your KYC to start receiving inquiries.',
      type: 'ROLE_CHANGED',
      linkUrl: '/partners/register',
    }).catch((err) => logger.warn('[changeUserRole] partner notification failed', { error: err.message }));
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
async function createStaffMember(targetUserId, { staffRole, permissions }, adminId, ip, actor = null) {
  if (!ADMIN_STAFF_ROLES.includes(staffRole)) {
    throw new ApiError(400, `staffRole must be one of ${ADMIN_STAFF_ROLES.join(', ')}`);
  }
  const grantedPermissions = permissions ?? DEFAULT_PERMISSIONS_BY_STAFF_ROLE[staffRole] ?? [];
  const invalid = grantedPermissions.filter((p) => !ADMIN_PERMISSION_SCOPES.includes(p));
  if (invalid.length) throw new ApiError(400, `Unknown permission(s): ${invalid.join(', ')}`);

  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new ApiError(404, 'User not found');
  assertCanGrant(actor, { staffRole, permissions: grantedPermissions });
  assertCanTouchAdmin(actor, target, 'change');

  if (target.role !== 'ADMIN') {
    await changeUserRole(targetUserId, 'ADMIN', adminId, ip); // already checked above
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

async function updateStaffPermissions(targetUserId, { staffRole, permissions }, adminId, ip, actor = null) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new ApiError(404, 'User not found');
  if (target.role !== 'ADMIN') throw new ApiError(400, 'This user is not a staff member');
  assertCanTouchAdmin(actor, target, 'change');
  assertCanGrant(actor, { staffRole, permissions });

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
async function removeStaffMember(targetUserId, adminId, ip, actor = null) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new ApiError(404, 'User not found');
  if (target.role !== 'ADMIN') throw new ApiError(400, 'This user is not a staff member');
  assertCanTouchAdmin(actor, target, 'remove');

  await changeUserRole(targetUserId, 'USER', adminId, ip); // already checked above
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
    // B119 — the buyer's own attachments, under an explicit name so the admin
    // screen can render them (comment photos stay on each comment).
    userPhotos: ticket.photos || [],
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
// B89 — real partner and vendor rating aggregates for /admin/ratings (the page used to show hard-coded
// sample rows). Partner rating = buyers' Lead.buyerRating per assigned partner; vendor rating = users'
// ServiceTicket.vendorRating per vendor. Anything averaging below 3 is flagged for review.
async function getRatingsSummary() {
  const LOW = 3;
  const [rated, closedCounts, tickets] = await Promise.all([
    prisma.lead.findMany({
      where: { buyerRating: { not: null }, assignedPartnerId: { not: null } },
      select: { assignedPartnerId: true, buyerRating: true },
    }),
    prisma.lead.groupBy({ by: ['assignedPartnerId'], where: { status: 'CLOSED', assignedPartnerId: { not: null } }, _count: { _all: true } }),
    prisma.serviceTicket.findMany({
      where: { vendorRating: { not: null } },
      select: { vendorId: true, vendorName: true, vendorRating: true },
    }),
  ]);

  const byPartner = new Map();
  for (const l of rated) {
    const e = byPartner.get(l.assignedPartnerId) || { sum: 0, count: 0 };
    e.sum += l.buyerRating; e.count += 1;
    byPartner.set(l.assignedPartnerId, e);
  }
  const closedBy = new Map(closedCounts.map((c) => [c.assignedPartnerId, c._count._all]));
  const partnerUsers = byPartner.size
    ? await prisma.user.findMany({ where: { id: { in: [...byPartner.keys()] } }, select: { id: true, name: true, companyName: true } })
    : [];
  const partnerById = new Map(partnerUsers.map((u) => [u.id, u]));
  const partners = [...byPartner.entries()].map(([id, e]) => {
    const u = partnerById.get(id);
    const avg = Math.round((e.sum / e.count) * 10) / 10;
    return { id, name: u?.companyName || u?.name || 'Removed partner', deals: closedBy.get(id) || 0, reviews: e.count, rating: avg, flag: avg < LOW };
  }).sort((a, b) => a.rating - b.rating);

  const byVendor = new Map();
  for (const t of tickets) {
    const key = t.vendorId || `name:${t.vendorName || 'Unknown'}`;
    const e = byVendor.get(key) || { sum: 0, count: 0, name: t.vendorName || 'Unknown vendor', vendorId: t.vendorId };
    e.sum += t.vendorRating; e.count += 1;
    byVendor.set(key, e);
  }
  const vendorIds = [...byVendor.values()].map((v) => v.vendorId).filter(Boolean);
  const vendorRows = vendorIds.length
    ? await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true, category: true } })
    : [];
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));
  const vendors = [...byVendor.values()].map((e) => {
    const v = e.vendorId ? vendorById.get(e.vendorId) : null;
    const avg = Math.round((e.sum / e.count) * 10) / 10;
    return { id: e.vendorId, name: v?.name || e.name, category: v?.category || null, jobs: e.count, rating: avg, flag: avg < LOW };
  }).sort((a, b) => a.rating - b.rating);

  return { partners, vendors };
}

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
  const avgResolutionDays = averageResolutionDays(resolved);

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

  const updated = await prisma.serviceTicket.update({ where: { id: ticketId }, data });

  // The admin "Dispatch vendor" dialog goes through this free-text path (not
  // dispatchTicket below), so the buyer has to be told from here too.
  if (vendorName !== undefined && vendorName !== ticket.vendorName) {
    createNotification({
      userId: ticket.userId,
      title: 'Vendor dispatched',
      message: `${vendorName} has been assigned to your ticket "${ticket.subject}".`,
      type: 'TICKET_VENDOR_DISPATCHED',
      linkUrl: `/user/tickets/${ticketId}`,
    }).catch(() => {});
    sendTicketVendorDispatched(ticket.userId, ticket.subject, vendorName, ticketId);
  }

  return updated;
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
  sendTicketVendorDispatched(ticket.userId, ticket.subject, vendor.name, ticketId);

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
        resolutionNote: data.note,
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
  messageBuyer(ticket.userId, {
    template: 'buyer_ticket_update',
    params: { name: '$userName', ticket_subject: ticket.subject, update: `resolved${totalCharge > 0 ? `, total charge Rs ${totalCharge.toLocaleString('en-IN')}` : ''}. Please open the app to verify it` },
    context: { ticketId },
    email: (to, user) => sendTicketUpdate(to, { subject: ticket.subject, ticketId, update: `it has been resolved${totalCharge > 0 ? `, total charge ₹${totalCharge.toLocaleString('en-IN')}` : ''}. Please open it to verify.` }, user),
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

async function addAdminTicketComment(ticketId, adminId, { text, photos }, ip) {
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
  messageBuyer(ticket.userId, {
    template: 'buyer_ticket_update',
    params: { name: '$userName', ticket_subject: ticket.subject, update: 'our team has replied. Please open the app to read it' },
    context: { ticketId },
    email: (to, user) => sendTicketUpdate(to, { subject: ticket.subject, ticketId, update: `our team has replied: "${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"` }, user),
  });

  // T46 — the reply is visible to the buyer, so it is on the record too.
  await createAuditLog({
    adminId, action: 'TICKET_REPLIED', targetType: 'ServiceTicket', targetId: ticketId,
    after: { commentId: comment.id, text: text.length > 200 ? `${text.slice(0, 200)}…` : text }, ipAddress: ip,
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

// ─── PRIVACY AUDIT TRAIL (Admin) ─────────────────────────────────────────────
// Backend gaps handoff, 2026-10-10 (#3) — a user's own consent/legal/
// notification/withdrawal/deletion history (UserPrivacyAuditLog), distinct
// from the admin AuditLog above. "Every read is itself audit-logged" — an
// admin looking at someone's privacy history is itself a sensitive action.

function toCsvRow(fields) {
  return fields.map((f) => csvCell(f)).join(',');
}

function privacyEventsToCsv(events) {
  const header = toCsvRow(['id', 'action', 'documentVersion', 'ipAddress', 'userAgent', 'metadata', 'createdAt']);
  const rows = events.map((e) => toCsvRow([
    e.id, e.action, e.documentVersion, e.ipAddress, e.userAgent, e.metadata, e.createdAt.toISOString(),
  ]));
  return [header, ...rows].join('\n');
}

async function getUserPrivacyEvents(userId, filters, skip, limit, adminId, ip) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new ApiError(404, 'User not found');

  const where = { userId };
  if (filters.action) where.action = filters.action;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to)   where.createdAt.lte = new Date(filters.to);
  }

  await createAuditLog({
    adminId, action: 'PRIVACY_EVENTS_VIEWED', targetType: 'User', targetId: userId, ipAddress: ip,
  });

  if (filters.format === 'csv') {
    const events = await prisma.userPrivacyAuditLog.findMany({ where, orderBy: { createdAt: 'desc' } });
    return { csv: privacyEventsToCsv(events) };
  }

  const [data, total] = await Promise.all([
    prisma.userPrivacyAuditLog.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.userPrivacyAuditLog.count({ where }),
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
  // BE-9 — pricePaise alongside the existing rupee field.
  const svc = await prisma.service.create({ data: { ...data, ...(data.price != null && { pricePaise: Math.round(data.price * 100) }) } });
  cacheDelPattern(CACHE_KEYS.SERVICES_LIST_PATTERN); // BE-8 — every category's cache entry, not just the unfiltered one
  return svc;
}

async function adminUpdateService(id, data) {
  const svc = await prisma.service.findUnique({ where: { id } });
  if (!svc) throw new ApiError(404, 'Service not found');
  const updated = await prisma.service.update({
    where: { id },
    data: { ...data, ...(data.price != null && { pricePaise: Math.round(data.price * 100) }) },
  });
  cacheDelPattern(CACHE_KEYS.SERVICES_LIST_PATTERN); // BE-8 — every category's cache entry, not just the unfiltered one
  return updated;
}

async function adminDeleteService(id) {
  const svc = await prisma.service.findUnique({ where: { id } });
  if (!svc) throw new ApiError(404, 'Service not found');
  // Soft-delete — keeps existing subscriptions resolvable
  const deactivated = await prisma.service.update({ where: { id }, data: { isActive: false } });
  cacheDelPattern(CACHE_KEYS.SERVICES_LIST_PATTERN); // BE-8 — every category's cache entry, not just the unfiltered one
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

  const updated = await prisma.userDocument.update({
    where: { id: docId },
    data: {
      status:            isApprove ? 'APPROVED' : 'REJECTED',
      isVerified:        isApprove,
      verifiedAt:        isApprove ? new Date() : null,
      verifiedByAdminId: adminId,
      rejectionNote:     isApprove ? null : note,
    },
  });

  // B57 — the buyer only found out by re-opening the vault.
  const docLabel = String(doc.documentType || 'document').replace(/_/g, ' ').toLowerCase();
  await createNotification({
    userId: doc.userId,
    title: isApprove ? 'Document verified' : 'Document needs attention',
    message: isApprove
      ? `Your ${docLabel} has been verified.`
      : `Your ${docLabel} was not accepted: ${note}`,
    type: 'DOCUMENT_REVIEWED',
    linkUrl: '/user/documents',
  }).catch(() => null);

  return updated;
}

// ─── ADMIN DETAIL VIEWS ───────────────────────────────────────────────────────

async function getPropertyByIdAdmin(propertyId) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { editLogs: { orderBy: { editedAt: 'desc' }, take: 10 } },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  // Fixed 2026-10-12 — partner fetched separately, not via `include` (same
  // hard-deleted-partner bug as getPendingProperties/approveProperty above).
  property.partner = await prisma.user.findUnique({
    where: { id: property.partnerId },
    select: { name: true, email: true, phone: true, companyName: true, partnerSubType: true, kycStatus: true },
  });
  return property;
}

async function getKycByUserId(userId) {
  const user = await prisma.user.findFirst({
    where: { id: userId, role: 'PARTNER' },
    select: {
      id: true, name: true, email: true, phone: true, companyName: true, partnerSubType: true,
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
      address: true,
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
  const activity = await buyerActivityFor([user]);
  return { ...user, ...activity.get(userId) };
}

// T42 — the Inquiries and Subscriptions tabs of the admin user page.
async function listUserInquiriesAdmin(userId, skip, limit) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, phone: true } });
  if (!user) throw new ApiError(404, 'User not found');
  const where = inquiryWhereForUser(user);
  const [data, total] = await Promise.all([
    prisma.lead.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'desc' },
      select: {
        id: true, refCode: true, status: true, source: true, buyerMessage: true, createdAt: true,
        buyerId: true, propertyId: true, propertyInterest: true,
        property: { select: { id: true, title: true, slug: true, locality: true, city: true } },
        assignedPartner: { select: { id: true, name: true } },
      },
    }),
    prisma.lead.count({ where }),
  ]);
  return { data, total };
}

async function listUserSubscriptionsAdmin(userId, skip, limit) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new ApiError(404, 'User not found');
  const where = { userId };
  const [data, total] = await Promise.all([
    prisma.userSubscription.findMany({
      where, skip, take: limit, orderBy: { startDate: 'desc' },
      select: {
        id: true, paymentStatus: true, amountPaid: true, currency: true, startDate: true, endDate: true,
        service: { select: { id: true, name: true } },
      },
    }),
    prisma.userSubscription.count({ where }),
  ]);
  return { data, total };
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
  getAuditLogs, getUserPrivacyEvents,
  getAllTickets, getTicketById, updateTicketStatus, getTicketStats, getRatingsSummary,
  dispatchTicket, resolveTicket, linkTicketToDeal, getAdminTicketComments, addAdminTicketComment,
  getAllLoans, getLoanById, setLeadAdminNote,
  updateLoanStatus, getLoanBankStats,
  getAllUsers, changeUserRole, suspendUser,
  listStaff, createStaffMember, updateStaffPermissions, removeStaffMember,
  getPartnerMetrics, getPartnerById,
  adminListServices, adminCreateService, adminUpdateService, adminDeleteService,
  getPropertyByIdAdmin, getKycByUserId, getUserByIdAdmin, listUserInquiriesAdmin, listUserSubscriptionsAdmin,
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

  // B77 — the list showed the assignee as a raw id. Looked up separately (no
  // Prisma relation on assignedTo) and null-safe: a deleted staff user just
  // leaves assignedToName empty instead of failing the page.
  const staffIds = [...new Set(data.map((t) => t.assignedTo).filter(Boolean))];
  const staff = staffIds.length
    ? await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(staff.map((u) => [u.id, u.name]));
  return { data: data.map((t) => ({ ...t, assignedToName: t.assignedTo ? nameById.get(t.assignedTo) || null : null })), total };
}

async function uploadVideoTourFile(id, fileUrl) {
  const tour = await prisma.videoTourRequest.findUnique({ where: { id } });
  if (!tour) throw new ApiError(404, 'Video tour request not found');

  return prisma.videoTourRequest.update({
    where: { id },
    data: { videoUrl: fileUrl, status: 'COMPLETED', completedAt: new Date() },
  });
}

// Tells a buyer about a ticket or video-tour change on WhatsApp and email. Fire-and-forget by design: the change has
// already been saved, so a message that cannot be sent must never fail the admin's action. WhatsApp is skipped until the
// template is in WATI_LIVE_TEMPLATES (see notifyUser).
async function messageBuyer(userId, { template, params, context, email }) {
  try {
    if (template) notifyUser(userId, template, params, context || {});
    // The preference fields go along, so the buyer's "Email alerts" switch is respected (with no user in scope the gate sends anyway).
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, notifEmail: true, notifWhatsapp: true, marketingOptIn: true } });
    if (u?.email && email) await email(u.email, u);
  } catch (err) {
    logger.warn('[Admin] buyer message failed', { userId, template, error: err.message });
  }
}

async function updateVideoTour(id, { assignedTo, videoUrl, scheduledAt, adminNote, status }) {
  const tour = await prisma.videoTourRequest.findUnique({ where: { id } });
  if (!tour) throw new ApiError(404, 'Video tour request not found');

  // B78 — assignedTo is a free-text id on the form; it must be an internal
  // staff (ADMIN-role) account, not a partner or buyer.
  if (assignedTo !== undefined) {
    const assignee = await prisma.user.findFirst({ where: { id: assignedTo, role: 'ADMIN' }, select: { id: true } });
    if (!assignee) throw new ApiError(400, 'assignedTo must be an internal staff (admin) account');
  }

  const data = {};
  if (assignedTo !== undefined) { data.assignedTo = assignedTo; data.status = 'ASSIGNED'; }
  if (videoUrl    !== undefined) { data.videoUrl   = videoUrl;   data.status = 'COMPLETED'; data.completedAt = new Date(); }
  if (scheduledAt !== undefined) data.scheduledAt = new Date(scheduledAt);
  if (adminNote   !== undefined) data.adminNote   = adminNote;
  if (status      !== undefined) data.status      = status;

  const updated = await prisma.videoTourRequest.update({ where: { id }, data });

  // B79 — the buyer was never told their tour was scheduled / is ready.
  const justScheduled = scheduledAt !== undefined && !tour.scheduledAt;
  const justCompleted = data.status === 'COMPLETED' && tour.status !== 'COMPLETED';
  if (justScheduled || justCompleted) {
    await createNotification({
      userId: tour.userId,
      title: justCompleted ? 'Your video tour is ready' : 'Video tour scheduled',
      message: justCompleted
        ? 'Your requested video tour has been completed. Open it from your video tours.'
        : `Your video tour is scheduled for ${new Date(scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST.`,
      type: 'VIDEO_TOUR_UPDATE',
      linkUrl: '/user/nri',
    }).catch(() => null);
    const tourProperty = await prisma.property.findUnique({ where: { id: tour.propertyId }, select: { title: true } }).catch(() => null);
    const whenText = scheduledAt ? new Date(scheduledAt).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST' : '';
    messageBuyer(tour.userId, {
      // The WhatsApp template covers "scheduled" only; a completed tour is told in the app and by email.
      template: justCompleted ? null : 'nri_video_tour_scheduled',
      params: { name: '$userName', property_title: tourProperty?.title || 'the property', tour_time: whenText },
      context: {},
      email: (to, user) => sendVideoTourUpdate(to, { propertyTitle: tourProperty?.title, whenText, completed: justCompleted }, user),
    });
  }
  return updated;
}
