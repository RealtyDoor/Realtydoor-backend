const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const otpAuth = require('../../lib/otpAuth');
const escrowService = require('../escrow/escrow.service');
const { getConfigNumber } = require('../config/config.service');
const { isPhoneUniqueViolation } = require('../../lib/phoneUtils');
const { sanitizeLeadForBuyer } = require('../leads/leads.service');

const DEFAULT_ESCROW_REFUND_WINDOW_HOURS = 48;

// Lazy phone verification for already-authenticated users (favorites, tickets,
// loan applications, etc. — gated by requirePhone). Backed by the shared
// PhoneOtp table (purpose: PROFILE_VERIFY) — see lib/otpAuth.js. The old
// phoneOtp* columns on User are no longer read or written here.
async function requestPhoneOtp(userId, phone) {
  const duplicate = await prisma.user.findFirst({ where: { phone, NOT: { id: userId } } });
  if (duplicate) {
    throw new ApiError(409, 'Phone number already registered to another account', { code: 'PHONE_IN_USE' });
  }

  // Do NOT write `phone` to the user row here — it isn't verified yet, and
  // writing it early lets anyone lock another person's real number onto their
  // own account before ever proving they own it. The number only lands on
  // the row once verifyPhoneOtp below actually checks the code.
  const result = await otpAuth.createAndSendOtp({ phone, purpose: 'PROFILE_VERIFY' });
  return { message: 'OTP sent via WhatsApp', ...result };
}

async function verifyPhoneOtp(userId, phone, code) {
  await otpAuth.verifyOtp({ phone, purpose: 'PROFILE_VERIFY', code });

  // Re-check for a race: someone else may have claimed this number between
  // the OTP request and this verify call.
  const duplicate = await prisma.user.findFirst({ where: { phone, NOT: { id: userId } } });
  if (duplicate) {
    throw new ApiError(409, 'Phone number already registered to another account', { code: 'PHONE_IN_USE' });
  }

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { phone, phoneVerified: true, phoneVerifiedAt: new Date() },
    });
  } catch (err) {
    // Same TOCTOU race as the check above — the DB-level partial unique
    // index (scripts/createPhoneUniqueIndex.js) is the real backstop.
    if (isPhoneUniqueViolation(err)) {
      throw new ApiError(409, 'Phone number already registered to another account', { code: 'PHONE_IN_USE' });
    }
    throw err;
  }
  return { phoneVerified: true, phone };
}

// Minimum partner fields for a buyer to see once a lead is assigned — no
// phone (final decision: the partner's phone is never exposed to the buyer
// at all; "Contact agent" always dials the shared telecaller number instead,
// see platform config key telecaller_phone), no email, no KYC/bank fields.
// No "city" either — User has no such field for a partner (only
// preferredCity, which is a *buyer's* onboarding preference and means
// nothing here); companyName is the real, useful identifying field instead.
const BUYER_LEAD_INCLUDE = {
  // locality/price/builtUpArea/carpetArea/bhk back the inquiry page's summary
  // lines ("Whitefield · ₹1.05Cr · 1,840 sqft" and "Agent · Whitefield") —
  // without them those lines have nothing to render on real data.
  property: { select: { title: true, slug: true, city: true, locality: true, images: true, price: true, builtUpArea: true, carpetArea: true, bhk: true } },
  // Buyers previously had no way to see their own escrow status at all —
  // not here, and not through any dedicated endpoint either (see
  // GET /api/escrow/:id, added alongside this).
  escrowTransactions: {
    select: {
      id: true, amount: true, currency: true, status: true,
      heldAt: true, releasedAt: true, refundedAt: true, failedAt: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  },
  assignedPartner: {
    select: { id: true, name: true, profileImageUrl: true, companyName: true },
  },
};

async function getMyLeads(userId) {
  const leads = await prisma.lead.findMany({
    where: { buyerId: userId },
    include: BUYER_LEAD_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return leads.map(sanitizeLeadForBuyer);
}

// Single-lead detail for a buyer — findFirst scoped to buyerId, so another
// user's lead id (or a nonexistent one) both give the same 404, not a 403
// that would confirm the id exists. :id is validated as an ObjectId at the
// route layer, so a malformed id 400s instead of reaching Prisma at all.
async function getMyLead(userId, id) {
  const lead = await prisma.lead.findFirst({
    where: { id, buyerId: userId },
    include: BUYER_LEAD_INCLUDE,
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  return sanitizeLeadForBuyer(lead);
}

const RATEABLE_STATUSES = ['SITE_VISIT_DONE', 'CLOSED'];

async function rateLead(userId, leadId, { rating, comment }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, buyerId: userId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!RATEABLE_STATUSES.includes(lead.status)) {
    throw new ApiError(400, 'You can rate the partner only after a site visit has taken place');
  }
  if (lead.buyerRating != null) throw new ApiError(409, 'You have already rated this partner for this lead');

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      buyerRating:        rating,
      buyerRatingComment: comment ?? null,
      buyerRatedAt:        new Date(),
    },
  });
  return sanitizeLeadForBuyer(updated);
}

async function cancelLead(userId, leadId, { reason, reasonLabel }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, buyerId: userId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (['CLOSED', 'DROPPED'].includes(lead.status)) {
    throw new ApiError(400, `This inquiry is already ${lead.status.toLowerCase()}`);
  }

  const escrow = await prisma.escrowTransaction.findFirst({
    where: { leadId, status: { in: ['HELD', 'PAYMENT_PENDING'] } },
  });

  let refund;
  if (escrow?.status === 'HELD') {
    const windowHours = await getConfigNumber('escrowRefundWindowHours', DEFAULT_ESCROW_REFUND_WINDOW_HOURS);
    const withinWindow = escrow.heldAt
      && (Date.now() - new Date(escrow.heldAt).getTime()) < windowHours * 60 * 60 * 1000;

    if (withinWindow) {
      const updatedEscrow = await escrowService.refund(escrow.id, userId, null);
      refund = {
        amount: updatedEscrow.amount,
        refundId: updatedEscrow.razorpayRefundId,
        refundTo: 'original payment method',
        eta: '5-7 business days',
      };
    }
  } else if (escrow?.status === 'PAYMENT_PENDING') {
    // Nothing was ever captured — just close it out, no Razorpay call, no refund to report.
    await prisma.escrowTransaction.update({
      where: { id: escrow.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'DROPPED',
      droppedReason: `${reasonLabel} — ${reason}`,
      droppedAt: new Date(),
    },
  });

  return { refund };
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

async function updateProfile(userId, { notificationPreferences, city, ...rest }) {
  const data = { ...rest };
  if (city !== undefined) data.preferredCity = city;

  if (notificationPreferences) {
    const { push, email, whatsapp, marketing, visitReminders } = notificationPreferences;
    if (push           !== undefined) data.notifPush           = push;
    if (email          !== undefined) data.notifEmail          = email;
    if (whatsapp       !== undefined) data.notifWhatsapp       = whatsapp;
    if (marketing      !== undefined) data.notifMarketing      = marketing;
    if (visitReminders !== undefined) data.notifVisitReminders = visitReminders;
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true, name: true, email: true, phone: true, phoneVerified: true,
      isNRI: true, profileImageUrl: true, role: true, updatedAt: true,
      address: true, language: true, preferredCity: true,
      buyerType: true, budget: true, bhk: true, timeline: true,
      notifPush: true, notifEmail: true, notifWhatsapp: true, notifMarketing: true, notifVisitReminders: true,
    },
  });

  return formatProfileSettings(user);
}

// Shared re-nesting so the API returns notificationPreferences/city in the
// same shape the PATCH body accepts them in, not as flat DB columns.
function formatProfileSettings(user) {
  const { preferredCity, notifPush, notifEmail, notifWhatsapp, notifMarketing, notifVisitReminders, ...rest } = user;
  return {
    ...rest,
    ...(preferredCity !== undefined && { city: preferredCity }),
    ...(notifPush !== undefined && {
      notificationPreferences: {
        push: notifPush, email: notifEmail, whatsapp: notifWhatsapp,
        marketing: notifMarketing, visitReminders: notifVisitReminders,
      },
    }),
  };
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
    include: {
      service: { select: { name: true, category: true } },
      tickets: { orderBy: { createdAt: 'desc' } },
    },
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

async function verifyTicket(userId, ticketId, { vendorRating, vendorRatingComment } = {}) {
  const ticket = await prisma.serviceTicket.findFirst({ where: { id: ticketId, userId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  if (ticket.status !== 'RESOLVED') throw new ApiError(400, 'Ticket is not yet resolved');

  return prisma.serviceTicket.update({
    where: { id: ticketId },
    data: {
      status: 'VERIFIED_BY_USER',
      verifiedAt: new Date(),
      ...(vendorRating !== undefined && { vendorRating }),
      ...(vendorRatingComment !== undefined && { vendorRatingComment }),
    },
  });
}

async function reopenTicket(userId, ticketId, reason) {
  const ticket = await prisma.serviceTicket.findFirst({ where: { id: ticketId, userId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  if (ticket.status !== 'RESOLVED') throw new ApiError(400, 'Only a resolved ticket can be reopened');

  return prisma.serviceTicket.update({
    where: { id: ticketId },
    data: { status: 'IN_PROGRESS', reopenReason: reason, resolvedAt: null },
  });
}

async function withdrawTicket(userId, ticketId) {
  const ticket = await prisma.serviceTicket.findFirst({ where: { id: ticketId, userId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  if (ticket.status !== 'OPEN' || ticket.vendorName) {
    throw new ApiError(400, 'This ticket can no longer be withdrawn');
  }

  await prisma.ticketComment.deleteMany({ where: { ticketId } });
  await prisma.serviceTicket.delete({ where: { id: ticketId } });
}

async function getTicketComments(userId, ticketId) {
  const ticket = await prisma.serviceTicket.findFirst({ where: { id: ticketId, userId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');

  return prisma.ticketComment.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
}

async function addTicketComment(userId, ticketId, { text, photos }) {
  const ticket = await prisma.serviceTicket.findFirst({ where: { id: ticketId, userId } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');

  return prisma.ticketComment.create({
    data: { ticketId, authorId: userId, authorRole: 'USER', text, photos: photos || [] },
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
  requestPhoneOtp, verifyPhoneOtp, getMyLeads, getMyLead, rateLead, cancelLead, toggleFavorite, getFavorites, updateProfile,
  formatProfileSettings,
  updateConsent,
  getDocuments, uploadDocument, getSubscriptions,
  raiseTicket, getMyTickets, getMyTicketById, verifyTicket,
  reopenTicket, withdrawTicket, getTicketComments, addTicketComment,
  createLoanApplication, getMyLoanApplications, getLoanApplicationById,
  requestVideoTour, getMyVideoTours,
  raiseDispute:    disputeService.raiseDispute,
  getMyDisputes:   disputeService.getMyDisputes,
};
