const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { notifyUser } = require('../lib/wati');
const logger = require('../lib/logger');

// Runs every hour. A buyer whose site visit starts in the next 1 to 3 hours gets one WhatsApp reminder
// (template visit_reminder_v2, the draft already in WATI). The profile's "visit reminders" switch is respected. There is no "reminder sent" column on
// the lead, so a reminder already logged for the lead (WatiMessageLog) is not sent again. The code is NOT in the message.
// Until visit_reminder_v2 is in WATI_LIVE_TEMPLATES, notifyUser sends nothing, so this job is harmless to run.
const WINDOW_START_HOURS = 1;
const WINDOW_END_HOURS = 3;

async function sendDueReminders(now = new Date()) {
  const from = new Date(now.getTime() + WINDOW_START_HOURS * 3600 * 1000);
  const to = new Date(now.getTime() + WINDOW_END_HOURS * 3600 * 1000);
  const leads = await prisma.lead.findMany({
    where: { status: 'SITE_VISIT_SCHEDULED', siteVisitScheduledAt: { gte: from, lte: to }, buyerId: { not: null } },
    select: {
      id: true, buyerId: true, siteVisitScheduledAt: true, propertyInterest: true,
      property: { select: { title: true } },
      assignedPartner: { select: { name: true, companyName: true } },
    },
  });
  let sent = 0;
  for (const lead of leads) {
    const buyer = await prisma.user.findUnique({ where: { id: lead.buyerId }, select: { notifVisitReminders: true } });
    if (buyer && buyer.notifVisitReminders === false) continue;
    const already = await prisma.watiMessageLog.findFirst({ where: { leadId: lead.id, templateName: 'visit_reminder_v2' }, select: { id: true } });
    if (already) continue;
    await notifyUser(lead.buyerId, 'visit_reminder_v2', {
      name: '$userName',
      property_title: lead.property?.title || lead.propertyInterest || 'the property',
      visit_time: lead.siteVisitScheduledAt.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
      partner_name: lead.assignedPartner?.companyName || lead.assignedPartner?.name || 'your Realtydoor partner',
    }, { leadId: lead.id });
    sent += 1;
  }
  return sent;
}

function start() {
  cron.schedule('15 * * * *', async () => {
    try {
      const n = await sendDueReminders();
      if (n) logger.info('[VisitReminderJob] reminders sent', { count: n });
    } catch (err) {
      logger.error('[VisitReminderJob] failed', { error: err.message });
    }
  });
  logger.info('[Jobs] Visit reminder job scheduled (every hour)');
}

module.exports = { start, sendDueReminders };
