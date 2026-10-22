// B90 — a buyer's inquiries are linked either by account (Lead.buyerId) or,
// for leads created without an account link (partner-added, admin-created,
// legacy rows), only by phone. Counting buyerId alone showed 0 for those
// buyers. A lead already linked to ANOTHER account is never claimed by phone.
function countInquiriesByUser(users, leads) {
  const counts = new Map(users.map((u) => [u.id, 0]));
  const idByPhone = new Map();
  users.forEach((u) => { if (u.phone) idByPhone.set(u.phone, u.id); });
  for (const lead of leads) {
    const owner = lead.buyerId && counts.has(lead.buyerId)
      ? lead.buyerId
      : (!lead.buyerId && lead.buyerPhone ? idByPhone.get(lead.buyerPhone) : undefined);
    if (owner) counts.set(owner, counts.get(owner) + 1);
  }
  return counts;
}

// T42 — the same ownership rule as countInquiriesByUser, for one user: the
// where-clause that finds the leads the admin user page lists, so the tab and
// the "Inquiries N" count can never disagree.
function inquiryWhereForUser(user) {
  return {
    OR: [
      { buyerId: user.id },
      ...(user.phone ? [{ buyerId: null, buyerPhone: user.phone }] : []),
    ],
  };
}

module.exports = { countInquiriesByUser, inquiryWhereForUser };
