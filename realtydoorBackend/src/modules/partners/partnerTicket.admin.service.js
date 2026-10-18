const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const { createAuditLog } = require('../../lib/auditLog');
const { createNotification } = require('../../lib/notifications');
const { send } = require('../../lib/email');
const { TICKET_STATUSES } = require('./partnerTicket.admin.validator');

const PARTNER_SELECT = { id: true, name: true, phone: true, email: true, notifEmail: true };

// PartnerSupportTicket.partner is a required relation, so a nested
// `include`/relation `where` on it throws ("Field partner is required to
// return data, got null instead") the moment one ticket's partner has been
// hard-deleted — same class of bug already fixed this session for the
// escrow fees-due list and the locality-insight list. Partners are always
// fetched separately here and attached as `null` for any that no longer
// exist, instead of letting the join fail.
async function attachPartners(tickets) {
  const partnerIds = [...new Set(tickets.map((t) => t.partnerId))];
  const partners = partnerIds.length
    ? await prisma.user.findMany({ where: { id: { in: partnerIds } }, select: PARTNER_SELECT })
    : [];
  const byId = new Map(partners.map((p) => [p.id, p]));
  return tickets.map((t) => ({ ...t, partner: byId.get(t.partnerId) || null }));
}

async function listPartnerTickets(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.category) where.category = filters.category;
  if (filters.search) {
    // Matching through the required `partner` relation via a Prisma relation
    // filter risks the same hard-deleted-partner failure as the include
    // above, so partner-name/phone matches are resolved as a separate
    // lookup and folded in as a plain partnerId list instead.
    const matchingPartners = await prisma.user.findMany({
      where: { OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search, mode: 'insensitive' } },
      ] },
      select: { id: true },
    });
    where.OR = [
      { ticketNo: { contains: filters.search, mode: 'insensitive' } },
      { subject: { contains: filters.search, mode: 'insensitive' } },
      ...(matchingPartners.length ? [{ partnerId: { in: matchingPartners.map((p) => p.id) } }] : []),
    ];
  }

  const [data, total, statusCounts] = await Promise.all([
    prisma.partnerSupportTicket.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.partnerSupportTicket.count({ where }),
    // Not narrowed by the current filters — same reasoning as
    // listContactMessages' statusCounts: tab counts must not reset to the
    // filtered total once a tab is selected.
    Promise.all(TICKET_STATUSES.map(async (st) => [st, await prisma.partnerSupportTicket.count({ where: { status: st } })])),
  ]);

  return {
    data: await attachPartners(data),
    total,
    statusCounts: Object.fromEntries(statusCounts),
  };
}

async function getPartnerTicketById(id) {
  const ticket = await prisma.partnerSupportTicket.findUnique({ where: { id } });
  if (!ticket) throw new ApiError(404, 'Support ticket not found');
  const [withPartner] = await attachPartners([ticket]);
  return withPartner;
}

async function updatePartnerTicket(id, { status, adminReply }, adminId, ip) {
  const existing = await prisma.partnerSupportTicket.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Support ticket not found');

  const data = {};
  if (adminReply !== undefined) {
    data.adminReply = adminReply;
    data.repliedAt = new Date();
    // A reply implies the ticket moved forward — unless the caller also
    // explicitly asked for a different status (e.g. reply + resolve in one
    // call), default it to ANSWERED rather than leaving it OPEN.
    data.status = status || 'ANSWERED';
  } else if (status) {
    data.status = status;
  }
  if (data.status === 'RESOLVED') data.resolvedAt = new Date();

  const updated = await prisma.partnerSupportTicket.update({ where: { id }, data });

  await createAuditLog({
    adminId, action: 'PARTNER_TICKET_UPDATED', targetType: 'PartnerSupportTicket', targetId: id,
    before: { status: existing.status, adminReply: existing.adminReply },
    after: { status: updated.status, adminReply: updated.adminReply },
    ipAddress: ip,
  });

  const title = adminReply !== undefined ? 'Your support ticket was answered' : 'Your support ticket was updated';
  const message = adminReply !== undefined
    ? `Reply on ${existing.ticketNo} — ${existing.subject}: ${adminReply.slice(0, 200)}`
    : `${existing.ticketNo} — ${existing.subject} is now ${updated.status.replace('_', ' ')}.`;

  await createNotification({
    userId: existing.partnerId,
    title, message,
    type: 'PARTNER_TICKET_UPDATED',
    linkUrl: `/partner/support-tickets/${id}`,
  });

  // Hard-deleted partner → nothing to email; the notification above is
  // harmless to still write (same tolerance this codebase already has
  // elsewhere for a dangling userId).
  const partner = await prisma.user.findUnique({ where: { id: existing.partnerId }, select: PARTNER_SELECT });
  if (partner?.email) {
    await send({
      to: partner.email,
      subject: `Re: ${existing.ticketNo} — ${existing.subject}`,
      html: adminReply !== undefined
        ? `<p>${adminReply.replace(/\n/g, '<br>')}</p>`
        : `<p>Your support ticket ${existing.ticketNo} is now <strong>${updated.status.replace('_', ' ')}</strong>.</p>`,
      user: partner,
    }).catch((err) => logger.error('[partnerTicketUpdate] email failed', { ticketId: id, error: err.message }));
    // Best-effort — a failed email must not fail the status/reply update itself.
  }

  return { ...updated, partner: partner || null };
}

module.exports = { listPartnerTickets, getPartnerTicketById, updatePartnerTicket };
