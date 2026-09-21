const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { sendPhoneVerificationOtp } = require('../../lib/wati');
const { generate, expiresAt, isExpired, isLocked, lockUntil, maxAttemptsReached, MAX_ATTEMPTS } = require('../../lib/otp');
const logger = require('../../lib/logger');

async function requestPhoneOtp(userId, phone) {
  const duplicate = await prisma.user.findFirst({ where: { phone, NOT: { id: userId } } });
  if (duplicate) throw new ApiError(409, 'Phone number already registered to another account');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (isLocked(user.phoneOtpLockedUntil)) {
    throw new ApiError(429, 'Too many attempts. Try again in 30 minutes.');
  }

  const otp = generate();
  await prisma.user.update({
    where: { id: userId },
    data: {
      phone,
      phoneVerified:       false,
      phoneOtp:            otp,
      phoneOtpExpiresAt:   expiresAt(),
      phoneOtpAttempts:    0,
      phoneOtpLockedUntil: null,
    },
  });

  try {
    await sendPhoneVerificationOtp(phone, otp);
  } catch (err) {
    if (process.env.NODE_ENV === 'production') throw err;
    logger.warn(`[DEV] WATI send failed — OTP for ${phone}: ${otp}`);
  }
  const dev = process.env.NODE_ENV !== 'production';
  return { message: 'OTP sent via WhatsApp', ...(dev && { _devOtp: otp }) };
}

async function verifyPhoneOtp(userId, otp) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user.phone || !user.phoneOtp) throw new ApiError(400, 'Request an OTP first');

  if (isLocked(user.phoneOtpLockedUntil)) {
    throw new ApiError(429, 'Too many attempts. Try again in 30 minutes.');
  }
  if (isExpired(user.phoneOtpExpiresAt)) {
    throw new ApiError(400, 'OTP expired. Request a new one.');
  }

  if (user.phoneOtp !== otp) {
    const attempts = user.phoneOtpAttempts + 1;
    const locked   = maxAttemptsReached(attempts);
    await prisma.user.update({
      where: { id: userId },
      data: {
        phoneOtpAttempts:    attempts,
        phoneOtpLockedUntil: locked ? lockUntil() : null,
      },
    });
    throw new ApiError(400, locked
      ? `Incorrect OTP. Account locked for 30 minutes after ${MAX_ATTEMPTS} failed attempts.`
      : `Incorrect OTP. ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`
    );
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      phoneVerified:       true,
      phoneVerifiedAt:     new Date(),
      phoneOtp:            null,
      phoneOtpExpiresAt:   null,
      phoneOtpAttempts:    0,
      phoneOtpLockedUntil: null,
    },
  });
  return { phoneVerified: true, phone: user.phone };
}

async function getMyLeads(userId) {
  return prisma.lead.findMany({
    where: { buyerId: userId },
    include: { property: { select: { title: true, slug: true, city: true, images: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

const RATEABLE_STATUSES = ['SITE_VISIT_DONE', 'CLOSED'];

async function rateLead(userId, leadId, { rating, comment }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, buyerId: userId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!RATEABLE_STATUSES.includes(lead.status)) {
    throw new ApiError(400, 'You can rate the partner only after a site visit has taken place');
  }
  if (lead.buyerRating != null) throw new ApiError(409, 'You have already rated this partner for this lead');

  return prisma.lead.update({
    where: { id: leadId },
    data: {
      buyerRating:        rating,
      buyerRatingComment: comment ?? null,
      buyerRatedAt:        new Date(),
    },
  });
}

async function toggleFavorite(userId, propertyId) {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true } });
  if (!property) throw new ApiError(404, 'Property not found');

  const existing = await prisma.favorite.findFirst({ where: { userId, propertyId } });
  if (existing) {
    await prisma.favorite.delete({ where: { id: existing.id } });
    return { favorited: false };
  }
  await prisma.favorite.create({ data: { userId, propertyId } });
  return { favorited: true };
}

async function getFavorites(userId) {
  const favs = await prisma.favorite.findMany({
    where: { userId },
    include: {
      property: {
        select: {
          id: true, title: true, slug: true, price: true, monthlyRent: true,
          propertyType: true, listingType: true, bhk: true, locality: true,
          city: true, images: true, coverImageIndex: true, isVerified: true,
          publishStatus: true, facing: true, furnishing: true,
        },
      },
    },
    orderBy: { savedAt: 'desc' },
  });
  return favs.map((f) => ({ ...f.property, favoritedAt: f.savedAt }));
}

async function updateProfile(userId, data) {
  return prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true, name: true, email: true, phone: true, phoneVerified: true,
      isNRI: true, profileImageUrl: true, role: true, updatedAt: true,
    },
  });
}

async function updateConsent(userId, { termsAccepted, privacyAccepted, marketingOptIn }) {
  const data = {};
  const now = new Date();
  if (termsAccepted)          data.termsAcceptedAt   = now;
  if (privacyAccepted)        data.privacyAcceptedAt = now;
  if (marketingOptIn !== undefined) {
    data.marketingOptIn   = marketingOptIn;
    data.marketingOptInAt = marketingOptIn ? now : null;
  }

  return prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true, termsAcceptedAt: true, privacyAcceptedAt: true,
      marketingOptIn: true, marketingOptInAt: true,
    },
  });
}

function serializeDoc(doc) {
  return { ...doc, uploadedAt: doc.uploadedAt?.toISOString?.() ?? doc.uploadedAt };
}

async function getDocuments(userId) {
  const docs = await prisma.userDocument.findMany({ where: { userId }, orderBy: { uploadedAt: 'desc' } });
  return docs.map(serializeDoc);
}

async function uploadDocument(userId, documentType, fileUrl, fileName) {
  const doc = await prisma.userDocument.create({
    data: { userId, documentType, fileUrl, fileName },
  });
  return serializeDoc(doc);
}

async function getSubscriptions(userId) {
  return prisma.userSubscription.findMany({
    where: { userId },
    include: { tickets: { orderBy: { createdAt: 'desc' } } },
    orderBy: { startDate: 'desc' },
  });
}

async function raiseTicket(userId, subscriptionId, data) {
  const sub = await prisma.userSubscription.findFirst({ where: { id: subscriptionId, userId } });
  if (!sub) throw new ApiError(404, 'Subscription not found');
  if (sub.paymentStatus !== 'SUCCESS') throw new ApiError(400, 'Service not active');

  const { subscriptionId: _sid, ...rest } = data;
  return prisma.serviceTicket.create({
    data: { ...rest, userId, subscriptionId },
  });
}

async function getMyTickets(userId) {
  return prisma.serviceTicket.findMany({
    where: { userId },
    include: { subscription: { include: { service: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
}

async function getMyTicketById(userId, ticketId) {
  const ticket = await prisma.serviceTicket.findFirst({
    where: { id: ticketId, userId },
    include: { subscription: { include: { service: { select: { name: true } } } } },
  });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  return ticket;
}

async function verifyTicket(userId, ticketId) {
  const ticket = await prisma.serviceTicket.findFirst({ where: { id: ticketId, userId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  if (ticket.status !== 'RESOLVED') throw new ApiError(400, 'Ticket is not yet resolved');

  return prisma.serviceTicket.update({
    where: { id: ticketId },
    data: { status: 'VERIFIED_BY_USER', verifiedAt: new Date() },
  });
}

async function createLoanApplication(userId, data) {
  return prisma.loanApplication.create({
    data: { ...data, userId },
  });
}

async function getMyLoanApplications(userId) {
  return prisma.loanApplication.findMany({
    where: { userId },
    include: { property: { select: { title: true, slug: true, city: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

async function getLoanApplicationById(userId, loanId) {
  const loan = await prisma.loanApplication.findFirst({ where: { id: loanId, userId } });
  if (!loan) throw new ApiError(404, 'Loan application not found');
  return loan;
}

async function requestVideoTour(userId, propertyId, userNote) {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, publishStatus: 'APPROVED' },
    select: { id: true },
  });
  if (!property) throw new ApiError(404, 'Property not found');

  const existing = await prisma.videoTourRequest.findFirst({
    where: { userId, propertyId, status: { in: ['PENDING', 'ASSIGNED'] } },
  });
  if (existing) throw new ApiError(409, 'You already have a pending video tour request for this property');

  return prisma.videoTourRequest.create({
    data: { userId, propertyId, userNote },
  });
}

async function getMyVideoTours(userId) {
  return prisma.videoTourRequest.findMany({
    where: { userId },
    include: {
      property: { select: { title: true, slug: true, city: true, images: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

const disputeService = require('../disputes/disputes.service');

module.exports = {
  requestPhoneOtp, verifyPhoneOtp, getMyLeads, rateLead, toggleFavorite, getFavorites, updateProfile,
  updateConsent,
  getDocuments, uploadDocument, getSubscriptions,
  raiseTicket, getMyTickets, getMyTicketById, verifyTicket,
  createLoanApplication, getMyLoanApplications, getLoanApplicationById,
  requestVideoTour, getMyVideoTours,
  raiseDispute:    disputeService.raiseDispute,
  getMyDisputes:   disputeService.getMyDisputes,
};
