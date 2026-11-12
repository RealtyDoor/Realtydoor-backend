const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { sendBuyerFeedbackRequest } = require('../lib/wati');
const logger = require('../lib/logger');

// Runs every hour.
// Fires WhatsApp buyer feedback bot 24h after site visit OTP verified (PRD §5 Leakage 1).
// If buyer says "Yes" but partner marked "Dropped", Admin gets a discrepancy alert.
//
// Audit Nov 2026 (L1). The filter was `whatsappSentAt: null`. In MongoDB a field that was never written is not null, so it matched
// nothing and no buyer was ever asked. NOT_YET covers both. A visit older than MAX_AGE_DAYS is left alone: asking a buyer about a
// visit from weeks ago (everything that piled up while the job found nothing) would only confuse them.
const notYet = (field) => ({ OR: [{ [field]: null }, { [field]: { isSet: false } }] });
const MAX_AGE_DAYS = 7;
const dueWhere = (now = Date.now()) => ({
  isOtpVerified: true,
  otpVerifiedAt: { lte: new Date(now - 24 * 60 * 60 * 1000), gte: new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000) },
  status: { not: 'DROPPED' },
  AND: [notYet('whatsappSentAt'), notYet('doNotContactAt')], // L3: a buyer who asked not to be contacted is not asked
});

function start() {
  cron.schedule('0 * * * *', async () => {
    let leads;
    try {
      leads = await prisma.lead.findMany({
        where: dueWhere(),
        include: { assignedPartner: { select: { name: true, companyName: true } } },
        orderBy: { otpVerifiedAt: 'asc' },
      });
    } catch (err) {
      logger.error('[WhatsAppFeedbackJob] DB query failed', { error: err.message, stack: err.stack });
      return;
    }

    if (!leads.length) return;

    logger.info(`[WhatsAppFeedbackJob] Processing ${leads.length} lead(s)`);

    for (const lead of leads) {
      try {
        const partnerName = lead.assignedPartner?.companyName
          || lead.assignedPartner?.name
          || 'your agent';

        await sendBuyerFeedbackRequest(lead.buyerPhone, partnerName);
        await prisma.lead.update({
          where: { id: lead.id },
          data: { whatsappSentAt: new Date(), buyerFeedbackStatus: 'PENDING' },
        });
        logger.info('[WhatsAppFeedbackJob] Feedback sent', { leadId: lead.id });
      } catch (err) {
        logger.error('[WhatsAppFeedbackJob] Failed for lead', {
          leadId: lead.id,
          error: err.message,
        });
      }
    }
  });

  logger.info('[Jobs] WhatsApp feedback job scheduled (every hour)');
}

module.exports = { start, dueWhere, notYet };
