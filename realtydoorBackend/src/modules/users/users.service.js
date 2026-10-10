const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const otpAuth = require('../../lib/otpAuth');
const escrowService = require('../escrow/escrow.service');
const { getConfigNumber } = require('../config/config.service');
const { isPhoneUniqueViolation } = require('../../lib/phoneUtils');
const { sanitizeLeadForBuyer } = require('../leads/leads.service');
const { createPrivacyAuditLog } = require('../../lib/privacyAuditLog');
const { getMoneyInFlightReasons, revokeAllSessions } = require('../../lib/accountDeletion');
const { getLoanEligibility, resolveVerifiedDocIds, attachLoanDocuments } = require('../../lib/loanEligibility');
const { getConfigValue } = require('../config/config.service');

const DELETION_GRACE_PERIOD_DAYS = 30;
const DEFAULT_TERMS_VERSION = '1';
const DEFAULT_PRIVACY_VERSION = '1';

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
    const windowHours = await getConfigNumber('escrow_refund_window_hours', DEFAULT_ESCROW_REFUND_WINDOW_HOURS);
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

async function updateProfile(userId, { notificationPreferences, city, ...rest }, ipAddress, userAgent) {
  const data = { ...rest };
  if (city !== undefined) data.preferredCity = city;

  // Backend gaps handoff, 2026-10-10 (#4) — old values are read first so
  // the audit log can record one row PER KEY THAT ACTUALLY CHANGED, not one
  // row for the whole request regardless of whether anything moved (e.g.
  // re-sending the same `push: true` the user already had shouldn't write
  // a log entry). Never phone/email/message bodies — just which boolean
  // flipped and its old/new value.
  const oldPrefs = notificationPreferences
    ? await prisma.user.findUnique({
        where: { id: userId },
        select: { notifPush: true, notifEmail: true, notifWhatsapp: true, marketingOptIn: true, notifVisitReminders: true },
      })
    : null;

  if (notificationPreferences) {
    const { push, email, whatsapp, marketing, visitReminders } = notificationPreferences;
    if (push           !== undefined) data.notifPush           = push;
    if (email          !== undefined) data.notifEmail          = email;
    if (whatsapp       !== undefined) data.notifWhatsapp       = whatsapp;
    // Privacy spec, 2026-10-10 — the Settings screen's "Marketing
    // communication" toggle now writes the same marketingOptIn/
    // marketingOptInAt pair the onboarding consent screen uses
    // (updateConsent below), instead of the old, unsynced notifMarketing.
    if (marketing      !== undefined) {
      data.marketingOptIn   = marketing;
      data.marketingOptInAt = marketing ? new Date() : null;
    }
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
      notifPush: true, notifEmail: true, notifWhatsapp: true, marketingOptIn: true, notifVisitReminders: true,
    },
  });

  if (notificationPreferences && oldPrefs) {
    const candidates = [
      ['push',           oldPrefs.notifPush,        user.notifPush],
      ['email',          oldPrefs.notifEmail,        user.notifEmail],
      ['whatsapp',       oldPrefs.notifWhatsapp,      user.notifWhatsapp],
      ['marketing',      oldPrefs.marketingOptIn,     user.marketingOptIn],
      ['visitReminders', oldPrefs.notifVisitReminders, user.notifVisitReminders],
    ];
    for (const [field, from, to] of candidates) {
      if (notificationPreferences[field] !== undefined && from !== to) {
        await createPrivacyAuditLog({
          userId, action: 'NOTIFICATION_PREFERENCE_CHANGED', ipAddress, userAgent,
          metadata: { field, from, to },
        });
      }
    }
  }

  return formatProfileSettings(user);
}

// Shared re-nesting so the API returns notificationPreferences/city in the
// same shape the PATCH body accepts them in, not as flat DB columns.
function formatProfileSettings(user) {
  const { preferredCity, notifPush, notifEmail, notifWhatsapp, marketingOptIn, notifVisitReminders, ...rest } = user;
  return {
    ...rest,
    ...(preferredCity !== undefined && { city: preferredCity }),
    ...(notifPush !== undefined && {
      notificationPreferences: {
        push: notifPush, email: notifEmail, whatsapp: notifWhatsapp,
        marketing: marketingOptIn, visitReminders: notifVisitReminders,
      },
    }),
  };
}

// Backend gaps handoff, 2026-10-10 (follow-up) — the client's documentVersion
// is accepted (still in the schema, so an older build that still sends one
// doesn't 400) but no longer trusted to decide what got accepted. The
// frontend's own wording-revision string ("2026-06-1") would never equal a
// bumped PlatformConfig terms_version/privacy_version ("2"), so every user
// would show requiresReconsent: true the moment an admin published a new
// version — the server is the one place that actually knows which version
// is current, so it stamps that, not whatever the client happened to send.
async function updateConsent(userId, { termsAccepted, privacyAccepted, marketingOptIn }, ipAddress, userAgent) {
  const data = {};
  const now = new Date();

  let currentTermsVersion;
  let currentPrivacyVersion;
  if (termsAccepted) {
    currentTermsVersion = await getConfigValue('terms_version', DEFAULT_TERMS_VERSION);
    data.termsAcceptedAt = now;
    data.termsAcceptedVersion = currentTermsVersion;
  }
  if (privacyAccepted) {
    currentPrivacyVersion = await getConfigValue('privacy_version', DEFAULT_PRIVACY_VERSION);
    data.privacyAcceptedAt = now;
    data.privacyAcceptedVersion = currentPrivacyVersion;
  }
  if (marketingOptIn !== undefined) {
    data.marketingOptIn   = marketingOptIn;
    data.marketingOptInAt = marketingOptIn ? now : null;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true, termsAcceptedAt: true, termsAcceptedVersion: true,
      privacyAcceptedAt: true, privacyAcceptedVersion: true,
      marketingOptIn: true, marketingOptInAt: true,
    },
  });

  // One row per consent actually given this call, not one row for the whole
  // request — a caller accepting terms AND opting into marketing in the same
  // PATCH did two separate consent-worthy things, and the spec wants each
  // event individually recorded.
  if (termsAccepted)   await createPrivacyAuditLog({ userId, action: 'TERMS_ACCEPTED', documentVersion: currentTermsVersion, ipAddress, userAgent });
  if (privacyAccepted) await createPrivacyAuditLog({ userId, action: 'PRIVACY_ACCEPTED', documentVersion: currentPrivacyVersion, ipAddress, userAgent });
  if (marketingOptIn !== undefined) {
    await createPrivacyAuditLog({
      userId, action: marketingOptIn ? 'MARKETING_OPT_IN' : 'MARKETING_OPT_OUT', ipAddress, userAgent,
    });
  }

  return updated;
}

// Privacy spec, 2026-10-10 — "the app can't see what a user agreed to
// today." A single read covering every consent/preference surface the
// Settings screen shows, so the app doesn't have to assemble it from
// several endpoints.
async function getConsentState(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      termsAcceptedAt: true, privacyAcceptedAt: true,
      marketingOptIn: true, marketingOptInAt: true,
      consentWithdrawnAt: true,
      notifPush: true, notifEmail: true, notifWhatsapp: true, notifVisitReminders: true,
      deletionRequestedAt: true, deletionScheduledAt: true, deletionCancelledAt: true,
      kycConsentAt: true, partnerTermsVersion: true, partnerTermsAcceptedAt: true,
    },
  });
  if (!user) throw new ApiError(404, 'User not found');

  const {
    role, notifPush, notifEmail, notifWhatsapp, notifVisitReminders, marketingOptIn,
    kycConsentAt, partnerTermsVersion, partnerTermsAcceptedAt,
    ...rest
  } = user;

  return {
    ...rest,
    marketingOptIn,
    notificationPreferences: {
      push: notifPush, email: notifEmail, whatsapp: notifWhatsapp,
      marketing: marketingOptIn, visitReminders: notifVisitReminders,
    },
    deletionRequested: Boolean(user.deletionRequestedAt && user.deletionScheduledAt),
    // Partner-only consent surfaces — omitted entirely for buyers, rather
    // than sent as null, so the app doesn't render a partner section for a
    // role that was never shown it.
    ...(role === 'PARTNER' && { kycConsentAt, partnerTermsVersion, partnerTermsAcceptedAt }),
  };
}

// Backend gaps handoff, 2026-10-10 (#1) — nested shape the frontend's
// PrivacyActionModal/settings page actually reads (src/lib/privacy.ts),
// distinct from GET /user/consent's flatter shape above which is kept
// unchanged for whatever still reads it. requiresReconsent is true only
// when the user accepted a SPECIFIC earlier version that no longer matches
// what's currently published — never accepting at all is a different,
// pre-existing state the frontend already handles via a null acceptedAt.
async function getPrivacyState(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      termsAcceptedAt: true, termsAcceptedVersion: true,
      privacyAcceptedAt: true, privacyAcceptedVersion: true, consentWithdrawnAt: true,
      marketingOptIn: true, marketingOptInAt: true,
      notifPush: true, notifEmail: true, notifWhatsapp: true, notifVisitReminders: true,
      deletionRequestedAt: true, deletionScheduledAt: true,
    },
  });
  if (!user) throw new ApiError(404, 'User not found');

  const [currentTermsVersion, currentPrivacyVersion] = await Promise.all([
    getConfigValue('terms_version', DEFAULT_TERMS_VERSION),
    getConfigValue('privacy_version', DEFAULT_PRIVACY_VERSION),
  ]);

  const requiresReconsent = Boolean(
    (user.termsAcceptedAt && user.termsAcceptedVersion && user.termsAcceptedVersion !== currentTermsVersion)
    || (user.privacyAcceptedAt && user.privacyAcceptedVersion && user.privacyAcceptedVersion !== currentPrivacyVersion)
  );

  return {
    terms:   { acceptedAt: user.termsAcceptedAt, version: user.termsAcceptedVersion },
    privacy: { acceptedAt: user.privacyAcceptedAt, version: user.privacyAcceptedVersion, withdrawnAt: user.consentWithdrawnAt },
    marketingOptIn: user.marketingOptIn,
    notificationPreferences: {
      push: user.notifPush, email: user.notifEmail, whatsapp: user.notifWhatsapp,
      marketing: user.marketingOptIn, visitReminders: user.notifVisitReminders,
    },
    currentVersions: { terms: currentTermsVersion, privacy: currentPrivacyVersion },
    requiresReconsent,
    deletion: { requestedAt: user.deletionRequestedAt, scheduledFor: user.deletionScheduledAt },
  };
}

// Backend gaps handoff, 2026-10-10 (follow-up) — scope: 'MARKETING' just
// flips the marketing opt-in off (lighter, reversible). scope: 'ALL'
// withdraws consent to processing generally AND starts the same 30-day
// deletion flow as requestAccountDeletion below (shares its core,
// including the money-in-flight block).
//
// Decided: check first, write nothing on a block (option A of the two the
// frontend asked us to pick between). The money-in-flight check runs
// before anything is written — a blocked scope:'ALL' call leaves the
// account exactly as it was (no CONSENT_WITHDRAWN, no row touched),
// 409 DELETION_BLOCKED, same as requestAccountDeletion's own block. This
// was picked over "keep the withdrawal, auto-start deletion once the
// money clears" because that needs the daily cron to track users who
// withdrew-but-couldn't-delete as a new, separate case it doesn't have
// today — this keeps withdraw-consent a single atomic action instead of
// introducing that extra state and a silent background follow-up the user
// never explicitly asked this call to do for them later.
async function withdrawConsent(userId, scope, ipAddress, userAgent) {
  const normalizedScope = scope === 'ALL' ? 'ALL' : 'MARKETING';

  if (normalizedScope === 'MARKETING') {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { marketingOptIn: false, marketingOptInAt: null },
      select: { id: true, marketingOptIn: true },
    });
    await createPrivacyAuditLog({ userId, action: 'MARKETING_OPT_OUT', ipAddress, userAgent, metadata: { scope: normalizedScope } });
    return updated;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { deletedAt: true } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.deletedAt) throw new ApiError(400, 'This account has already been deleted');

  const blockingReasons = await getMoneyInFlightReasons(userId);
  if (blockingReasons.length) {
    throw new ApiError(409, `Account deletion is blocked: ${blockingReasons.join('; ')}`, {
      code: 'DELETION_BLOCKED', reasons: blockingReasons,
    });
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { consentWithdrawnAt: new Date() },
    select: { id: true, consentWithdrawnAt: true },
  });
  await createPrivacyAuditLog({ userId, action: 'CONSENT_WITHDRAWN', ipAddress, userAgent, metadata: { scope: normalizedScope } });

  const deletion = await requestAccountDeletion(userId, 'Consent withdrawn (scope=ALL)', ipAddress, userAgent);
  return {
    ...updated,
    deletion: { requestedAt: deletion.deletionRequestedAt, scheduledFor: deletion.deletionScheduledAt },
    scheduledFor: deletion.deletionScheduledAt,
  };
}

// Privacy spec, 2026-10-10 — 30-day grace period, cancellable, blocked while
// money is in flight. deletionRequestedAt/deletionScheduledAt are the ACTIVE
// request state (jobs/processAccountDeletions.js acts on deletionScheduledAt
// directly); the historical fact that a request happened lives permanently
// in the audit log, not in these two columns, which cancelAccountDeletion
// below clears back to null.
//
// Backend gaps handoff, 2026-10-10 (#1/#2) — `reason` is the optional
// free-text field the new POST /user/account/deletion-request body accepts
// (stored only in the audit log metadata, never on the User row itself —
// it has no business surviving into the anonymized record). Returns
// `scheduledFor` alongside the original `deletionScheduledAt` key so both
// the old and new frontend contracts read the field they expect from the
// same response. Clerk sessions are revoked best-effort so the read-only
// lock (middleware/auth.js) isn't the only thing standing between a token
// already in a browser and the rest of the app.
async function requestAccountDeletion(userId, reason, ipAddress, userAgent) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, clerkId: true, deletedAt: true } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.deletedAt) throw new ApiError(400, 'This account has already been deleted');

  const blockingReasons = await getMoneyInFlightReasons(userId);
  if (blockingReasons.length) {
    throw new ApiError(409, `Account deletion is blocked: ${blockingReasons.join('; ')}`, {
      code: 'DELETION_BLOCKED', reasons: blockingReasons,
    });
  }

  const now = new Date();
  const deletionScheduledAt = new Date(now.getTime() + DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { deletionRequestedAt: now, deletionScheduledAt, deletionCancelledAt: null },
    select: { id: true, deletionRequestedAt: true, deletionScheduledAt: true },
  });

  await createPrivacyAuditLog({
    userId, action: 'DELETION_REQUESTED', ipAddress, userAgent,
    metadata: reason ? { reason } : undefined,
  });
  await revokeAllSessions(user.clerkId);

  return { ...updated, scheduledFor: updated.deletionScheduledAt };
}

async function cancelAccountDeletion(userId, ipAddress, userAgent) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true } });
  if (!user?.deletionRequestedAt) throw new ApiError(400, 'There is no pending deletion request to cancel');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { deletionRequestedAt: null, deletionScheduledAt: null, deletionCancelledAt: new Date() },
    select: { id: true, deletionCancelledAt: true },
  });

  await createPrivacyAuditLog({ userId, action: 'DELETION_CANCELLED', ipAddress, userAgent });
  return updated;
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

// Backend gaps handoff, 2026-10-10 (#5) — a document attached to a loan
// that hasn't reached a terminal state is evidence a lender relied on;
// deleting it out from under a live application would leave
// documentSnapshot pointing at nothing. DISBURSED/REJECTED are the only
// terminal LoanStatus values (same set lib/accountDeletion.js's
// hasMoneyInFlight uses for "is this loan still in progress").
async function deleteDocument(userId, docId) {
  const doc = await prisma.userDocument.findFirst({ where: { id: docId, userId } });
  if (!doc) throw new ApiError(404, 'Document not found');

  const attachedLoan = await prisma.loanApplication.findFirst({
    where: { userId, submittedDocIds: { has: docId }, status: { notIn: ['DISBURSED', 'REJECTED'] } },
    select: { id: true },
  });
  if (attachedLoan) {
    throw new ApiError(409, 'This document is attached to a loan application that is still in progress and cannot be deleted', {
      code: 'DOCUMENT_IN_USE',
    });
  }

  await prisma.userDocument.delete({ where: { id: docId } });
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

  // 7.6 — sticky once true: "first-time verify rate" asks whether THIS
  // ticket was ever reopened, not just whether the current resolve attempt
  // was clean.
  return prisma.serviceTicket.update({
    where: { id: ticketId },
    data: { status: 'IN_PROGRESS', reopenReason: reason, resolvedAt: null, wasReopened: true },
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

// Backend gaps handoff, 2026-10-10 (#5) — the frontend's document-upload
// step only *looked* mandatory; a direct API call could submit with no
// documents at all. submittedDocIds from the request body is accepted (so
// an older frontend build that still sends it doesn't 400) but ignored —
// the server decides which documents actually back this application, from
// whichever ones are currently verified, re-checked inside the same
// transaction as the insert so nothing changes between the check and the
// write.
async function createLoanApplication(userId, { documentSharingConsent: _documentSharingConsent, documentSharingConsentVersion, submittedDocIds: _submittedDocIds, tenureMonths, ...data }) {
  return prisma.$transaction(async (tx) => {
    const eligibility = await getLoanEligibility(userId, tx);
    if (!eligibility.eligible) {
      throw new ApiError(409, 'All required documents must be verified before you can apply', {
        code: 'DOCUMENTS_NOT_VERIFIED',
        blocking: eligibility.blocking,
      });
    }

    const verifiedDocIds = resolveVerifiedDocIds(eligibility);
    const documentSnapshot = eligibility.rows
      .filter((r) => r.state === 'verified' && r.document)
      .map((r) => ({
        documentId: r.document.id,
        documentType: r.document.documentType,
        fileName: r.document.fileName,
        fileUrl: r.document.fileUrl,
        verifiedAt: r.document.verifiedAt,
        verifiedByAdminId: r.document.verifiedByAdminId,
        uploadedAt: r.document.uploadedAt,
      }));

    return tx.loanApplication.create({
      data: {
        ...data, userId,
        // tenureMonthsRequested, not tenureMonths — that column is admin-set
        // at sanction time (updateLoanStatus) and must not be clobbered by
        // what the user originally asked for.
        ...(tenureMonths != null && { tenureMonthsRequested: tenureMonths }),
        submittedDocIds: verifiedDocIds,
        documentSnapshot,
        // documentSharingConsent is required on every submission (validator
        // enforces the literal true), so this is always set, not conditional
        // on documents being attached.
        documentSharingConsentAt: new Date(),
        ...(documentSharingConsentVersion && { documentSharingConsentVersion }),
        // Dev feedback, 2026-10-08 (L4) — "on create seed the first one":
        // the tracker's dated step list should show DOCUMENTS_PENDING from
        // the very start, not only once the first admin-driven status
        // change happens.
        statusHistory: [{ status: 'DOCUMENTS_PENDING', at: new Date().toISOString(), note: null }],
      },
    });
  });
}

async function getLoanEligibilityForUser(userId) {
  return getLoanEligibility(userId);
}

async function getMyLoanApplications(userId) {
  const loans = await prisma.loanApplication.findMany({
    where: { userId },
    include: { property: { select: { title: true, slug: true, city: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return attachLoanDocuments(loans);
}

async function getLoanApplicationById(userId, loanId) {
  const loan = await prisma.loanApplication.findFirst({ where: { id: loanId, userId } });
  if (!loan) throw new ApiError(404, 'Loan application not found');
  return attachLoanDocuments(loan);
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
  getConsentState, getPrivacyState, withdrawConsent, requestAccountDeletion, cancelAccountDeletion,
  getDocuments, uploadDocument, deleteDocument, getSubscriptions,
  raiseTicket, getMyTickets, getMyTicketById, verifyTicket,
  reopenTicket, withdrawTicket, getTicketComments, addTicketComment,
  createLoanApplication, getMyLoanApplications, getLoanApplicationById, getLoanEligibilityForUser,
  requestVideoTour, getMyVideoTours,
  raiseDispute:    disputeService.raiseDispute,
  getMyDisputes:   disputeService.getMyDisputes,
};
