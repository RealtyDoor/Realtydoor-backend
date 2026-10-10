const { createClerkClient } = require('@clerk/clerk-sdk-node');
const prisma = require('./prisma');
const logger = require('./logger');
const ApiError = require('../utils/ApiError');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// Backend gaps handoff, 2026-10-10 (#2) — "revoke Clerk sessions at request
// time" when a deletion is requested, so the read-only lock (middleware/
// auth.js) isn't relying solely on the next API call catching it — a token
// already in a browser's memory stays valid until Clerk expires it
// otherwise. Best-effort: Clerk being briefly unavailable must never block
// the deletion request itself (same "never let a side-effect fail the main
// operation" pattern as this codebase's notification sends).
async function revokeAllSessions(clerkId) {
  try {
    const { data: sessions } = await clerk.sessions.getSessionList({ userId: clerkId, status: 'active' });
    await Promise.all((sessions || []).map((s) => clerk.sessions.revokeSession(s.id)));
  } catch (err) {
    logger.warn('[AccountDeletion] Failed to revoke Clerk sessions', { clerkId, error: err.message });
  }
}

// Privacy spec, 2026-10-10 — "deletion is blocked while money is in flight,
// such as an escrow payment held or a loan in progress." Checked both when
// the user requests deletion (users.service.js) and again by the daily cron
// right before it actually anonymizes the row (jobs/processAccountDeletions.js),
// since 30 days can easily pass between request and grace-period expiry and
// the user's situation can change in that window.
async function getMoneyInFlightReasons(userId) {
  const [escrow, loan] = await Promise.all([
    prisma.escrowTransaction.findFirst({
      where: { buyerId: userId, status: { in: ['PAYMENT_PENDING', 'HELD', 'HELD_PAYOUT_FAILED'] } },
      select: { status: true },
    }),
    prisma.loanApplication.findFirst({
      where: { userId, status: { notIn: ['DISBURSED', 'REJECTED'] } },
      select: { status: true },
    }),
  ]);
  const reasons = [];
  if (escrow) reasons.push(`An escrow payment is currently ${escrow.status.replace(/_/g, ' ').toLowerCase()}`);
  if (loan)   reasons.push(`A loan application is still in progress (${loan.status.replace(/_/g, ' ').toLowerCase()})`);
  return reasons;
}

async function hasMoneyInFlight(userId) {
  return (await getMoneyInFlightReasons(userId)).length > 0;
}

// Privacy spec, 2026-10-10 — personal data is anonymised, not hard-deleted:
// Lead/EscrowTransaction/LoanApplication/Commission rows that reference this
// userId are business records the spec says must survive, and they do so
// automatically by simply never being touched here — they keep pointing at
// this same User row, which now carries no personal details. Consent
// timestamps/versions (termsAcceptedAt, marketingOptInAt, kycVerifiedAt,
// partnerTermsAcceptedAt, etc.) are deliberately left as-is: they aren't
// identifying on their own and are themselves part of the compliance record.
// email/clerkId are reassigned to a unique anonymized placeholder (not
// cleared to null) specifically to resolve the long-standing known
// limitation on `deletedAt` (user.prisma) that those two @unique columns
// were never freed by the old soft-delete-only path.
async function anonymizeUser(userId) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      email: `deleted-${userId}@anonymized.realtydoor.local`,
      clerkId: `deleted-${userId}`,
      name: 'Deleted User',
      phone: null,
      address: null,
      profileImageUrl: null,
      bio: null,
      websiteUrl: null,
      companyName: null,
      reraNumber: null,
      gstin: null,
      panNumber: null,
      panVerifiedName: null,
      gstinVerifiedName: null,
      reraVerifiedName: null,
      kycDocumentUrls: [],
      kycRejectionNote: null,
      bankName: null,
      bankBranch: null,
      bankAccountNo: null,
      bankIfsc: null,
      bankHolderName: null,
      billingLegalName: null,
      billingAddress: null,
      billingAccountsContactName: null,
      billingAccountsContactEmail: null,
      billingAccountsContactPhone: null,
      razorpayContactId: null,
      razorpayFundAccountId: null,
      deletedAt: new Date(),
    },
  });
}

// Backend gaps handoff, 2026-10-10 (#2) — "pause open leads" once the buyer
// has requested deletion. No new Lead status: that would mean a new branch
// in every existing status-machine check across leads.service.js/
// admin.service.js for what was explicitly framed as a side effect of the
// deletion request, not a durable business state — and it has to be exactly
// as reversible as the request itself (cancelling the deletion must resume
// the lead with zero cleanup). A live guard achieves that for free: nothing
// is written to the Lead, so there's nothing to undo on cancel. Applied at
// the points a partner/admin would otherwise move the lead forward
// (assignment, OTP send/verify) — buyerId is null for a free-text lead with
// no registered account, which has nothing to check and is left alone.
async function assertLeadNotPaused(buyerId) {
  if (!buyerId) return;
  const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { deletionRequestedAt: true } });
  if (buyer?.deletionRequestedAt) {
    throw new ApiError(403, "This lead's buyer has requested account deletion — the lead is paused until they cancel it.", {
      code: 'LEAD_PAUSED',
    });
  }
}

module.exports = { hasMoneyInFlight, getMoneyInFlightReasons, anonymizeUser, revokeAllSessions, assertLeadNotPaused };
