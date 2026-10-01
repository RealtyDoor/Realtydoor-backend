const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { formatPhone } = require('../../lib/phoneUtils');
const { generate, expiresAt, isExpired, isLocked, lockUntil, maxAttemptsReached } = require('../../lib/otp');
const { sendSiteVisitOtp } = require('../../lib/wati');
const { createNotification, broadcastNotification } = require('../../lib/notifications');
const logger = require('../../lib/logger');
const { sendLeadAssigned } = require('../../lib/email');
const { createAuditLog } = require('../../lib/auditLog');

async function submitLead(data, buyerId) {
  const property = await prisma.property.findUnique({ where: { id: data.propertyId }, select: { id: true, title: true, publishStatus: true } });
  if (!property) throw new ApiError(404, 'Property not found');
  if (property.publishStatus !== 'APPROVED') throw new ApiError(400, 'This property is not currently available for enquiry');

  const existing = await prisma.lead.findFirst({
    where: { propertyId: data.propertyId, buyerPhone: data.buyerPhone, status: { not: 'DROPPED' } },
  });
  if (existing) throw new ApiError(409, 'You have already submitted an enquiry for this property');

  // Rate limit: 30-min cooldown between any submissions from the same phone
  const cooloffCutoff = new Date(Date.now() - 30 * 60 * 1000);
  const recentLead = await prisma.lead.findFirst({
    where: { buyerPhone: data.buyerPhone, createdAt: { gte: cooloffCutoff } },
    orderBy: { createdAt: 'desc' },
  });
  if (recentLead) throw new ApiError(429, 'Please wait 30 minutes before submitting another inquiry');

  // Rate limit: max 5 inquiries per calendar day per phone
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayCount = await prisma.lead.count({
    where: { buyerPhone: data.buyerPhone, createdAt: { gte: dayStart } },
  });
  if (todayCount >= 5) throw new ApiError(429, 'Maximum 5 inquiries allowed per day');

  const lead = await prisma.lead.create({
    data: { ...data, status: 'UNASSIGNED', ...(buyerId && { buyerId }) },
  });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await broadcastNotification({
    userIds: admins.map((admin) => admin.id),
    title: 'New Unassigned Lead',
    message: `${data.buyerName} enquired about "${property.title}".`,
    type: 'LEAD_NEW',
    linkUrl: `/admin/leads/${lead.id}`,
  });

  return lead;
}

function sanitizeLeadForPartner(lead) {
  return {
    ...lead,
    buyerPhone: formatPhone(lead.buyerPhone, lead.isOtpVerified),
    siteVisitOTP: undefined, // never expose OTP in response
  };
}

async function getPartnerLeads(partnerId) {
  // Rule 2: Partner sees only their assigned leads
  const leads = await prisma.lead.findMany({
    where: { assignedPartnerId: partnerId },
    include: { property: { select: { title: true, slug: true, locality: true, city: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return leads.map(sanitizeLeadForPartner);
}

async function getPartnerLeadById(leadId, partnerId) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, assignedPartnerId: partnerId },
    include: { property: true },
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

  return prisma.lead.update({
    where: { id: leadId },
    data: {
      visitNotes: data.visitNotes,
      partnerNotes: data.partnerNotes,
      ...(fileUrls.visitPhotos ? { visitPhotoUrls: { push: fileUrls.visitPhotos } } : {}),
      ...(fileUrls.closureDocs ? { closureDocumentUrls: { push: fileUrls.closureDocs } } : {}),
    },
  });
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

module.exports = { submitLead, getPartnerLeads, getPartnerLeadById, scheduleVisit, resendOtp, requestOtpOverride, verifyOtp, uploadDocs, closeLead, requestDrop, adminApproveDrop, adminRejectDrop };
