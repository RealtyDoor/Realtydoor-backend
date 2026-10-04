const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const logger = require('../../lib/logger');
const { createPayoutContact, createPayoutFundAccount, validateFundAccountOrWarn } = require('../../lib/razorpay');

// Previously had no endpoint at all to record this — KYC documents could be
// submitted with no consent ever stamped anywhere. Idempotent: re-calling
// after consent is already recorded just returns the original timestamp
// rather than overwriting it, so the recorded time always reflects when
// consent was first given.
async function recordKycConsent(partnerId) {
  const user = await prisma.user.findUnique({ where: { id: partnerId }, select: { kycConsentAt: true } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.kycConsentAt) return { kycConsentAt: user.kycConsentAt };

  const updated = await prisma.user.update({
    where: { id: partnerId },
    data: { kycConsentAt: new Date() },
    select: { kycConsentAt: true },
  });
  return updated;
}

// B12.3 — record acceptance of a specific agreement version. Not idempotent
// like kyc/consent: re-accepting a NEW version must overwrite, since the
// latest accepted version is what governs. Re-posting the same version just
// refreshes the timestamp, which is harmless and simpler than rejecting it.
async function acceptPartnerTerms(partnerId, version, ip) {
  const updated = await prisma.user.update({
    where: { id: partnerId },
    data: {
      partnerTermsVersion: version,
      partnerTermsAcceptedAt: new Date(),
      partnerTermsAcceptedIp: ip ?? null,
    },
    select: { partnerTermsVersion: true, partnerTermsAcceptedAt: true },
  });
  return updated;
}

async function submitKyc(partnerId, documentUrls) {
  if (!documentUrls || documentUrls.length === 0) throw new ApiError(400, 'At least one KYC document is required');

  const user = await prisma.user.findUnique({ where: { id: partnerId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.kycStatus === 'VERIFIED') throw new ApiError(400, 'KYC already verified');
  if (user.kycStatus === 'PENDING_REVIEW') throw new ApiError(400, 'KYC is already under review');
  // Previously unchecked — a client that skipped POST /partner/kyc/consent
  // entirely could still submit documents with no consent ever recorded.
  // Checked last, after the status guards: partners verified before this
  // field existed have no kycConsentAt, and on a resubmit they should hear
  // "already verified", not be asked for consent they can't usefully give.
  if (!user.kycConsentAt) throw new ApiError(400, 'KYC consent is required before submitting documents', { code: 'KYC_CONSENT_REQUIRED' });

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
      kycStatus: true, kycRejectionNote: true, kycVerifiedAt: true, kycConsentAt: true, createdAt: true,
      reraNumber: true, gstin: true, coverageAreas: true, address: true,
      partnerTermsVersion: true, partnerTermsAcceptedAt: true,
    },
  });
}

async function updateProfile(partnerId, data) {
  // panNumber is admin-set only — letting a partner change it after KYC
  // approval would invalidate what admin verified without any trace.
  const FORBIDDEN = ['role', 'kycStatus', 'kycDocumentUrls', 'email', 'panNumber'];
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

// ─── B12.1 / B12.4 — RazorpayX payout account ────────────────────────────────
// Decision: RazorpayX Payouts, not Razorpay Route. There is no linked-account
// onboarding and no Route KYC queue — we register the partner as a RazorpayX
// contact + fund account and pay that account directly at release.
//
// Statuses: PENDING_VALIDATION → ACTIVE | NEEDS_CLARIFICATION. The penny-drop
// (validateFundAccountOrWarn) is soft-fail by design — it can't run in test
// mode and is itself async — so a validation that doesn't come back clean
// lands as NEEDS_CLARIFICATION for an admin to look at rather than blocking
// the partner or silently claiming the account is good.
const PAYOUT_PUBLIC_FIELDS = {
  payoutAccountStatus: true, payoutAccountNote: true, payoutValidatedAt: true,
  razorpayContactId: true, razorpayFundAccountId: true,
  bankName: true, bankIfsc: true, bankHolderName: true, bankAccountNo: true, bankLinkedAt: true,
  panNumber: true,
};

// Never return a full account number or PAN — the partner typed them, they
// don't need them echoed, and this payload reaches the admin view too.
function maskPayout(row) {
  if (!row) return row;
  const tail = (v, keep = 4) => (v ? `${'X'.repeat(Math.max(0, String(v).length - keep))}${String(v).slice(-keep)}` : v);
  return { ...row, bankAccountNo: tail(row.bankAccountNo), panNumber: tail(row.panNumber) };
}

async function getPayoutAccount(partnerId) {
  const row = await prisma.user.findUnique({ where: { id: partnerId }, select: PAYOUT_PUBLIC_FIELDS });
  if (!row) throw new ApiError(404, 'User not found');
  return maskPayout(row);
}

async function createPayoutAccount(partnerId, data) {
  const partner = await prisma.user.findUnique({
    where: { id: partnerId },
    select: { id: true, name: true, email: true, phone: true, payoutAccountStatus: true, razorpayContactId: true },
  });
  if (!partner) throw new ApiError(404, 'User not found');
  if (partner.payoutAccountStatus === 'ACTIVE') {
    throw new ApiError(409, 'A payout account is already active. Contact support to change your bank details.', { code: 'PAYOUT_ACCOUNT_EXISTS' });
  }

  // Reuse the contact across retries — RazorpayX would otherwise accumulate a
  // duplicate contact for this partner on every failed attempt.
  let contactId = partner.razorpayContactId;
  try {
    if (!contactId) {
      const contact = await createPayoutContact(data.legalName, partner.email, partner.phone);
      contactId = contact.id;
    }
  } catch (err) {
    logger.error('[payoutAccount] contact creation failed', { partnerId, error: err?.error?.description || err.message });
    throw new ApiError(502, 'Could not register your details with the payment provider. Please try again.');
  }

  let fundAccountId;
  try {
    const fa = await createPayoutFundAccount(contactId, data.legalName, data.ifsc, data.accountNumber);
    fundAccountId = fa.id;
  } catch (err) {
    // Store the contact we did create so a retry doesn't make another one.
    await prisma.user.update({ where: { id: partnerId }, data: { razorpayContactId: contactId } });
    logger.error('[payoutAccount] fund account creation failed', { partnerId, error: err?.error?.description || err.message });
    throw new ApiError(400, 'The bank account could not be registered. Check the account number and IFSC.', { code: 'FUND_ACCOUNT_REJECTED' });
  }

  let status = 'ACTIVE';
  let note = null;
  try {
    await validateFundAccountOrWarn(fundAccountId, 'partner');
  } catch (err) {
    // The only thing that throws here is a definite "account inactive".
    status = 'NEEDS_CLARIFICATION';
    note = err.message;
  }

  const updated = await prisma.user.update({
    where: { id: partnerId },
    data: {
      razorpayContactId: contactId,
      razorpayFundAccountId: fundAccountId,
      payoutAccountStatus: status,
      payoutAccountNote: note,
      payoutValidatedAt: status === 'ACTIVE' ? new Date() : null,
      bankHolderName: data.legalName,
      bankAccountNo: data.accountNumber,
      bankIfsc: data.ifsc,
      bankLinkedAt: new Date(),
      ...(data.panNumber && { panNumber: data.panNumber }),
      ...(data.bankName && { bankName: data.bankName }),
    },
    select: PAYOUT_PUBLIC_FIELDS,
  });

  return maskPayout(updated);
}

// 3.5 — admin side of the clarification flow: flag an account for
// re-submission, or clear it once the partner has fixed things.
async function setPayoutAccountStatus(partnerId, status, note, adminId, ip) {
  const partner = await prisma.user.findFirst({ where: { id: partnerId, role: 'PARTNER' }, select: { id: true, payoutAccountStatus: true } });
  if (!partner) throw new ApiError(404, 'Partner not found');

  const updated = await prisma.user.update({
    where: { id: partnerId },
    data: {
      payoutAccountStatus: status,
      payoutAccountNote: note ?? null,
      ...(status === 'ACTIVE' ? { payoutValidatedAt: new Date() } : {}),
    },
    select: PAYOUT_PUBLIC_FIELDS,
  });

  await createNotification({
    userId: partnerId,
    title: status === 'ACTIVE' ? 'Payout account approved' : 'Payout account needs attention',
    message: status === 'ACTIVE'
      ? 'Your payout account is active. Escrow releases will be paid to it.'
      : `Your payout account needs attention${note ? `: ${note}` : '.'}`,
    type: 'PAYOUT_ACCOUNT_UPDATE',
    linkUrl: '/partners/profile/bank',
  });

  await createAuditLog({
    adminId, action: 'PAYOUT_ACCOUNT_STATUS_SET', targetType: 'User', targetId: partnerId,
    before: { payoutAccountStatus: partner.payoutAccountStatus },
    after: { payoutAccountStatus: status, note: note ?? null }, ipAddress: ip,
  });

  return maskPayout(updated);
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
  acceptPartnerTerms, recordKycConsent, submitKyc, getProfile, updateProfile, uploadProfilePhoto, getListing, getMyListings,
  getFinanceSummary, getRatings,
  getSettings, updateSettings,
  getBankAccount, updateBankAccount,
  getPayoutAccount, createPayoutAccount, setPayoutAccountStatus,
  getSupportTickets, getSupportTicketById, createSupportTicket,
  getPartnerAnalytics,
};
