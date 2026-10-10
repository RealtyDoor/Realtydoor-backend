const prisma = require('./prisma');

// Privacy spec, 2026-10-10 — "deletion is blocked while money is in flight,
// such as an escrow payment held or a loan in progress." Checked both when
// the user requests deletion (users.service.js) and again by the daily cron
// right before it actually anonymizes the row (jobs/processAccountDeletions.js),
// since 30 days can easily pass between request and grace-period expiry and
// the user's situation can change in that window.
async function hasMoneyInFlight(userId) {
  const [escrow, loan] = await Promise.all([
    prisma.escrowTransaction.findFirst({
      where: { buyerId: userId, status: { in: ['PAYMENT_PENDING', 'HELD', 'HELD_PAYOUT_FAILED'] } },
      select: { id: true },
    }),
    prisma.loanApplication.findFirst({
      where: { userId, status: { notIn: ['DISBURSED', 'REJECTED'] } },
      select: { id: true },
    }),
  ]);
  return Boolean(escrow || loan);
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

module.exports = { hasMoneyInFlight, anonymizeUser };
