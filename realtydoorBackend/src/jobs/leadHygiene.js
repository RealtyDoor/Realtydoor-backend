const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { createNotification, notifyAdmins } = require('../lib/notifications');
const { createAuditLog } = require('../lib/auditLog');
const { getConfigNumber } = require('../modules/config/config.service');
const { getMoneySettings } = require('../modules/money/moneyConfig');
const { partnerResponseAction, windowWarning } = require('../lib/leadTimers');

// Runs hourly. Two rules that keep the company, not the partner, in charge of the buyer. Both are quiet until switched on:
//  1. lead_partner_response_hours (platform config, 0 = off): an assigned lead the partner has not started (no visit booked, no money)
//     gets a reminder at half that time and goes back to the company pool at the full time; the partner and the admins are told.
//  2. A partner who registered a buyer is warned once, in the app, when 15 days or fewer remain of their partner_lead_window_days hold.
// Messages here are in-app notifications only; nothing goes out by WhatsApp or email.
const WARN_DAYS = 15;

async function runOnce(now = new Date()) {
  const out = { reminded: 0, returned: 0, warned: 0 };
  const hours = await getConfigNumber('lead_partner_response_hours', 0);

  if (hours > 0) {
    const leads = await prisma.lead.findMany({
      where: { status: 'ASSIGNED', assignedPartnerId: { isSet: true } },
      include: { escrowTransactions: { select: { status: true } } },
      take: 500,
    });
    for (const lead of leads) {
      const action = partnerResponseAction(lead, now, hours);
      if (action === 'remind') {
        await createNotification({
          userId: lead.assignedPartnerId, title: 'Lead waiting for you',
          message: `${lead.refCode || 'A lead'} has been with you for a while with no visit booked. Book the site visit, or request to drop it, or it goes back to the pool.`,
          type: 'LEAD_ASSIGNED', linkUrl: `/partners/leads/${lead.id}`,
        }).catch(() => null);
        await prisma.lead.update({ where: { id: lead.id }, data: { responseReminderAt: now } });
        out.reminded += 1;
      } else if (action === 'return') {
        await prisma.lead.update({ where: { id: lead.id }, data: { assignedPartnerId: null, status: 'UNASSIGNED', assignedAt: null, responseReminderAt: null } });
        await createNotification({
          userId: lead.assignedPartnerId, title: 'Lead returned to the pool',
          message: `${lead.refCode || 'A lead'} went back to the pool because no visit was booked in time.`, type: 'LEAD_DROPPED', linkUrl: `/partners/leads/${lead.id}`,
        }).catch(() => null);
        await createAuditLog({
          adminId: null, actorRole: 'SYSTEM', action: 'LEAD_RETURNED_TO_POOL', targetType: 'Lead', targetId: lead.id,
          before: { assignedPartnerId: lead.assignedPartnerId, status: lead.status }, after: { status: 'UNASSIGNED', why: `no action within ${hours} hours` },
        }).catch(() => null);
        out.returned += 1;
      }
    }
    if (out.returned) {
      await notifyAdmins({ title: 'Leads returned to the pool', message: `${out.returned} lead(s) went back to the pool because the partner did not start them within ${hours} hours.`, type: 'LEAD_NEW', linkUrl: '/admin/leads' });
    }
  }

  const { partnerLeadWindowDays } = await getMoneySettings();
  if (partnerLeadWindowDays > 0) {
    const registered = await prisma.lead.findMany({
      where: { addedByPartnerId: { isSet: true }, status: { notIn: ['CLOSED', 'DROPPED', 'AWAITING_ADMIN'] }, windowWarnedAt: { isSet: false } },
      include: { escrowTransactions: { select: { createdAt: true, heldAt: true, releasedAt: true } } },
      take: 500,
    });
    for (const lead of registered) {
      const left = windowWarning(lead, now, partnerLeadWindowDays, WARN_DAYS);
      if (left === null) continue;
      await createNotification({
        userId: lead.addedByPartnerId, title: 'Your hold on a buyer is running out',
        message: `${lead.refCode || 'A lead'} · ${lead.buyerName || 'your buyer'}: about ${left} day(s) left. With no site visit, token or deal by then, the buyer is free for anyone to register.`,
        type: 'LEAD_ASSIGNED', linkUrl: `/partners/leads/${lead.id}`,
      }).catch(() => null);
      await prisma.lead.update({ where: { id: lead.id }, data: { windowWarnedAt: now } });
      out.warned += 1;
    }
  }
  return out;
}

function start() {
  cron.schedule('30 * * * *', async () => {
    try {
      const r = await runOnce();
      if (r.reminded || r.returned || r.warned) logger.info('[LeadHygiene] Run complete', r);
    } catch (err) { logger.error('[LeadHygiene] Run failed', { error: err.message }); }
  });
}

module.exports = { start, runOnce };
