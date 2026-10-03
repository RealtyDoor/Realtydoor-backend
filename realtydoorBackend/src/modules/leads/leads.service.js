const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { formatContact, maskPhone, maskEmail } = require('../../lib/phoneUtils');
const { generate, expiresAt, isExpired, isLocked, lockUntil, maxAttemptsReached } = require('../../lib/otp');
const { sendSiteVisitOtp } = require('../../lib/wati');
const { createNotification, broadcastNotification } = require('../../lib/notifications');
const logger = require('../../lib/logger');
const { sendLeadAssigned } = require('../../lib/email');
const { createAuditLog } = require('../../lib/auditLog');
const { getConfigNumber } = require('../config/config.service');
const { nextRefCode } = require('../../lib/refCode');

const DEFAULT_MAX_ACTIVE_INQUIRIES = 5;
const DEFAULT_MAX_INQUIRIES_PER_DAY = 3;
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

// Internal-only fields a buyer never needs: admin/partner free-text notes,
// OTP attempt bookkeeping, and the full commission/drop-request workflow
// state. siteVisitOTP is deliberately kept — the buyer is the one who reads
// it out to the partner at the site-visit gate.
const BUYER_HIDDEN_LEAD_FIELDS = [
  'adminNotes', 'partnerNotes', 'visitNotes', 'otpAttempts',
  'platformCommissionPct', 'commissionAmountPaise', 'commissionStatus', 'invoiceUrl', 'invoicedAt', 'collectedAt',
  'dropRequestedByPartner', 'dropRequestNote', 'dropRequestedAt', 'droppedReason', 'droppedAt', 'droppedByAdminId',
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

// `buyer` is only present when the caller's query included it (getPartnerLeads/
// getPartnerLeadById do; a bare prisma.lead.update() result, like uploadDocs
// returns, does not) — buyerRef/buyerPhoneVerified just come out undefined
// (and get dropped by JSON.stringify) in that case, same as if the fields
// never existed.
function sanitizeLeadForPartner(lead) {
  const { buyer, ...rest } = lead;
  return {
    ...rest,
    buyerPhone: formatContact(lead.buyerPhone, lead.isOtpVerified, maskPhone),
    buyerEmail: formatContact(lead.buyerEmail, lead.isOtpVerified, maskEmail),
    buyerRef: buyer?.refCode,
    buyerPhoneVerified: buyer?.phoneVerified,
    siteVisitOTP: undefined, // never expose OTP in response
    adminNotes: undefined, // admin-internal, never expose to partner
  };
}

const PARTNER_LEAD_BUYER_SELECT = { select: { refCode: true, phoneVerified: true } };

async function getPartnerLeads(partnerId) {
  // Rule 2: Partner sees only their assigned leads
  const leads = await prisma.lead.findMany({
    where: { assignedPartnerId: partnerId },
    include: {
      property: { select: { title: true, slug: true, locality: true, city: true } },
      buyer: PARTNER_LEAD_BUYER_SELECT,
    },
    orderBy: { createdAt: 'desc' },
  });
  return leads.map(sanitizeLeadForPartner);
}

async function getPartnerLeadById(leadId, partnerId) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, assignedPartnerId: partnerId },
    include: { property: true, buyer: PARTNER_LEAD_BUYER_SELECT },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  return sanitizeLeadForPartner(lead);
}

async function scheduleVisit(leadId, partnerId, scheduledAt) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.status === 'CLOSED') throw new ApiError(400, 'Cannot schedule visit on a closed lead');

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
    throw new ApiError(429, 'OTP is locked after too many failed attempts. Request an admin override instead.');
  }

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

async function verifyOtp(leadId, partnerId, inputOtp) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, assignedPartnerId: partnerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!lead.siteVisitOTP) throw new ApiError(400, 'No OTP generated for this lead');
  if (isLocked(lead.otpLockedUntil)) throw new ApiError(429, 'OTP locked. Contact Admin to override.');
  if (isExpired(lead.otpExpiresAt)) throw new ApiError(400, 'OTP has expired');

  if (lead.siteVisitOTP !== inputOtp) {
    const newAttempts = lead.otpAttempts + 1;
    const locked = maxAttemptsReached(newAttempts) ? lockUntil() : null;
    await prisma.lead.update({
      where: { id: leadId },
      data: { otpAttempts: newAttempts, otpLockedUntil: locked },
    });
    if (locked) throw new ApiError(429, 'Maximum OTP attempts reached. Lead is locked. Contact Admin.');
    throw new ApiError(400, `Incorrect OTP. ${MAX_ATTEMPTS - newAttempts} attempt(s) remaining.`);
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      isOtpVerified: true,
      otpVerifiedAt: new Date(),
      status: 'SITE_VISIT_DONE',
      siteVisitOTP: null,
    },
  });

  return { message: 'OTP verified. Buyer contact revealed.', buyerPhone: updated.buyerPhone };
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
    },
  });
  return sanitizeLeadForPartner(updated);
}

async function closeLead(leadId, partnerId) {
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

  await prisma.lead.update({ where: { id: leadId }, data: { status: 'CLOSED' } });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await Promise.all(admins.map((admin) => createNotification({
    userId: admin.id,
    title: 'Deal Closed — Escrow Review Needed',
    message: `Lead #${leadId} has been marked as closed. Review escrow release.`,
    type: 'DEAL_CLOSED',
    linkUrl: `/admin/leads/${leadId}`,
  })));

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
    message: `Partner has requested to drop Lead #${leadId}. Reason: ${reason}`,
    type: 'LEAD_DROP_REQUESTED',
    linkUrl: `/admin/leads/${leadId}`,
  })));

  return { message: 'Drop request submitted. Admin will review.' };
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
      message: `Your drop request for Lead #${leadId} has been approved.`,
      type: 'LEAD_DROPPED',
      linkUrl: `/partner/leads/${leadId}`,
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
      message: `Your drop request for Lead #${leadId} has been rejected. Please continue working the lead.`,
      type: 'LEAD_DROP_REJECTED',
      linkUrl: `/partner/leads/${leadId}`,
    });
  }

  await createAuditLog({
    adminId, action: 'LEAD_DROP_REJECTED', targetType: 'Lead', targetId: leadId,
    after: { dropRequestRejected: true }, ipAddress: ip,
  });

  return { message: 'Drop request rejected. Partner notified.' };
}

module.exports = { submitLead, sanitizeLeadForBuyer, getPartnerLeads, getPartnerLeadById, scheduleVisit, resendOtp, requestOtpOverride, verifyOtp, uploadDocs, closeLead, requestDrop, adminApproveDrop, adminRejectDrop };
