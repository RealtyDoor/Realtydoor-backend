const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createNotification, notifyAdmins } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const logger = require('../../lib/logger');
const { createPayoutContact, createPayoutFundAccount, validateFundAccountOrWarn, rawGet } = require('../../lib/razorpay');
const kycVerification = require('../../lib/kycVerification');

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
    data: {
      kycStatus: 'PENDING_REVIEW',
      kycDocumentUrls: documentUrls,
      // R9 — resubmitting after a document request clears the checklist:
      // the partner acted on it, so it goes back to a normal review rather
      // than sitting in DOCUMENTS_REQUESTED (or OVERDUE) forever.
      kycRequestedDocuments: [],
      kycRequestedNote: null,
      kycRequestedAt: null,
      kycRequestedDueAt: null,
      kycRequestedByAdminId: null,
    },
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

  // 5.x — fire-and-forget: advisory input into admin's manual review above,
  // never blocks submission and never decides kycStatus itself. A no-op
  // (see lib/kycVerification.js) until a real vendor key is configured.
  runAutomatedKycChecks(partnerId).catch((err) => {
    logger.error('[KYC] automated verification failed', { partnerId, error: err.message });
  });

  return updated;
}

// 5.x — runs whichever of PAN/GSTIN/RERA this partner actually has on file.
// Exported so admin.service.js's on-demand re-check endpoint can call the
// exact same logic rather than duplicating it. A no-op per field when
// lib/kycVerification.js isn't configured (every status comes back
// NOT_CONFIGURED) — still written, so the admin KYC screen can show
// "automated check not available" rather than stale/missing data.
async function runAutomatedKycChecks(partnerId) {
  const user = await prisma.user.findUnique({
    where: { id: partnerId },
    select: { panNumber: true, gstin: true, reraNumber: true, name: true, companyName: true },
  });
  if (!user) throw new ApiError(404, 'User not found');

  const nameToMatch = user.companyName || user.name;
  const updates = {};

  if (user.panNumber) {
    const r = await kycVerification.verifyPan(user.panNumber, nameToMatch);
    updates.panVerificationStatus = r.status;
    updates.panVerifiedName = r.verifiedName;
    updates.panVerifiedAt = new Date();
  }
  if (user.gstin) {
    const r = await kycVerification.verifyGstin(user.gstin);
    updates.gstinVerificationStatus = r.status;
    updates.gstinVerifiedName = r.verifiedName;
    updates.gstinVerifiedAt = new Date();
  }
  if (user.reraNumber) {
    const r = await kycVerification.verifyRera(user.reraNumber);
    updates.reraVerificationStatus = r.status;
    updates.reraVerifiedName = r.verifiedName;
    updates.reraVerifiedAt = new Date();
  }

  if (Object.keys(updates).length === 0) return null;
  return prisma.user.update({ where: { id: partnerId }, data: updates, select: {
    panVerificationStatus: true, panVerifiedName: true, panVerifiedAt: true,
    gstinVerificationStatus: true, gstinVerifiedName: true, gstinVerifiedAt: true,
    reraVerificationStatus: true, reraVerifiedName: true, reraVerifiedAt: true,
  } });
}

async function getProfile(partnerId) {
  const row = await prisma.user.findUnique({
    where: { id: partnerId },
    select: {
      // The PAN itself is never returned: only whether it is on file and its last 4 characters.
      panNumber: true,
      id: true, name: true, email: true, phone: true, companyName: true,
      bio: true, profileImageUrl: true, websiteUrl: true, partnerSubType: true,
      kycStatus: true, kycRejectionNote: true, kycVerifiedAt: true, kycConsentAt: true, createdAt: true,
      reraNumber: true, gstin: true, coverageAreas: true, address: true,
      partnerTermsVersion: true, partnerTermsAcceptedAt: true,
    },
  });
  if (!row) return row;
  const { panNumber, ...rest } = row;
  const pan = panNumber ? String(panNumber).trim() : '';
  return { ...rest, panOnFile: !!pan, panMasked: pan ? `${'X'.repeat(Math.max(0, pan.length - 4))}${pan.slice(-4)}` : null };
}

async function updateProfile(partnerId, data) {
  // An existing PAN is admin-set only (see below).
  const FORBIDDEN = ['role', 'kycStatus', 'kycDocumentUrls', 'email'];
  FORBIDDEN.forEach((f) => delete data[f]);
  // Money model Rev 3: a partner may ADD a PAN when none is on file (it decides
  // the TDS rate); an existing PAN can only be changed by admin.
  if (data.panNumber) {
    const current = await prisma.user.findUnique({ where: { id: partnerId }, select: { panNumber: true } });
    if (current?.panNumber && current.panNumber.trim().toUpperCase() !== data.panNumber) {
      throw new ApiError(409, 'Your PAN is already on file. To change it, contact support.', { code: 'PAN_LOCKED' });
    }
    // A new PAN has not been verified yet.
    data.panVerificationStatus = null;
    data.panVerifiedName = null;
    data.panVerifiedAt = null;
  }
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
      // B125 — the partner list needs to show what admin asked to change.
      requestedChanges: true, requestedChangesNote: true, changesRequestedAt: true,
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
      select: { status: true, amount: true, releasedAt: true, heldAt: true, partnerShareAmount: true },
    }),
    prisma.escrowTransaction.findMany({
      where: {
        lead: { assignedPartnerId: partnerId },
        status: 'RELEASED',
        releasedAt: { gte: startOfMonth },
      },
      select: { amount: true, partnerShareAmount: true },
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
    // B33 — releasedTotal/releasedThisMonth above are whole escrow amounts
    // (deal volume), not what this partner earned. Additive: the partner's own
    // recorded share, so the UI can show earnings without redefining the
    // existing fields.
    partnerShareTotal:     releasedEscrows.reduce((s, e) => s + (e.partnerShareAmount || 0), 0),
    partnerShareThisMonth: thisMonthEscrows.reduce((s, e) => s + (e.partnerShareAmount || 0), 0),
  };
}

// R31 / B12.6 — the "Released" screen needs per-deal payout status and UTR,
// not just the aggregate totals above. Scoped to escrows that ever had a
// partner-leg payout attempted (a missing field, not a null one — same
// isSet trap as elsewhere in this schema) rather than every escrow on the
// partner's leads, since a HELD or buyer-refunded escrow has no payout to
// show here at all.
async function listMyPayouts(partnerId, skip, limit) {
  const where = { lead: { assignedPartnerId: partnerId }, razorpayPartnerPayoutId: { isSet: true } };
  const [rows, total] = await Promise.all([
    prisma.escrowTransaction.findMany({
      where, skip, take: limit, orderBy: { releasedAt: 'desc' },
      select: {
        id: true, amount: true, status: true, releasedAt: true,
        razorpayPartnerPayoutId: true, partnerPayoutStatus: true, partnerPayoutUtr: true,
        lead: { select: { id: true, buyerName: true, property: { select: { title: true } } } },
      },
    }),
    prisma.escrowTransaction.count({ where }),
  ]);
  return { data: rows, total };
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

// razorpayRouteAccountId removed — RazorpayX only, decided (docs-backend-gaps-handoff.md
// #2). The real payout flow is razorpayFundAccountId, created via
// POST /partner/payout-account; this bank-account path never fed Razorpay anything.
const BANK_FIELDS = ['bankName', 'bankBranch', 'bankAccountNo', 'bankIfsc', 'bankHolderName', 'bankLinkedAt'];

async function getBankAccount(partnerId) {
  return prisma.user.findUnique({
    where: { id: partnerId },
    select: Object.fromEntries(BANK_FIELDS.map((f) => [f, true])),
  });
}

async function updateBankAccount(partnerId, data) {
  // BE-14 — once a RazorpayX fund account is registered, the account
  // number/IFSC/holder name displayed here must stay in lockstep with the
  // account payouts actually go to. Previously this route could silently
  // overwrite those three fields with no effect on razorpayFundAccountId,
  // so the partner's own "my bank account" page could show a number that
  // was no longer where their money actually lands. Only branch is still
  // free to edit directly; the other three require the change-request flow
  // (requestPayoutAccountChange below), which re-validates the new account
  // before it's ever used for a real payout.
  const current = await prisma.user.findUnique({
    where: { id: partnerId },
    select: { bankAccountNo: true, bankIfsc: true, bankHolderName: true, razorpayFundAccountId: true },
  });
  if (current?.razorpayFundAccountId) {
    const changedRegisteredField = data.bankAccountNo !== current.bankAccountNo
      || data.bankIfsc !== current.bankIfsc
      || data.bankHolderName !== current.bankHolderName;
    if (changedRegisteredField) {
      throw new ApiError(409,
        'A payout account is already registered with these details. To change the account number, IFSC or account holder name, submit a payout account change request instead.',
        { code: 'USE_PAYOUT_CHANGE_REQUEST' });
    }
  }

  return prisma.user.update({
    where: { id: partnerId },
    data: { ...data, bankLinkedAt: new Date() },
    select: Object.fromEntries(BANK_FIELDS.map((f) => [f, true])),
  });
}

// ─── R8 — billing details ─────────────────────────────────────────────────────

// gstin is NOT billingGstin — it's the existing partner-identity field
// (3.2/3.3/B1.6), reused here rather than duplicated.
const BILLING_FIELDS = [
  'billingLegalName', 'gstin', 'billingAddress',
  'billingAccountsContactName', 'billingAccountsContactEmail', 'billingAccountsContactPhone',
];

async function getBilling(partnerId) {
  return prisma.user.findUnique({
    where: { id: partnerId },
    select: Object.fromEntries(BILLING_FIELDS.map((f) => [f, true])),
  });
}

async function updateBilling(partnerId, data) {
  return prisma.user.update({
    where: { id: partnerId },
    data,
    select: Object.fromEntries(BILLING_FIELDS.map((f) => [f, true])),
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

// R14 — admin needs every partner's payout account in one view, not a
// one-at-a-time status-setter with nothing to list from. Same masking as the
// partner's own read: this reaches an admin screen, not a raw export, and
// there is no reason an admin needs the full account number or PAN on a list
// view either.
// B125 — admin "sync with Razorpay": re-reads the partner's RazorpayX fund
// account and reconciles our payoutAccountStatus with it, instead of waiting
// for a payout to fail. Only downgrades when RazorpayX says the account is
// inactive; only promotes a PENDING_VALIDATION account whose KYC is already
// verified. Everything else is reported, not changed.
async function syncPayoutAccount(partnerId, adminId, ip) {
  const partner = await prisma.user.findFirst({
    where: { id: partnerId, role: 'PARTNER' },
    select: { id: true, kycStatus: true, payoutAccountStatus: true, razorpayFundAccountId: true },
  });
  if (!partner) throw new ApiError(404, 'Partner not found');
  if (!partner.razorpayFundAccountId) {
    throw new ApiError(409, 'This partner has no RazorpayX fund account to sync', { code: 'NO_FUND_ACCOUNT' });
  }

  let fundAccount;
  try {
    fundAccount = await rawGet(`/v1/fund_accounts/${partner.razorpayFundAccountId}`);
  } catch (err) {
    throw new ApiError(502, `Could not read the fund account from RazorpayX: ${err?.error?.description || err.message || 'Unknown error'}`, { code: 'RAZORPAYX_ERROR' });
  }

  const remoteActive = fundAccount?.active !== false;
  const before = partner.payoutAccountStatus || null;
  let after = before;
  let note;
  if (!remoteActive && before === 'ACTIVE') {
    after = 'NEEDS_CLARIFICATION';
    note = 'RazorpayX reports this fund account as inactive.';
  } else if (remoteActive && before === 'PENDING_VALIDATION' && partner.kycStatus === 'VERIFIED') {
    after = 'ACTIVE';
  }

  if (after !== before) {
    await prisma.user.update({
      where: { id: partnerId },
      data: { payoutAccountStatus: after, ...(note && { payoutAccountNote: note }) },
    });
  }
  await createAuditLog({
    adminId, action: 'PAYOUT_ACCOUNT_SYNCED', targetType: 'User', targetId: partnerId,
    before: { payoutAccountStatus: before }, after: { payoutAccountStatus: after, remoteActive }, ipAddress: ip,
  });
  return { payoutAccountStatus: after, changed: after !== before, remoteActive, fundAccountId: partner.razorpayFundAccountId };
}

async function listPayoutAccounts(filters, skip, limit) {
  const where = { role: 'PARTNER' };
  // "Not yet set up at all" is MISSING, not null (no default was ever
  // applied) — the same missing-vs-null trap seen elsewhere in this schema.
  // Checked first and explicitly, rather than relying on statement order to
  // override a looser assignment below.
  if (filters.status === 'NOT_SET_UP') {
    where.payoutAccountStatus = { isSet: false };
  } else if (filters.status) {
    where.payoutAccountStatus = filters.status;
  }

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, companyName: true, email: true, ...PAYOUT_PUBLIC_FIELDS },
    }),
    prisma.user.count({ where }),
  ]);

  // backend-work-still-open.md #6 — "balance held for that partner": the sum
  // of their own escrowHeld, same figure getFinanceSummary already computes
  // for a partner's own view, but batched for this page rather than one
  // query per row. EscrowTransaction has no direct partner FK (only via
  // lead.assignedPartnerId), so this can't be a groupBy — fetched once for
  // the whole page and reduced in JS instead.
  const partnerIds = rows.map((r) => r.id);
  const heldEscrows = partnerIds.length
    ? await prisma.escrowTransaction.findMany({
        where: { status: 'HELD', lead: { assignedPartnerId: { in: partnerIds } } },
        select: { amount: true, lead: { select: { assignedPartnerId: true } } },
      })
    : [];
  const heldByPartnerId = new Map();
  for (const e of heldEscrows) {
    const pid = e.lead.assignedPartnerId;
    heldByPartnerId.set(pid, (heldByPartnerId.get(pid) || 0) + e.amount);
  }

  return {
    data: rows.map((r) => ({ ...maskPayout(r), balanceHeld: heldByPartnerId.get(r.id) || 0 })),
    total,
  };
}

async function createPayoutAccount(partnerId, data, kycStatus) {
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
    throw new ApiError(502, 'Could not register your details with the payment provider. Please try again.', { code: 'RAZORPAYX_ERROR' }); // BE-16
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

  // BE-14 — registration is allowed before KYC is approved (so a partner
  // isn't blocked from adding bank details while KYC is still pending), but
  // the account can't go ACTIVE — and therefore can't receive a real
  // payout — until KYC actually clears. Admin's status route is still the
  // only way to flip this to ACTIVE afterward, same as the existing
  // NEEDS_CLARIFICATION path.
  if (status === 'ACTIVE' && kycStatus !== 'VERIFIED') {
    status = 'PENDING_VALIDATION';
    note = 'Awaiting KYC verification before this account can receive payouts.';
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

// M5/BE-23 followup — auto-promote on KYC approval. createPayoutAccount
// above forces a would-be-ACTIVE account to PENDING_VALIDATION purely
// because KYC wasn't verified yet (the fund account itself already passed
// the penny-drop check at registration time — see its kycStatus branch).
// Without this, that promotion never happened automatically once KYC
// later cleared; an admin had to separately remember to flip the status
// by hand via PATCH /admin/partners/:id/payout-account/status. Called
// from admin.service.js's verifyKyc on APPROVE. A no-op for every other
// payoutAccountStatus (NEEDS_CLARIFICATION/SUSPENDED/unset) — those still
// need an admin's explicit look, same as before.
async function promotePayoutAccountOnKycApproval(partnerId) {
  const partner = await prisma.user.findUnique({
    where: { id: partnerId },
    select: { payoutAccountStatus: true, razorpayFundAccountId: true },
  });
  if (partner?.payoutAccountStatus !== 'PENDING_VALIDATION' || !partner.razorpayFundAccountId) return;

  await prisma.user.update({
    where: { id: partnerId },
    data: { payoutAccountStatus: 'ACTIVE', payoutAccountNote: null, payoutValidatedAt: new Date() },
  });

  await createNotification({
    userId: partnerId,
    title: 'Payout account approved',
    message: 'Your KYC is verified — your payout account is now active. Escrow releases will be paid to it.',
    type: 'PAYOUT_ACCOUNT_UPDATE',
    linkUrl: '/partners/profile/bank',
  });
}

// BE-14 — the way to change an ACTIVE account's bank details. createPayoutAccount
// above still refuses outright (409 PAYOUT_ACCOUNT_EXISTS) once ACTIVE; this
// is the only path from there. The OLD fund account stays live and in use
// for any release until admin approves the change (setPayoutAccountStatus
// below) — nothing here touches razorpayFundAccountId yet.
async function requestPayoutAccountChange(partnerId, { legalName, accountNumber, ifsc, bankName, reason }) {
  const partner = await prisma.user.findUnique({ where: { id: partnerId }, select: { id: true, razorpayFundAccountId: true } });
  if (!partner) throw new ApiError(404, 'User not found');
  // H4 fix — "change" implies there's an existing account to change. A
  // partner with none should register one via POST /payout-account
  // instead; this route isn't a substitute first-registration path.
  if (!partner.razorpayFundAccountId) {
    throw new ApiError(400, 'No payout account is registered yet — use POST /partner/payout-account to register one first.', { code: 'NO_FUND_ACCOUNT' });
  }

  const existingChange = await prisma.payoutAccountChange.findFirst({ where: { partnerId, status: 'PENDING' } });
  if (existingChange) {
    throw new ApiError(409, 'A payout account change request is already pending review.', { code: 'CHANGE_ALREADY_PENDING' });
  }

  const change = await prisma.payoutAccountChange.create({
    data: { partnerId, legalName, accountNumber, ifsc, bankName, reason },
  });

  // H4 fix — deliberately NOT touching payoutAccountStatus here. It was
  // previously flipped to PENDING_VALIDATION immediately, but release()
  // only pays out to a partner whose payoutAccountStatus is exactly
  // 'ACTIVE' — so submitting a change request instantly stopped payouts
  // to the CURRENT, still-valid account, directly contradicting this same
  // function's own notification message below ("stays active until
  // approved"). The pending change is tracked solely via this
  // PayoutAccountChange row; the user's status/fund account are only ever
  // touched once admin approves it (setPayoutAccountStatus below).
  await createNotification({
    userId: partnerId,
    title: 'Payout account change submitted',
    message: 'Your request to change your payout bank account is under review. Your current account stays active until this is approved.',
    type: 'PAYOUT_ACCOUNT_UPDATE',
    linkUrl: '/partners/profile/bank',
  });

  return { id: change.id, status: change.status, createdAt: change.createdAt };
}

// 3.5 — admin side of the clarification flow: flag an account for
// re-submission, or clear it once the partner has fixed things.
async function setPayoutAccountStatus(partnerId, status, note, adminId, ip) {
  const partner = await prisma.user.findFirst({
    where: { id: partnerId, role: 'PARTNER' },
    select: { id: true, email: true, phone: true, payoutAccountStatus: true, razorpayContactId: true, razorpayFundAccountId: true },
  });
  if (!partner) throw new ApiError(404, 'Partner not found');

  let pendingChange = await prisma.payoutAccountChange.findFirst({ where: { partnerId, status: 'PENDING' } });

  // BE-18 — ACTIVE/PENDING_VALIDATION implies a real fund account exists
  // (ACTIVE means release() can pay it; PENDING_VALIDATION means one's on
  // file awaiting approval) — without one, release()'s own
  // PARTNER_PAYOUT_ACCOUNT condition on the plan looks satisfied while an
  // actual release would fail with PARTNER_PAYOUT_ACCOUNT_MISSING. Approving
  // ACTIVE via a pending change request is the one legitimate exception —
  // the approval branch further down supplies razorpayFundAccountId from
  // the change record itself, so it's never actually missing by the end.
  if (['ACTIVE', 'PENDING_VALIDATION'].includes(status) && !partner.razorpayFundAccountId && !(status === 'ACTIVE' && pendingChange)) {
    throw new ApiError(409, 'This partner has no payout account registered yet.', { code: 'NO_FUND_ACCOUNT' });
  }

  // BE-14 — a status change other than ACTIVE while a change is pending
  // (e.g. admin flags NEEDS_CLARIFICATION generally, or SUSPENDED)
  // supersedes it — the change request is rejected rather than left
  // dangling, which would otherwise block the partner from ever submitting
  // a new one (CHANGE_ALREADY_PENDING).
  if (pendingChange && status !== 'ACTIVE') {
    await prisma.payoutAccountChange.update({
      where: { id: pendingChange.id },
      data: { status: 'REJECTED', decidedBy: adminId, decidedAt: new Date() },
    });
    pendingChange = null;
  }

  const updateData = {
    payoutAccountStatus: status,
    payoutAccountNote: note ?? null,
    ...(status === 'ACTIVE' ? { payoutValidatedAt: new Date() } : {}),
  };

  // Approving ACTIVE while a change is pending means this approval is for
  // the NEW account the partner asked to switch to, not whatever fund
  // account is already on file — re-run the penny drop on the new account
  // before swapping it in. Approving a change must not skip the same
  // validation a brand-new registration gets.
  if (pendingChange) {
    let fundAccountId;
    try {
      const contact = partner.razorpayContactId
        ? { id: partner.razorpayContactId }
        : await createPayoutContact(pendingChange.legalName, partner.email, partner.phone);
      const fundAccount = await createPayoutFundAccount(contact.id, pendingChange.legalName, pendingChange.ifsc, pendingChange.accountNumber);
      await validateFundAccountOrWarn(fundAccount.id, 'partner');
      fundAccountId = fundAccount.id;
      updateData.razorpayContactId = contact.id;
    } catch (err) {
      throw new ApiError(400, `The new bank account could not be validated: ${err.message}`, { code: 'FUND_ACCOUNT_REJECTED' });
    }
    updateData.razorpayFundAccountId = fundAccountId;
    updateData.bankHolderName = pendingChange.legalName;
    updateData.bankAccountNo = pendingChange.accountNumber;
    updateData.bankIfsc = pendingChange.ifsc;
    updateData.bankLinkedAt = new Date();
    if (pendingChange.bankName) updateData.bankName = pendingChange.bankName;
  }

  const updated = await prisma.user.update({
    where: { id: partnerId },
    data: updateData,
    select: PAYOUT_PUBLIC_FIELDS,
  });

  if (pendingChange) {
    await prisma.payoutAccountChange.update({
      where: { id: pendingChange.id },
      data: { status: 'APPROVED', decidedBy: adminId, decidedAt: new Date() },
    });
  }

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
    after: { payoutAccountStatus: status, note: note ?? null, approvedChangeId: pendingChange?.id }, ipAddress: ip,
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
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!ticket) throw new ApiError(404, 'Support ticket not found');
  return ticket;
}

// B73 — a partner follows up on their own ticket. An answered or resolved ticket goes back to OPEN so the admin sees it;
// a CLOSED ticket stays closed (raise a new one).
const MAX_PARTNER_REPLIES_PER_TICKET = 100;

async function replyToSupportTicket(partnerId, ticketId, message) {
  const ticket = await prisma.partnerSupportTicket.findFirst({ where: { id: ticketId, partnerId } });
  if (!ticket) throw new ApiError(404, 'Support ticket not found');
  if (ticket.status === 'CLOSED') throw new ApiError(409, 'This ticket is closed. Raise a new ticket instead.', { code: 'TICKET_CLOSED' });

  // A real conversation is a few messages. A cap keeps one ticket from being used to flood the admins' inbox and the database.
  const sent = await prisma.partnerSupportTicketMessage.count({ where: { ticketId, authorType: 'PARTNER' } });
  if (sent >= MAX_PARTNER_REPLIES_PER_TICKET) {
    throw new ApiError(429, 'This ticket already has many messages. Please wait for the support team to reply, or raise a new ticket.', { code: 'TICKET_REPLY_LIMIT' });
  }

  const saved = await prisma.partnerSupportTicketMessage.create({
    data: { ticketId, authorType: 'PARTNER', authorId: partnerId, body: message },
  });
  if (ticket.status !== 'OPEN') {
    await prisma.partnerSupportTicket.update({ where: { id: ticketId }, data: { status: 'OPEN', resolvedAt: null } });
  }
  await notifyAdmins({
    title: 'Partner replied on a support ticket',
    message: `${ticket.ticketNo}: ${message.slice(0, 160)}`,
    type: 'PARTNER_TICKET_REPLY',
    linkUrl: '/admin/partner-support',
  });
  return saved;
}

async function createSupportTicket(partnerId, data) {
  // ticketNo is count+1, which collides (unique index) if two tickets are
  // raised at once or an older one was deleted — retry with the next number
  // instead of surfacing a 500.
  const count = await prisma.partnerSupportTicket.count();
  let ticket;
  for (let attempt = 0; attempt < 5 && !ticket; attempt += 1) {
    const ticketNo = `SUP-${String(count + 1 + attempt).padStart(4, '0')}`;
    try {
      ticket = await prisma.partnerSupportTicket.create({ data: { partnerId, ticketNo, ...data } });
    } catch (err) {
      if (err.code !== 'P2002' || attempt === 4) throw err;
    }
  }

  // B73 — admins had no bell entry for a new partner support ticket.
  await notifyAdmins({
    title: 'New partner support ticket',
    message: `${ticket.ticketNo}: ${ticket.subject}`,
    type: 'PARTNER_TICKET_NEW',
    linkUrl: '/admin/partner-support',
  });
  return ticket;
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

// ─── Audit of identity and payout details (money model phase 2) ──────────────
// PAN, GSTIN, bank and billing details decide who is paid, how much is withheld
// and which paperwork applies, so every change is recorded with old and new
// value (account number and PAN masked). The wrappers below cover each way a
// partner can change them.
const IDENTITY_FIELDS = ['gstin', 'panNumber', 'bankHolderName', 'bankAccountNo', 'bankIfsc', 'bankName', 'billingLegalName', 'billingAddress'];
const MASKED_FIELDS = ['bankAccountNo', 'panNumber'];
const maskTail = (v) => (v ? `${'X'.repeat(Math.max(0, String(v).length - 4))}${String(v).slice(-4)}` : null);

async function identitySnapshot(partnerId) {
  return prisma.user.findUnique({ where: { id: partnerId }, select: Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, true])) });
}

function identityDiff(before, after) {
  const b = {}; const a = {};
  for (const f of IDENTITY_FIELDS) {
    if ((before?.[f] ?? null) !== (after?.[f] ?? null)) {
      b[f] = MASKED_FIELDS.includes(f) ? maskTail(before?.[f]) : before?.[f] ?? null;
      a[f] = MASKED_FIELDS.includes(f) ? maskTail(after?.[f]) : after?.[f] ?? null;
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

function withIdentityAudit(action, fn) {
  return async function audited(partnerId, ...args) {
    const before = await identitySnapshot(partnerId).catch(() => null);
    const result = await fn(partnerId, ...args);
    try {
      const after = await identitySnapshot(partnerId);
      const d = identityDiff(before, after);
      if (d.changed) {
        await createAuditLog({ adminId: partnerId, actorRole: 'PARTNER', action, targetType: 'User', targetId: partnerId, before: d.before, after: d.after });
      }
    } catch (err) {
      logger.warn('[Partners] audit of identity change failed', { action, partnerId, error: err.message });
    }
    return result;
  };
}

// eslint-disable-next-line no-func-assign
updateProfile = withIdentityAudit('PARTNER_PROFILE_CHANGED', updateProfile);
// eslint-disable-next-line no-func-assign
updateBilling = withIdentityAudit('PARTNER_BILLING_CHANGED', updateBilling);
// eslint-disable-next-line no-func-assign
updateBankAccount = withIdentityAudit('PARTNER_BANK_CHANGED', updateBankAccount);
// eslint-disable-next-line no-func-assign
createPayoutAccount = withIdentityAudit('PARTNER_PAYOUT_ACCOUNT_CREATED', createPayoutAccount);

module.exports = {
  acceptPartnerTerms, recordKycConsent, submitKyc, runAutomatedKycChecks, getProfile, updateProfile, uploadProfilePhoto, getListing, getMyListings,
  getFinanceSummary, getRatings, listMyPayouts,
  getSettings, updateSettings,
  getBankAccount, updateBankAccount, getBilling, updateBilling,
  getPayoutAccount, createPayoutAccount, requestPayoutAccountChange, setPayoutAccountStatus, listPayoutAccounts, maskPayout,
  promotePayoutAccountOnKycApproval,
  getSupportTickets, getSupportTicketById, createSupportTicket, replyToSupportTicket,
  getPartnerAnalytics,
  syncPayoutAccount,
};
