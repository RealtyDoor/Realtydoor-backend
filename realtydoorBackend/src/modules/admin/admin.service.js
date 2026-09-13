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
const { sendLeadAssignedNotice } = require('../../lib/wati');
const { setUserRole } = require('../../lib/clerkAdmin');
const logger = require('../../lib/logger');
const { cacheDel } = require('../../lib/cache');
const CACHE_KEYS = require('../../lib/cacheKeys');

// ─── LEAD MANAGEMENT ─────────────────────────────────────────────────────────

async function getLeadById(leadId) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      property:        { select: { title: true, slug: true, city: true, locality: true } },
      assignedPartner: { select: { name: true, email: true, phone: true, companyName: true } },
      escrowTransactions: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  return lead;
}

async function getAllLeads(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.partnerId) where.assignedPartnerId = filters.partnerId;

  const [data, total] = await Promise.all([
    prisma.lead.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        property: { select: { title: true, slug: true, city: true } },
        assignedPartner: { select: { name: true, email: true } },
      },
    }),
    prisma.lead.count({ where }),
  ]);

  return { data, total };
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

  // Buyer: in-app notification (if registered) + email
  if (lead.buyerId) {
    await createNotification({
      userId: lead.buyerId,
      title: 'Your Inquiry is Being Processed',
      message: `Your inquiry for "${lead.property.title}" has been matched with a verified partner. You will be contacted shortly.`,
      type: 'LEAD_ASSIGNED',
      linkUrl: '/dashboard/leads',
    });
  }
  sendLeadInquiryConfirmed(lead.buyerEmail, lead.property.title).catch(() => {});

  return updated;
}

// ─── PROPERTY APPROVAL ───────────────────────────────────────────────────────

async function getPendingProperties(skip, limit) {
  const [data, total] = await Promise.all([
    prisma.property.findMany({
      where: { publishStatus: 'PENDING_APPROVAL' },
      skip, take: limit,
      include: { partner: { select: { name: true, email: true, companyName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.property.count({ where: { publishStatus: 'PENDING_APPROVAL' } }),
  ]);
  return { data, total };
}

async function approveProperty(propertyId, adminId, ip) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { partner: { select: { email: true } } },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const updated = await prisma.property.update({
    where: { id: propertyId },
    data: { publishStatus: 'APPROVED', rejectionNote: null },
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
    before: { publishStatus: 'PENDING_APPROVAL' }, after: { publishStatus: 'APPROVED' },
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
  if (filters.status) where.status = filters.status;
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

async function updateLoanStatus(loanId, status, adminNote, adminId) {
  const loan = await prisma.loanApplication.findUnique({
    where: { id: loanId },
    include: { user: { select: { email: true } } },
  });
  if (!loan) throw new ApiError(404, 'Loan application not found');

  const extraFields = {};
  if (status === 'SANCTIONED') extraFields.sanctionedAt = new Date();
  if (status === 'DISBURSED')  extraFields.disbursedAt  = new Date();

  const updated = await prisma.loanApplication.update({
    where: { id: loanId },
    data: { status, adminNote: adminNote || loan.adminNote, ...extraFields },
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
  const where = {};
  if (filters.role)   where.role = filters.role;
  if (filters.search) where.OR   = [
    { name:  { contains: filters.search, mode: 'insensitive' } },
    { email: { contains: filters.search, mode: 'insensitive' } },
  ];

  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where, skip, take: limit,
      select: { id: true, name: true, email: true, phone: true, phoneVerified: true, role: true, kycStatus: true, partnerSubType: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  return { data, total };
}

async function changeUserRole(targetUserId, newRole, adminId, ip) {
  if (targetUserId === adminId) throw new ApiError(400, 'Cannot change your own role');

  const VALID_ROLES = ['USER', 'PARTNER', 'ADMIN'];
  if (!VALID_ROLES.includes(newRole)) throw new ApiError(400, 'Invalid role');

  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw new ApiError(404, 'User not found');

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data:  { role: newRole },
    select: { id: true, name: true, email: true, role: true, clerkId: true },
  });

  await setUserRole(user.clerkId, newRole).catch((err) =>
    logger.warn('[changeUserRole] Clerk publicMetadata sync failed', { clerkId: user.clerkId, error: err.message })
  );

  await createAuditLog({
    adminId, action: 'ROLE_CHANGED', targetType: 'User', targetId: targetUserId,
    before: { role: user.role }, after: { role: newRole },
    ipAddress: ip,
  });

  return updated;
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
    },
  });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  return ticket;
}

async function getAllTickets(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.userId) where.userId = filters.userId;

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

async function getPartnerById(partnerId) {
  const partner = await prisma.user.findFirst({
    where: { id: partnerId, role: 'PARTNER' },
    select: {
      id: true, name: true, email: true, phone: true, companyName: true,
      partnerSubType: true, bio: true, profileImageUrl: true, websiteUrl: true,
      kycStatus: true, kycRejectionNote: true, kycVerifiedAt: true,
      isPremiumPartner: true, premiumValidUntil: true,
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
    ...partner,
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

  const [data, total] = await Promise.all([
    prisma.contactMessage.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true, email: true, role: true } } },
    }),
    prisma.contactMessage.count({ where }),
  ]);
  return { data, total };
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
  getLeadById, getAllLeads, assignLead,
  getPendingProperties, approveProperty, rejectProperty, editProperty,
  getPendingKyc, verifyKyc,
  getRevenueSummary,
  getAuditLogs,
  getAllTickets, getTicketById, updateTicketStatus,
  getAllLoans, updateLoanStatus,
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
