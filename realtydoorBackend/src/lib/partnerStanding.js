// Audit Nov 2026, phase 4 (P1, P2, P5). Two questions that used to be answered differently in every file:
// "may this partner be paid?" and "may this partner's listing be public?". Every release path and every
// public listing query goes through here, so suspending a partner or rejecting their KYC takes effect everywhere at once.

// What a caller must select on the User row before asking partnerPayoutBlocker.
const PAYABLE_PARTNER_SELECT = {
  id: true, role: true, kycStatus: true, isSuspended: true, deletedAt: true,
  payoutAccountStatus: true, razorpayFundAccountId: true,
};

// Returns null when the partner may be paid, or { code, message } saying why not.
function partnerPayoutBlocker(partner) {
  if (!partner) return { code: 'PARTNER_NOT_FOUND', message: 'The partner account no longer exists.' };
  if (partner.deletedAt) return { code: 'PARTNER_ACCOUNT_DELETED', message: 'The partner account has been deleted.' };
  if (partner.isSuspended) return { code: 'PARTNER_SUSPENDED', message: 'The partner is suspended. Lift the suspension before paying them.' };
  if (partner.kycStatus !== 'VERIFIED') {
    return { code: 'PARTNER_KYC_NOT_VERIFIED', message: `The partner's KYC is ${String(partner.kycStatus || 'not submitted').toLowerCase().replace(/_/g, ' ')}. A payout needs verified KYC.` };
  }
  if (!partner.razorpayFundAccountId) return { code: 'PARTNER_PAYOUT_ACCOUNT_MISSING', message: 'The partner has no payout account yet.' };
  if (partner.payoutAccountStatus !== 'ACTIVE') {
    return { code: 'PARTNER_PAYOUT_ACCOUNT_NOT_ACTIVE', message: `The partner's payout account is ${partner.payoutAccountStatus || 'not set up'}. Resolve that before paying them.` };
  }
  return null;
}

// A listing is public only while the account behind it is in good standing: not suspended, not deleted, and,
// when it is a partner, KYC verified. Listings owned by staff (Realtydoor's own) pass on the first two.
// A listing whose owner row no longer exists does not match (`is` needs a row), so it is hidden too.
// `isSuspended` is a required field, so `NOT true` is used rather than `isSet`; `deletedAt` is unset on most rows.
const LIVE_PARTNER = {
  partner: {
    is: {
      AND: [
        { NOT: { isSuspended: true } },
        { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
        { OR: [{ role: { not: 'PARTNER' } }, { kycStatus: 'VERIFIED' }] },
      ],
    },
  },
};

// The same rule for a row already in hand (select role, kycStatus, isSuspended, deletedAt).
function listingOwnerBlocker(owner) {
  if (!owner) return { code: 'LISTING_OWNER_MISSING', message: 'The account that owns this listing no longer exists.' };
  if (owner.deletedAt) return { code: 'LISTING_OWNER_DELETED', message: 'The partner who owns this listing has deleted their account.' };
  if (owner.isSuspended) return { code: 'LISTING_OWNER_SUSPENDED', message: 'The partner who owns this listing is suspended.' };
  if (owner.role === 'PARTNER' && owner.kycStatus !== 'VERIFIED') {
    return { code: 'LISTING_OWNER_KYC', message: "The partner's KYC is not verified, so their listing cannot be public." };
  }
  return null;
}

module.exports = { PAYABLE_PARTNER_SELECT, partnerPayoutBlocker, LIVE_PARTNER, listingOwnerBlocker };
