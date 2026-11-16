const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { sendBuyerFeedbackRequest } = require('../lib/wati');
const logger = require('../lib/logger');
const { notYet } = require('./whatsappFeedback');

// Runs every hour.
// Sends a second WhatsApp nudge 7 days after the buyer replied STILL_DECIDING (Appendix C.4).
// Audit Nov 2026 (L1, L3): "not sent yet" must also match a field that was never written, a buyer who asked not to be contacted is
// skipped, and a reply older than 21 days is too old to follow up on.
const dueWhere = (now = Date.now()) => ({
  buyerFeedbackStatus: 'STILL_DECIDING',
  feedbackReceivedAt: { lte: new Date(now - 7 * 24 * 60 * 60 * 1000), gte: new Date(now - 21 * 24 * 60 * 60 * 1000) },
  status: { notIn: ['DROPPED', 'CLOSED'] },
  AND: [notYet('secondFollowupSentAt'), notYet('doNotContactAt')],
});

function start() {
  cron.schedule('0 * * * *', async () => {
    let leads;
    try {
      leads = await prisma.lead.findMany({
        where: dueWhere(),
        include: { assignedPartner: { select: { name: true, companyName: true } } },
        orderBy: { feedbackReceivedAt: 'asc' },
      });
    } catch (err) {
      logger.error('[StillDecidingJob] DB query failed', { error: err.message, stack: err.stack });
      return;
    }

    if (!leads.length) return;

    logger.info(`[StillDecidingJob] Processing ${leads.length} lead(s)`);

    for (const lead of leads) {
      try {
        const partnerName = lead.assignedPartner?.companyName
          || lead.assignedPartner?.name
          || 'your agent';

        // Audit Nov 2026 (O5). Claim first, send second (see whatsappFeedback.js).
        const claim = await prisma.lead.updateMany({
          where: { AND: [{ id: lead.id }, notYet('secondFollowupSentAt')] },
          data: { secondFollowupSentAt: new Date() },
        });
        if (claim.count === 0) continue;
        try {
          await sendBuyerFeedbackRequest(lead.buyerPhone, partnerName);
        } catch (err) {
          await prisma.lead.updateMany({ where: { id: lead.id }, data: { secondFollowupSentAt: null } }).catch(() => null);
          throw err;
        }
        logger.info('[StillDecidingJob] Follow-up sent', { leadId: lead.id });
      } catch (err) {
        logger.error('[StillDecidingJob] Failed for lead', {
          leadId: lead.id,
          error: err.message,
        });
      }
    }
  });

  logger.info('[Jobs] STILL_DECIDING 7-day follow-up job scheduled (every hour)');
}

module.exports = { start, dueWhere };
