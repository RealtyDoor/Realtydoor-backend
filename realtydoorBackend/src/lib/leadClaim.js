// B21 — a partner-added lead is created with no buyerId on purpose (the buyer
// hasn't authenticated or consented to it appearing in their account). That
// left the buyer with no inquiry in the app and no way to pay the escrow token.
// A lead may be linked to a buyer account only when the account proves it is
// the person the partner named: same phone number AND that phone verified by
// OTP. Two paths use this: admin confirm links automatically, and the buyer
// can claim it themselves.
const UNLINKABLE_STATUSES = ['AWAITING_ADMIN', 'DROPPED'];

// Mongo: a lead created without buyerId has the field MISSING, which a plain
// `buyerId: null` filter does not match.
const UNLINKED_LEAD_WHERE = { OR: [{ buyerId: null }, { buyerId: { isSet: false } }] };

function canLinkLeadToUser(lead, user) {
  if (!lead || !user) return false;
  if (lead.buyerId) return false;
  if (user.role !== 'USER' || user.deletedAt || user.isSuspended) return false;
  if (user.phoneVerified !== true || !user.phone) return false;
  if (!lead.buyerPhone || lead.buyerPhone !== user.phone) return false;
  if (UNLINKABLE_STATUSES.includes(lead.status)) return false;
  return true;
}

module.exports = { canLinkLeadToUser, UNLINKED_LEAD_WHERE, UNLINKABLE_STATUSES };
