const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');

async function submitKyc(partnerId, documentUrls) {
  if (!documentUrls || documentUrls.length === 0) throw new ApiError(400, 'At least one KYC document is required');

  const user = await prisma.user.findUnique({ where: { id: partnerId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.kycStatus === 'VERIFIED') throw new ApiError(400, 'KYC already verified');
  if (user.kycStatus === 'PENDING_REVIEW') throw new ApiError(400, 'KYC is already under review');

  const updated = await prisma.user.update({
    where: { id: partnerId },
    data: { kycStatus: 'PENDING_REVIEW', kycDocumentUrls: documentUrls },
  });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  for (const admin of admins) {
    await createNotification({
      userId: admin.id,
      title: 'New KYC Pending Review',
      message: `Partner ${user.name} submitted KYC documents.`,
      type: 'KYC_PENDING',
      linkUrl: `/admin/kyc`,
    });
  }

  return updated;
}

async function getProfile(partnerId) {
  return prisma.user.findUnique({
    where: { id: partnerId },
    select: {
      id: true, name: true, email: true, phone: true, companyName: true,
      bio: true, profileImageUrl: true, websiteUrl: true, partnerSubType: true,
      kycStatus: true, kycRejectionNote: true, kycVerifiedAt: true, createdAt: true,
    },
  });
}

async function updateProfile(partnerId, data) {
  const FORBIDDEN = ['role', 'kycStatus', 'kycDocumentUrls', 'email'];
  FORBIDDEN.forEach((f) => delete data[f]);
  return prisma.user.update({ where: { id: partnerId }, data });
}

async function uploadProfilePhoto(partnerId, url) {
  return prisma.user.update({
    where: { id: partnerId },
    data: { profileImageUrl: url },
    select: { id: true, profileImageUrl: true },
  });
}

async function getListing(partnerId, id) {
  const property = await prisma.property.findFirst({ where: { id, partnerId } });
  if (!property) throw new ApiError(404, 'Listing not found');
  return property;
}

async function getMyListings(partnerId, status) {
  const where = { partnerId };
  if (status) where.publishStatus = status;
  return prisma.property.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, title: true, slug: true, publishStatus: true, rejectionNote: true,
      propertyType: true, listingType: true, city: true, locality: true,
      price: true, bhk: true, images: true, createdAt: true, facing: true, furnishing: true,
    },
  });
}

async function getFinanceSummary(partnerId) {
  const now          = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalLeads, allEscrows, thisMonthEscrows] = await Promise.all([
    prisma.lead.count({ where: { assignedPartnerId: partnerId } }),
    prisma.escrowTransaction.findMany({
      where: { lead: { assignedPartnerId: partnerId } },
      select: { status: true, amount: true, releasedAt: true, heldAt: true },
    }),
    prisma.escrowTransaction.findMany({
      where: {
        lead: { assignedPartnerId: partnerId },
        status: 'RELEASED',
        releasedAt: { gte: startOfMonth },
      },
      select: { amount: true },
    }),
  ]);

  const heldEscrows     = allEscrows.filter((e) => e.status === 'HELD');
  const releasedEscrows = allEscrows.filter((e) => e.status === 'RELEASED');

  return {
    totalLeads,
    closedDeals:         releasedEscrows.length,
    escrowHeld:          heldEscrows.reduce((s, e) => s + e.amount, 0),
    pendingCount:        heldEscrows.length,
    releasedTotal:       releasedEscrows.reduce((s, e) => s + e.amount, 0),
    releasedThisMonth:   thisMonthEscrows.reduce((s, e) => s + e.amount, 0),
    payoutCountThisMonth: thisMonthEscrows.length,
  };
}

// ─── RATINGS ─────────────────────────────────────────────────────────────────
// Backed by Lead.buyerRating/buyerRatingComment (set via POST /user/leads/:leadId/rating)
// — no separate PartnerRating model needed, each Lead already scopes one buyer's
// rating to one partner.

async function getRatings(partnerId) {
  const rated = await prisma.lead.findMany({
    where: { assignedPartnerId: partnerId, buyerRating: { not: null } },
    select: { id: true, buyerRating: true, buyerRatingComment: true, buyerRatedAt: true, buyerName: true },
    orderBy: { buyerRatedAt: 'desc' },
  });

  const average = rated.length
    ? Math.round((rated.reduce((sum, r) => sum + r.buyerRating, 0) / rated.length) * 10) / 10
    : null;

  return {
    average,
    count: rated.length,
    ratings: rated.map((r) => ({
      leadId: r.id, rating: r.buyerRating, comment: r.buyerRatingComment,
      ratedAt: r.buyerRatedAt, buyerName: r.buyerName,
    })),
  };
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────

const SETTINGS_FIELDS = [
  'visitDays', 'visitFromTime', 'visitToTime',
  'notifNewLead', 'notifLeadExpiring', 'notifEscrowReleased', 'notifListingUpdate', 'notifWeeklyReport',
  'leadAutoAccept', 'leadPauseOverloaded', 'leadPreferredLocalities',
];

async function getSettings(partnerId) {
  return prisma.user.findUnique({
    where: { id: partnerId },
    select: Object.fromEntries(SETTINGS_FIELDS.map((f) => [f, true])),
  });
}

async function updateSettings(partnerId, data) {
  return prisma.user.update({
    where: { id: partnerId },
    data,
    select: Object.fromEntries(SETTINGS_FIELDS.map((f) => [f, true])),
  });
}

// ─── BANK ACCOUNT ─────────────────────────────────────────────────────────────

const BANK_FIELDS = ['bankName', 'bankBranch', 'bankAccountNo', 'bankIfsc', 'bankHolderName', 'razorpayRouteAccountId', 'bankLinkedAt'];

async function getBankAccount(partnerId) {
  return prisma.user.findUnique({
    where: { id: partnerId },
    select: Object.fromEntries(BANK_FIELDS.map((f) => [f, true])),
  });
}

async function updateBankAccount(partnerId, data) {
  return prisma.user.update({
    where: { id: partnerId },
    data: { ...data, bankLinkedAt: new Date() },
    select: Object.fromEntries(BANK_FIELDS.map((f) => [f, true])),
  });
}

// ─── PARTNER SUPPORT TICKETS ──────────────────────────────────────────────────

async function getSupportTickets(partnerId, filters, skip, limit) {
  const where = { partnerId };
  if (filters.status) where.status = filters.status;

  const [data, total] = await Promise.all([
    prisma.partnerSupportTicket.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.partnerSupportTicket.count({ where }),
  ]);
  return { data, total };
}

async function getSupportTicketById(partnerId, ticketId) {
  const ticket = await prisma.partnerSupportTicket.findFirst({
    where: { id: ticketId, partnerId },
  });
  if (!ticket) throw new ApiError(404, 'Support ticket not found');
  return ticket;
}

async function createSupportTicket(partnerId, data) {
  const count    = await prisma.partnerSupportTicket.count();
  const ticketNo = `SUP-${String(count + 1).padStart(4, '0')}`;
  return prisma.partnerSupportTicket.create({
    data: { partnerId, ticketNo, ...data },
  });
}

async function getPartnerAnalytics(partnerId) {
  const now              = new Date();
  const startOfMonth     = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  const [allLeads, allListings, thisMonthCount, lastMonthCount] = await Promise.all([
    prisma.lead.findMany({
      where: { assignedPartnerId: partnerId },
      select: {
        status: true,
        isOtpVerified: true,
        dropRequestedByPartner: true,
        buyerFeedbackStatus: true,
        escrowTransactions: { select: { status: true, amount: true } },
      },
    }),
    prisma.property.findMany({
      where: { partnerId },
      select: { publishStatus: true },
    }),
    prisma.lead.count({
      where: { assignedPartnerId: partnerId, createdAt: { gte: startOfMonth } },
    }),
    prisma.lead.count({
      where: { assignedPartnerId: partnerId, createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } },
    }),
  ]);

  // ── Lead aggregations ──────────────────────────────────────────────────────
  const leadByStatus     = {};
  const feedbackByStatus = { PENDING: 0, VERIFIED_CLOSED: 0, VERIFIED_DROPPED: 0, STILL_DECIDING: 0, NO_RESPONSE: 0 };
  let pendingDropRequests = 0;
  let otpVerified  = 0;
  let heldAmount   = 0;
  let releasedAmount = 0;

  for (const lead of allLeads) {
    leadByStatus[lead.status] = (leadByStatus[lead.status] || 0) + 1;
    if (lead.buyerFeedbackStatus) {
      feedbackByStatus[lead.buyerFeedbackStatus] = (feedbackByStatus[lead.buyerFeedbackStatus] || 0) + 1;
    }
    if (lead.dropRequestedByPartner) pendingDropRequests++;
    if (lead.isOtpVerified)          otpVerified++;
    for (const tx of lead.escrowTransactions || []) {
      if (tx.status === 'HELD')     heldAmount     += tx.amount;
      if (tx.status === 'RELEASED') releasedAmount += tx.amount;
    }
  }

  // ── Listing aggregations ───────────────────────────────────────────────────
  const listingByStatus = {};
  for (const l of allListings) {
    listingByStatus[l.publishStatus] = (listingByStatus[l.publishStatus] || 0) + 1;
  }

  const total  = allLeads.length;
  const closed = leadByStatus.CLOSED  || 0;
  const dropped = leadByStatus.DROPPED || 0;

  return {
    leads: {
      total,
      byStatus: leadByStatus,
      pendingDropRequests,
      otpVerified,
      thisMonth:      thisMonthCount,
      lastMonth:      lastMonthCount,
      conversionRate: total ? +(closed  / total).toFixed(2) : 0,
      dropRate:       total ? +(dropped / total).toFixed(2) : 0,
    },
    listings: {
      total: allListings.length,
      byStatus: listingByStatus,
    },
    buyerFeedback: feedbackByStatus,
    escrow: {
      heldAmount,
      releasedAmount,
    },
  };
}

module.exports = {
  submitKyc, getProfile, updateProfile, uploadProfilePhoto, getListing, getMyListings,
  getFinanceSummary, getRatings,
  getSettings, updateSettings,
  getBankAccount, updateBankAccount,
  getSupportTickets, getSupportTicketById, createSupportTicket,
  getPartnerAnalytics,
};
