const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { formatContact, maskPhone, maskEmail } = require('../../lib/phoneUtils');
const { generate, expiresAt, isExpired, isLocked, lockUntil, maxAttemptsReached } = require('../../lib/otp');
const { sendSiteVisitOtp } = require('../../lib/wati');
const { createNotification, broadcastNotification, notifyAdmins } = require('../../lib/notifications');
const logger = require('../../lib/logger');
const { sendLeadAssigned } = require('../../lib/email');
const { createAuditLog } = require('../../lib/auditLog');
const { isVisitTooEarly, DEFAULT_EARLY_WINDOW_HOURS } = require('../../lib/visitWindow');
const { getConfigNumber } = require('../config/config.service');
const { nextRefCode } = require('../../lib/refCode');
const { assertLeadNotPaused } = require('../../lib/accountDeletion');
const { buildPartnerQuote } = require('../../lib/commissionQuote');
const { decideBuyerOwnership, OWNERSHIP_TEXT } = require('../../lib/leadOwnership');
const { getMoneySettings } = require('../money/moneyConfig');

const DEFAULT_MAX_ACTIVE_INQUIRIES = 5;
const DEFAULT_MAX_INQUIRIES_PER_DAY = 3;
// B36 — release() deducts escrow_platform_fee_pct (default 1) of the held
// amount. The partner-facing "you receive" figure must use that same rate;
// it used a per-lead snapshot of platform_commission_pct (a share of the
// brokerage fee, a different base), so identical tokens showed ₹49,000 on one
// deal and ₹50,000 on another.
// Money model Rev 3: the old 1%-of-token platform fee is gone; the token-level
// fee is escrow_token_platform_fee_pct (default 0). Same key moneyConfig reads.
const ESCROW_PLATFORM_FEE_PCT_KEY = 'escrow_token_platform_fee_pct';
const DEFAULT_ESCROW_PLATFORM_FEE_PCT = 0;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The actual UTC instant corresponding to 00:00:00 IST "today" — regardless
// of what timezone the server process itself runs in. The old code used
// `new Date().setHours(0,0,0,0)`, which is the server's *local* midnight —
// silently wrong (off by 5.5 hours) the moment this runs on a UTC host,
// which every production box is.
function startOfTodayIST() {
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnightAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(istMidnightAsUtc - IST_OFFSET_MS);
}

// Dev feedback, 2026-10-07 — shared by both the buyer- and partner-facing
// sanitizers below. These are the lead's commission/owner-invoice bookkeeping
// (the assigned partner's OWN commission view is a separate, deliberately
// narrow endpoint — commission.service.js's getPartnerRateCards, "the
// platform's cut is not their business") and the contact-reveal audit trail
// (contactRevealedIp — security metadata, not something either a buyer or a
// partner has any reason to see). Neither sanitizer hid any of this before;
// sanitizeLeadForPartner in particular let every one of these straight
// through, undermining getPartnerRateCards' whole point of showing a partner
// only their own slice.
const COMMISSION_INTERNAL_LEAD_FIELDS = [
  'feePct', 'dealPriceAtLock', 'commissionLockedAt', 'commissionVersion', 'rateCardId', 'rateCardVersion',
  'platformCommissionPct', 'commissionAmountPaise', 'commissionStatus', 'invoiceUrl', 'invoicedAt', 'collectedAt',
  'contactRevealedIp',
  // Money model Rev 3 — the partner gets a built quote (commissionQuote), the
  // buyer gets nothing of the seller-side rates.
  'partnerRatePct', 'platformFeePct', 'commissionRateSource', 'commissionRateCustom', 'commissionRateReason',
];

// Internal-only fields a buyer never needs: admin/partner free-text notes,
// OTP attempt bookkeeping, and the full commission/drop-request workflow
// state. siteVisitOTP is deliberately kept — the buyer is the one who reads
// it out to the partner at the site-visit gate. contactRevealedByPartnerId
// completes the contact-reveal audit trail alongside contactRevealedIp
// above — a raw partner user id with no purpose on the buyer's own read of
// their own lead (not added to COMMISSION_INTERNAL_LEAD_FIELDS/shared with
// the partner sanitizer: it's usually the partner's OWN id, harmless for
// them to see back).
const BUYER_HIDDEN_LEAD_FIELDS = [
  'adminNotes', 'partnerNotes', 'visitNotes', 'otpAttempts',
  ...COMMISSION_INTERNAL_LEAD_FIELDS,
  'dropRequestedByPartner', 'dropRequestNote', 'dropRequestedAt', 'droppedReason', 'droppedAt', 'droppedByAdminId',
  'contactRevealedByPartnerId',
];

function sanitizeLeadForBuyer(lead) {
  if (!lead) return lead;
  const clean = { ...lead };
  for (const field of BUYER_HIDDEN_LEAD_FIELDS) delete clean[field];
  return clean;
}

async function submitLead(data, user) {
  const property = await prisma.property.findUnique({ where: { id: data.propertyId }, select: { id: true, title: true, publishStatus: true } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.publishStatus !== 'APPROVED') throw new ApiError(400, 'This property is not currently available for enquiry');

  // Re-keyed on the authenticated buyer, not a client-typed phone number
  // that doesn't have to belong to whoever is actually submitting.
  const existingForProperty = await prisma.lead.findFirst({
    where: { propertyId: data.propertyId, buyerId: user.id, status: { not: 'DROPPED' } },
  });
  if (existingForProperty) throw new ApiError(409, 'You have already submitted an enquiry for this property');

  const maxActive = await getConfigNumber('max_active_inquiries', DEFAULT_MAX_ACTIVE_INQUIRIES);
  const activeCount = await prisma.lead.count({
    where: { buyerId: user.id, status: { notIn: ['CLOSED', 'DROPPED'] } },
  });
  if (activeCount >= maxActive) {
    throw new ApiError(429, `You can have at most ${maxActive} active inquiries. Close or cancel one to send another.`, { code: 'ACTIVE_INQUIRY_LIMIT' });
  }

  const todayStart = startOfTodayIST();
  const maxDaily = await getConfigNumber('max_inquiries_per_day', DEFAULT_MAX_INQUIRIES_PER_DAY);
  const todayCount = await prisma.lead.count({
    where: { buyerId: user.id, createdAt: { gte: todayStart } },
  });
  if (todayCount >= maxDaily) {
    throw new ApiError(429, `You can submit at most ${maxDaily} inquiries per day.`, { code: 'DAILY_INQUIRY_LIMIT' });
  }

  // Name/email/phone are always a snapshot of the verified account, never
  // client input — buyerName/buyerEmail/buyerPhone are no longer accepted
  // in the request body at all (leads.validator.js), closing the gap where
  // a submitted phone didn't have to match the authenticated buyer's own.
  const refCode = await nextRefCode('lead');
  const lead = await prisma.lead.create({
    data: {
      refCode,
      propertyId: data.propertyId,
      buyerMessage: data.buyerMessage,
      buyerName: data.buyerName || user.name,
      buyerEmail: user.email,
      buyerPhone: user.phone,
      buyerId: user.id,
      status: 'UNASSIGNED',
    },
  });

  // Race guard: two simultaneous submissions from the same buyer can both
  // pass the counts above before either writes — Mongo gives no cheap
  // cross-document transaction here. Recheck after creating and undo this
  // lead if it pushed either count over the limit, so a retry correctly
  // sees the real 429 instead of a phantom extra inquiry sitting in the DB.
  const activeRecount = await prisma.lead.count({ where: { buyerId: user.id, status: { notIn: ['CLOSED', 'DROPPED'] } } });
  if (activeRecount > maxActive) {
    await prisma.lead.delete({ where: { id: lead.id } });
    throw new ApiError(429, `You can have at most ${maxActive} active inquiries. Close or cancel one to send another.`, { code: 'ACTIVE_INQUIRY_LIMIT' });
  }
  const dailyRecount = await prisma.lead.count({ where: { buyerId: user.id, createdAt: { gte: todayStart } } });
  if (dailyRecount > maxDaily) {
    await prisma.lead.delete({ where: { id: lead.id } });
    throw new ApiError(429, `You can submit at most ${maxDaily} inquiries per day.`, { code: 'DAILY_INQUIRY_LIMIT' });
  }

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await Promise.all(admins.map((admin) => createNotification({
    userId: admin.id,
    title: 'New Unassigned Lead',
    message: `${lead.refCode} · ${lead.buyerName} enquired about "${property.title}".`,
    type: 'LEAD_NEW',
    linkUrl: `/admin/leads/${lead.id}`,
  })));

  return sanitizeLeadForBuyer(lead);
}

const ACTIVE_LEAD_STATUSES = { notIn: ['CLOSED', 'DROPPED'] };

// B3.1–B3.5 — partner logs a buyer they sourced themselves. Lands as
// AWAITING_ADMIN: admin vets it before it enters the normal pipeline, so a
// partner can't self-assign work or manufacture leads that look platform-sourced.
//
// buyerId is deliberately left null even when a registered account has this
// phone. This is the partner's claim about someone who hasn't authenticated or
// consented to it — attributing it to their account would surface it in that
// buyer's own dashboard as an inquiry they never made, and would eat into
// their submitLead quota.
// Loads what the platform knows about this phone and applies the one-number-one-buyer rules (lib/leadOwnership).
// `before`/`excludeLeadId` let the admin Confirm step re-run it for an existing lead as at the time it was added.
async function evaluateBuyerOwnership(phone, partnerId, { excludeLeadId, before } = {}) {
  const [priorLeads, account, settings] = await Promise.all([
    prisma.lead.findMany({
      where: {
        buyerPhone: phone,
        ...(excludeLeadId && { id: { not: excludeLeadId } }),
        ...(before && { createdAt: { lt: before } }),
      },
      select: {
        id: true, addedByPartnerId: true, createdAt: true, assignedAt: true, siteVisitScheduledAt: true,
        otpGeneratedAt: true, otpVerifiedAt: true, visitOutcomeAt: true, closedAt: true,
        escrowTransactions: { select: { createdAt: true, heldAt: true, releasedAt: true } },
      },
    }),
    prisma.user.findFirst({ where: { phone, role: 'USER', deletedAt: { isSet: false } }, select: { createdAt: true } }),
    getMoneySettings(),
  ]);
  return decideBuyerOwnership({
    priorLeads, accountCreatedAt: account?.createdAt ?? null, partnerId,
    windowDays: settings.partnerLeadWindowDays, asOf: before ?? new Date(),
  });
}

async function partnerAddLead(partnerId, data) {
  // Scoped to the partner's own listings — they shouldn't be able to attach a
  // self-sourced buyer to someone else's property.
  const property = await prisma.property.findFirst({
    // B10 — and only a live (approved) one: a rejected/pending listing is not
    // something a buyer can be sent to.
    where: { id: data.propertyId, partnerId, publishStatus: 'APPROVED' },
    select: { id: true, title: true },
  });
  if (!property) throw new ApiError(404, 'Property not found among your approved listings');

  // B3.2 — same buyer, same property, still active.
  const duplicate = await prisma.lead.findFirst({
    where: { propertyId: data.propertyId, buyerPhone: data.buyerPhone, status: ACTIVE_LEAD_STATUSES },
    select: { id: true, refCode: true, status: true },
  });
  if (duplicate) {
    throw new ApiError(409, 'There is already an active lead for this buyer and property', {
      code: 'DUPLICATE_LEAD',
      lead: duplicate,
    });
  }

  // B3.3 — same buyer, different property: link back to their latest lead so
  // admin sees this is a repeat buyer rather than a new one.
  const earlier = await prisma.lead.findFirst({
    where: { buyerPhone: data.buyerPhone },
    orderBy: { createdAt: 'desc' },
    select: { id: true, refCode: true },
  });

  const ownership = await evaluateBuyerOwnership(data.buyerPhone, partnerId);

  const refCode = await nextRefCode('lead');
  const lead = await prisma.lead.create({
    data: {
      refCode,
      buyerName: data.buyerName,
      buyerPhone: data.buyerPhone,
      // buyerEmail is required on the model; partner-added leads may not have
      // one, so store empty rather than inventing an address.
      buyerEmail: data.buyerEmail ?? '',
      buyerMessage: data.note,
      budget: data.budget,
      propertyId: property.id,
      source: 'PARTNER',
      status: 'AWAITING_ADMIN',
      addedByPartnerId: partnerId,
      // The validator only accepts the literal boolean true, so by the time
      // this runs consent was given — recorded as the timestamp the partner
      // actually attested it, not a bare echo of the request body.
      buyerConsentAt: new Date(),
      ...(earlier && { relatedLeadId: earlier.id }),
    },
  });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await Promise.all(admins.map((admin) => createNotification({
    userId: admin.id,
    title: 'Partner-added lead needs review',
    message: `${lead.refCode} · ${lead.buyerName} for "${property.title}" — added by a partner, awaiting your confirmation. ${OWNERSHIP_TEXT[ownership.reason]}`,
    type: 'LEAD_NEW',
    linkUrl: `/admin/leads/${lead.id}`,
  })));

  return { ...sanitizeLeadForPartner(lead), isRepeatBuyer: !!earlier, relatedLead: earlier ?? null, ownership };
}

// `buyer` is only present when the caller's query included it (getPartnerLeads/
// getPartnerLeadById do; a bare prisma.lead.update() result, like uploadDocs
// returns, does not) — buyerRef/buyerPhoneVerified just come out undefined
// (and get dropped by JSON.stringify) in that case, same as if the fields
// never existed.
function sanitizeLeadForPartner(lead) {
  const { buyer, ...rest } = lead;
  // Backend gaps handoff, 2026-10-10 (#2) — once the buyer has requested
  // account deletion, a partner must stop being handed fresh contact
  // details for them, same "no contact before earned" instinct as the OTP
  // gate itself, just triggered by the opposite end of the relationship.
  const contactVisible = lead.isOtpVerified && !buyer?.deletionRequestedAt;
  const clean = {
    ...rest,
    buyerPhone: formatContact(lead.buyerPhone, contactVisible, maskPhone),
    buyerEmail: formatContact(lead.buyerEmail, contactVisible, maskEmail),
    buyerRef: buyer?.refCode,
    buyerPhoneVerified: buyer?.phoneVerified,
    siteVisitOTP: undefined, // never expose OTP in response
    adminNotes: undefined, // admin-internal, never expose to partner
  };
  // Dev feedback, 2026-10-07 — see COMMISSION_INTERNAL_LEAD_FIELDS above.
  // This assigned partner's own commission view is getPartnerRateCards, not
  // the raw lead record.
  for (const field of COMMISSION_INTERNAL_LEAD_FIELDS) delete clean[field];
  return clean;
}

const PARTNER_LEAD_BUYER_SELECT = { select: { refCode: true, phoneVerified: true, deletionRequestedAt: true } };

// B4.13 / 6.9 — "STALLED 6d" on the leads list and the admin stalled digest.
// Computed, not stored: "last activity" is the newest of the timestamps that
// represent someone actually doing something, so it can't go stale the way a
// stored flag would. A lead in a terminal state is never stalled.
const STALLED_AFTER_DAYS = 5;

function stalledInfoFor(lead) {
  if (['CLOSED', 'DROPPED', 'AWAITING_ADMIN'].includes(lead.status)) {
    return { isStalled: false, daysStalled: 0 };
  }
  const activity = [
    lead.visitOutcomeAt, lead.otpVerifiedAt, lead.siteVisitScheduledAt,
    lead.otpGeneratedAt, lead.assignedAt, lead.createdAt,
  ].filter(Boolean).map((d) => new Date(d).getTime());
  if (!activity.length) return { isStalled: false, daysStalled: 0 };

  const days = Math.floor((Date.now() - Math.max(...activity)) / 86_400_000);
  return { isStalled: days >= STALLED_AFTER_DAYS, daysStalled: days };
}

const PARTNER_LEAD_ESCROW_SELECT = {
  select: {
    id: true, amount: true, currency: true, status: true,
    heldAt: true, releasedAt: true, refundedAt: true, failedAt: true, createdAt: true,
    // B38 — what was recorded at release; the partner finance table falls back to partnerShareAmount for its Commission column.
    netAmount: true, partnerShareAmount: true,
  },
  orderBy: { createdAt: 'desc' },
};

// What the partner actually receives: the escrow amount less the platform fee,
// at the same escrow_platform_fee_pct rate release() deducts (B36). null when
// there's no escrow yet — the partner UI has nothing to show a net for until
// money is held.
function netAmountFor(lead, feePct) {
  const escrow = lead.escrowTransactions?.[0];
  if (!escrow || typeof escrow.amount !== 'number') return null;
  const pct = feePct;
  return Math.round((escrow.amount - (escrow.amount * pct) / 100) * 100) / 100;
}

async function getPartnerLeads(partnerId) {
  // Rule 2: Partner sees only their assigned leads
  const [leads, feePct] = await Promise.all([
    prisma.lead.findMany({
      where: { assignedPartnerId: partnerId },
      include: {
        property: { select: { title: true, slug: true, locality: true, city: true } },
        buyer: PARTNER_LEAD_BUYER_SELECT,
        escrowTransactions: PARTNER_LEAD_ESCROW_SELECT,
      },
      orderBy: { createdAt: 'desc' },
    }),
    getConfigNumber(ESCROW_PLATFORM_FEE_PCT_KEY, DEFAULT_ESCROW_PLATFORM_FEE_PCT),
  ]);
  return leads.map((lead) => ({
    ...sanitizeLeadForPartner(lead),
    commissionQuote: buildPartnerQuote(lead),
    netAmount: netAmountFor(lead, feePct),
    ...stalledInfoFor(lead),
  }));
}

async function getPartnerLeadById(leadId, partnerId) {
  const [lead, feePct] = await Promise.all([
    prisma.lead.findFirst({
      where: { id: leadId, assignedPartnerId: partnerId },
      include: {
        property: true,
        buyer: PARTNER_LEAD_BUYER_SELECT,
        escrowTransactions: PARTNER_LEAD_ESCROW_SELECT,
      },
    }),
    getConfigNumber(ESCROW_PLATFORM_FEE_PCT_KEY, DEFAULT_ESCROW_PLATFORM_FEE_PCT),
  ]);
  if (!lead) throw new ApiError(404, 'Lead not found');
  return { ...sanitizeLeadForPartner(lead), commissionQuote: buildPartnerQuote(lead), netAmount: netAmountFor(lead, feePct), ...stalledInfoFor(lead) };
}

async function scheduleVisit(leadId, partnerId, scheduledAt) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.status === 'CLOSED') throw new ApiError(400, 'Cannot schedule visit on a closed lead');
  await assertLeadNotPaused(lead.buyerId);

  const otp = generate();
  const otpExp = expiresAt();

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'SITE_VISIT_SCHEDULED',
      siteVisitScheduledAt: new Date(scheduledAt),
      siteVisitOTP: otp,
      otpGeneratedAt: new Date(),
      otpExpiresAt: otpExp,
      otpAttempts: 0,
      otpLockedUntil: null,
    },
  });

  try {
    await sendSiteVisitOtp(lead.buyerPhone, otp);
  } catch (err) {
    const logger = require('../../lib/logger');
    logger.error('[scheduleVisit] WATI OTP send failed', { leadId, error: err.message });
  }

  // B21/B34 — the buyer's app showed nothing when a visit was booked. The OTP
  // itself stays WhatsApp-only; this just points at it. Partner-added leads
  // have no buyerId by design, so they are skipped here.
  if (lead.buyerId) {
    await createNotification({
      userId: lead.buyerId,
      title: 'Site visit scheduled',
      message: `Your site visit for ${lead.refCode || 'your inquiry'} is set for ${new Date(scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST. Your visit code was sent on WhatsApp.`,
      type: 'VISIT_SCHEDULED',
      linkUrl: `/user/inquiries/${leadId}`,
    }).catch(() => null);
  }
  return { message: 'Visit scheduled. OTP sent to buyer via WhatsApp.' };
}

// Resends the site-visit OTP without touching siteVisitScheduledAt (unlike
// scheduleVisit) and deliberately does NOT reset otpAttempts/otpLockedUntil —
// a resend must not be a free way to reset the 3-attempt anti-leakage lock
// (§12.2). A locked lead can't resend at all; it has to go through the
// admin-override request (§12.3) instead.
async function resendOtp(leadId, partnerId) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!lead.siteVisitScheduledAt) throw new ApiError(400, 'No site visit scheduled for this lead');
  if (isLocked(lead.otpLockedUntil)) {
    // BE-21 — coded so the FE can distinguish this from a plain rate-limit
    // 429 (the lead OTP screen previously had to treat ANY 429 as locked).
    throw new ApiError(429, 'OTP is locked after too many failed attempts. Request an admin override instead.', { code: 'LEAD_OTP_LOCKED' });
  }
  await assertLeadNotPaused(lead.buyerId);

  const otp = generate();
  const otpExp = expiresAt();

  await prisma.lead.update({
    where: { id: leadId },
    data: { siteVisitOTP: otp, otpGeneratedAt: new Date(), otpExpiresAt: otpExp },
  });

  try {
    await sendSiteVisitOtp(lead.buyerPhone, otp);
  } catch (err) {
    logger.error('[resendOtp] WATI OTP send failed', { leadId, error: err.message });
  }
  return { message: 'A new OTP has been sent to the buyer via WhatsApp.' };
}

// Partner-side request only — flags the lead for Admin and notifies every
// admin. It never unlocks the OTP itself; only an explicit admin action does.
async function requestOtpOverride(leadId, partnerId) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!isLocked(lead.otpLockedUntil)) throw new ApiError(400, "This lead's OTP is not currently locked");

  await prisma.lead.update({
    where: { id: leadId },
    data: { otpOverrideRequestedByPartner: true, otpOverrideRequestedAt: new Date() },
  });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  if (admins.length > 0) {
    await broadcastNotification({
      userIds: admins.map((a) => a.id),
      title: 'OTP override requested',
      message: `A partner requested an OTP unlock for a locked lead (buyer: ${lead.buyerName}).`,
      type: 'OTP_OVERRIDE_REQUESTED',
    });
  }

  return { message: 'Admin has been notified.' };
}

async function verifyOtp(leadId, partnerId, inputOtp, ip) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!lead.siteVisitOTP) throw new ApiError(400, 'No OTP generated for this lead');
  if (isLocked(lead.otpLockedUntil)) throw new ApiError(429, 'OTP locked. Contact Admin to override.', { code: 'LEAD_OTP_LOCKED' }); // BE-21
  if (isExpired(lead.otpExpiresAt)) throw new ApiError(400, 'OTP has expired');

  // B15 — checked before the OTP comparison so an early attempt never burns
  // one of the three tries.
  const earlyWindowHours = await getConfigNumber('visit_otp_early_window_hours', DEFAULT_EARLY_WINDOW_HOURS);
  if (isVisitTooEarly(lead.siteVisitScheduledAt, Date.now(), earlyWindowHours)) {
    throw new ApiError(400, `The visit is scheduled for ${new Date(lead.siteVisitScheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST. You can verify the OTP from ${earlyWindowHours} hour(s) before that.`, { code: 'VISIT_NOT_STARTED' });
  }

  if (lead.siteVisitOTP !== inputOtp) {
    const newAttempts = lead.otpAttempts + 1;
    const locked = maxAttemptsReached(newAttempts) ? lockUntil() : null;
    await prisma.lead.update({
      where: { id: leadId },
      data: { otpAttempts: newAttempts, otpLockedUntil: locked },
    });
    if (locked) throw new ApiError(429, 'Maximum OTP attempts reached. Lead is locked. Contact Admin.', { code: 'LEAD_OTP_LOCKED' }); // BE-21
    // BE-21 — LEAD_OTP_INVALID with attemptsLeft, instead of only encoding
    // it into the message text (which the FE must never parse).
    throw new ApiError(400, `Incorrect OTP. ${MAX_ATTEMPTS - newAttempts} attempt(s) remaining.`, { code: 'LEAD_OTP_INVALID', attemptsLeft: MAX_ATTEMPTS - newAttempts });
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      isOtpVerified: true,
      otpVerifiedAt: new Date(),
      status: 'SITE_VISIT_DONE',
      siteVisitOTP: null,
      // 6.7 — verifying the OTP IS the contact-reveal event, so record who
      // did it and from where. Admin's deal-flow view needs this to answer
      // "who saw this buyer's number".
      contactRevealedAt: new Date(),
      contactRevealedByPartnerId: partnerId,
      contactRevealedIp: ip ?? null,
    },
  });

  // B16 — admins had no signal that the visit happened.
  await notifyAdmins({
    title: 'Site visit logged',
    message: `${lead.refCode || 'A lead'} · ${lead.buyerName}: the partner verified the visit OTP.`,
    type: 'VISIT_LOGGED',
    linkUrl: `/admin/leads/${leadId}`,
  });
  if (lead.buyerId) {
    await createNotification({
      userId: lead.buyerId,
      title: 'Site visit confirmed',
      message: `Your site visit for ${lead.refCode || 'your inquiry'} has been confirmed.`,
      type: 'VISIT_LOGGED',
      linkUrl: `/user/inquiries/${leadId}`,
    }).catch(() => null);
  }

  return {
    message: 'OTP verified. Buyer contact revealed.',
    buyerPhone: updated.buyerPhone,
    revealedAt: updated.contactRevealedAt,
  };
}

async function uploadDocs(leadId, partnerId, data, fileUrls) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');

  // Previously returned the raw update result — unmasked buyerPhone/
  // buyerEmail and the live siteVisitOTP, regardless of isOtpVerified. A
  // partner could call this right after assignment (no OTP needed) to read
  // both the buyer's real contact details and the site-visit OTP itself.
  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      visitNotes: data.visitNotes,
      partnerNotes: data.partnerNotes,
      ...(fileUrls.visitPhotos ? { visitPhotoUrls: { push: fileUrls.visitPhotos } } : {}),
      ...(fileUrls.closureDocs ? { closureDocumentUrls: { push: fileUrls.closureDocs } } : {}),
      // B5.3/B5.4 — single-file slots, not arrays: there is one allocation
      // letter and one token receipt per deal, and closeLead gates on the
      // letter being present. Re-uploading replaces.
      ...(fileUrls.allocationLetter ? {
        allocationLetterUrl: fileUrls.allocationLetter,
        allocationLetterUploadedAt: new Date(),
      } : {}),
      ...(fileUrls.tokenReceipt ? { tokenReceiptUrl: fileUrls.tokenReceipt } : {}),
    },
  });
  return sanitizeLeadForPartner(updated);
}

// B4.12 — partner reports what came of the visit. Informational only: it
// never moves lead.status, so it can't be used to sidestep closeLead's
// Rule 6 escrow gate or requestDrop's admin approval.
async function updateVisitOutcome(leadId, partnerId, { outcome, note }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (['CLOSED', 'DROPPED'].includes(lead.status)) {
    throw new ApiError(400, `This lead is already ${lead.status.toLowerCase()}`);
  }
  // An outcome only means something once the visit actually happened, which
  // is exactly what the OTP proves.
  if (!lead.isOtpVerified) {
    throw new ApiError(400, 'Verify the site-visit OTP before reporting an outcome', { code: 'OTP_NOT_VERIFIED' });
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      visitOutcome: outcome,
      visitOutcomeAt: new Date(),
      ...(note !== undefined && { partnerNotes: note }),
    },
  });
  return sanitizeLeadForPartner(updated);
}

async function closeLead(leadId, partnerId, { closingPrice } = {}) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, assignedPartnerId: partnerId },
    include: { escrowTransactions: true },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');

  // Rule 6: A HELD escrow with a captured payment is required before closing
  const heldEscrow = lead.escrowTransactions.find((e) => e.status === 'HELD' && e.razorpayPaymentId);
  if (!heldEscrow) throw new ApiError(400, 'Escrow payment must be captured (HELD) before closing a deal (PRD Rule 6)');

  // Rule 7: CLOSED is irreversible by partner
  if (lead.status === 'CLOSED') throw new ApiError(400, 'Lead is already closed');

  // B5.3 — the allocation letter is mandatory before a deal can close. This
  // gate existed only in the frontend until now, so a direct API call could
  // close a deal with no letter on file at all. Upload it via
  // PATCH /leads/partner/:id/document (field name `allocationLetter`).
  if (!lead.allocationLetterUrl) {
    throw new ApiError(400, 'Upload the allocation letter before closing this deal', { code: 'ALLOCATION_LETTER_REQUIRED' });
  }

  await prisma.lead.update({
    where: { id: leadId },
    data: { status: 'CLOSED', closedAt: new Date(), ...(closingPrice !== undefined && { closingPrice }) },
  });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await Promise.all(admins.map((admin) => createNotification({
    userId: admin.id,
    title: 'Deal Closed — Escrow Review Needed',
    // B44 — the readable ref code, not the Mongo id.
    message: `Lead ${lead.refCode || `#${leadId}`} has been marked as closed. Review escrow release.`,
    type: 'DEAL_CLOSED',
    linkUrl: `/admin/leads/${leadId}`,
  })));

  // B34 — the buyer saw the inquiry card change but got no bell entry.
  if (lead.buyerId) {
    await createNotification({
      userId: lead.buyerId,
      title: 'Deal Closed',
      message: `${lead.refCode || 'Your inquiry'} has been marked as closed by your partner. Admin is reviewing the escrow release.`,
      type: 'DEAL_CLOSED',
      linkUrl: `/user/inquiries/${leadId}`,
    }).catch(() => null);
  }

  return { message: 'Lead marked as closed. Admin will review escrow release.' };
}

// ─── DROP FLOW ───────────────────────────────────────────────────────────────

async function requestDrop(leadId, partnerId, reason) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (['CLOSED', 'DROPPED'].includes(lead.status)) {
    throw new ApiError(400, `Cannot request a drop on a ${lead.status.toLowerCase()} lead`);
  }
  if (lead.dropRequestedByPartner) throw new ApiError(400, 'A drop request is already pending for this lead');

  await prisma.lead.update({
    where: { id: leadId },
    data: { dropRequestedByPartner: true, dropRequestNote: reason, dropRequestedAt: new Date() },
  });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await Promise.all(admins.map((admin) => createNotification({
    userId: admin.id,
    title: 'Lead Drop Requested',
    message: `Partner has requested to drop ${lead.refCode || `Lead #${leadId}`}. Reason: ${reason}`,
    type: 'LEAD_DROP_REQUESTED',
    linkUrl: `/admin/leads/${leadId}`,
  })));

  return { message: 'Drop request submitted. Admin will review.' };
}

// Admin marks the partner's uploaded allocation letter as verified. This, not the upload, is the point after which
// the buyer can no longer cancel for a refund (money model Rev 3, 2.2). Idempotent: a second call changes nothing.
async function adminVerifyAllocationLetter(leadId, adminId, ip) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!lead.allocationLetterUrl) throw new ApiError(400, 'No allocation letter has been uploaded for this lead', { code: 'NO_ALLOCATION_LETTER' });
  if (lead.allocationLetterVerifiedAt) return lead;

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: { allocationLetterVerifiedAt: new Date(), allocationLetterVerifiedBy: adminId },
  });
  if (lead.buyerId) {
    await createNotification({
      userId: lead.buyerId,
      title: 'Allocation letter verified',
      message: `The allocation letter for ${lead.refCode || 'your deal'} has been verified. Your token now stays in escrow until the deal is released; a refund is no longer available here. If something is wrong, raise a dispute.`,
      type: 'ALLOCATION_LETTER_VERIFIED',
      linkUrl: `/user/inquiries/${leadId}`,
    }).catch((err) => logger.warn('[Lead] letter-verified notification failed', { leadId, error: err.message }));
  }
  await createAuditLog({
    adminId, action: 'ALLOCATION_LETTER_VERIFIED', targetType: 'Lead', targetId: leadId,
    before: { allocationLetterVerifiedAt: null }, after: { allocationLetterVerifiedAt: updated.allocationLetterVerifiedAt },
    ipAddress: ip,
  });
  return updated;
}

async function adminApproveDrop(leadId, adminId, ip) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!lead.dropRequestedByPartner) throw new ApiError(400, 'No pending drop request for this lead');
  if (lead.status === 'DROPPED') throw new ApiError(400, 'Lead is already dropped');

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'DROPPED',
      droppedAt: new Date(),
      droppedByAdminId: adminId,
      droppedReason: lead.dropRequestNote,
      dropRequestedByPartner: false,
    },
  });

  if (lead.assignedPartnerId) {
    await createNotification({
      userId: lead.assignedPartnerId,
      title: 'Drop Request Approved',
      message: `Your drop request for ${lead.refCode || `Lead #${leadId}`} has been approved.`,
      type: 'LEAD_DROPPED',
      linkUrl: `/partners/leads/${leadId}`,
    });
  }

  await createAuditLog({
    adminId, action: 'LEAD_DROPPED', targetType: 'Lead', targetId: leadId,
    before: { status: lead.status },
    after: { status: 'DROPPED', droppedReason: lead.dropRequestNote },
    ipAddress: ip,
  });

  return updated;
}

async function adminRejectDrop(leadId, adminId, ip) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!lead.dropRequestedByPartner) throw new ApiError(400, 'No pending drop request for this lead');

  await prisma.lead.update({
    where: { id: leadId },
    data: { dropRequestedByPartner: false, dropRequestNote: null, dropRequestedAt: null },
  });

  if (lead.assignedPartnerId) {
    await createNotification({
      userId: lead.assignedPartnerId,
      title: 'Drop Request Rejected',
      message: `Your drop request for ${lead.refCode || `Lead #${leadId}`} has been rejected. Please continue working the lead.`,
      type: 'LEAD_DROP_REJECTED',
      linkUrl: `/partners/leads/${leadId}`,
    });
  }

  await createAuditLog({
    adminId, action: 'LEAD_DROP_REJECTED', targetType: 'Lead', targetId: leadId,
    after: { dropRequestRejected: true }, ipAddress: ip,
  });

  return { message: 'Drop request rejected. Partner notified.' };
}

module.exports = { evaluateBuyerOwnership, submitLead, sanitizeLeadForBuyer, stalledInfoFor, updateVisitOutcome, partnerAddLead, getPartnerLeads, getPartnerLeadById, scheduleVisit, resendOtp, requestOtpOverride, verifyOtp, uploadDocs, closeLead, requestDrop, adminApproveDrop, adminRejectDrop, adminVerifyAllocationLetter };
