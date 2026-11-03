const prisma = require('./prisma');
const logger = require('./logger');
const { createNotification, notifyAdmins } = require('./notifications');

/**
 * A listing stopped being available (taken down, or marked sold or rented) while leads on it were still open. Everyone in the middle
 * hears it in the app, so nobody drives to a site visit for a property that is gone: the partner who holds each lead, the buyer if their
 * account is linked, and the admins in one summary. Leads are NOT dropped here (a held token has to be refunded by a person); an admin
 * decides each one. In-app notifications only. Returns how many open leads were told.
 */
async function notifyOpenLeadsPropertyUnavailable(property, why) {
  try {
    const leads = await prisma.lead.findMany({
      where: { propertyId: property.id, status: { notIn: ['CLOSED', 'DROPPED'] } },
      select: { id: true, refCode: true, status: true, buyerId: true, assignedPartnerId: true },
    });
    if (!leads.length) return 0;
    for (const l of leads) {
      const text = `"${property.title}" is no longer available (${why}).`;
      if (l.assignedPartnerId) {
        await createNotification({ userId: l.assignedPartnerId, title: 'Property no longer available', message: `${l.refCode || 'A lead'}: ${text} Do not book new visits for it; the team will contact you.`, type: 'LEAD_ASSIGNED', linkUrl: `/partners/leads/${l.id}` }).catch(() => null);
      }
      if (l.buyerId) {
        await createNotification({ userId: l.buyerId, title: 'This property is no longer available', message: `${l.refCode || 'Your inquiry'}: ${text} Our team will help you with similar options.`, type: 'LEAD_ASSIGNED', linkUrl: `/user/inquiries/${l.id}` }).catch(() => null);
      }
    }
    await notifyAdmins({
      title: 'Open leads on an unavailable property',
      message: `"${property.title}" is no longer available (${why}). ${leads.length} open lead(s) need a decision (offer another property, drop, or refund a held token): ${leads.slice(0, 8).map((l) => l.refCode || l.id).join(', ')}.`,
      type: 'LEAD_NEW',
      linkUrl: '/admin/leads',
    });
    return leads.length;
  } catch (err) {
    logger.warn('[propertyUnavailable] could not notify open leads', { propertyId: property.id, error: err.message });
    return 0;
  }
}

module.exports = { notifyOpenLeadsPropertyUnavailable };
