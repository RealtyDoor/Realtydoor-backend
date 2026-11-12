const prisma = require('./prisma');

// Audit Nov 2026 (L3). "Do not contact" belongs to the buyer (the mobile number), not to one lead: setDoNotContact marks every lead
// of that number. A lead made later for the same number has to carry the mark too, or the next WhatsApp goes out as if nothing was said.
// Returns the date the buyer asked, or null.
async function doNotContactSince(phone) {
  if (!phone) return null;
  const marked = await prisma.lead.findFirst({
    where: { buyerPhone: phone, doNotContactAt: { not: null } },
    orderBy: { doNotContactAt: 'asc' },
    select: { doNotContactAt: true },
  });
  return marked?.doNotContactAt || null;
}

module.exports = { doNotContactSince };
