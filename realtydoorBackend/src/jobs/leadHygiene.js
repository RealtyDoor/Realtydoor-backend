const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { createNotification, notifyAdmins } = require('../lib/notifications');
const { createAuditLog } = require('../lib/auditLog');
const { getConfigNumber } = require('../modules/config/config.service');
const { getMoneySettings } = require('../modules/money/moneyConfig');
const { partnerResponseAction, proofAction, holdAction, noShowAction, assignedLeadAction, windowWarning, HOLD_EXTENSION_DAYS } = require('../lib/leadTimers');

// Runs hourly. Two rules that keep the company, not the partner, in charge of the buyer. Both are quiet until switched on:
//  1. lead_partner_response_hours (platform config, 0 = off): an assigned lead the partner has not started (no visit booked, no money)
//     gets a reminder at half that time and goes back to the company pool at the full time; the partner and the admins are told.
//  2. A partner who registered a buyer is reminded once, in the app, when 5 days or fewer remain of their partner_lead_window_days hold,
//     and told they can ask admin for up to 10 more days, once (see requestHoldExtension).
// Messages here are in-app notifications only; nothing goes out by WhatsApp or email.
const WARN_DAYS = 5;

const HOUR = 3_600_000;

// The registration no longer holds the buyer. If the adder is still the one holding the lead, it goes back to the company pool.
async function lapseRegistration(lead, now, why) {
  const heldByAdder = lead.assignedPartnerId && String(lead.assignedPartnerId) === String(lead.addedByPartnerId);
  await prisma.lead.update({
    where: { id: lead.id },
    data: { registrationLapsedAt: now, ...(heldByAdder ? { assignedPartnerId: null, status: 'UNASSIGNED', assignedAt: null, responseReminderAt: null } : {}) },
  });
  await createNotification({
    userId: lead.addedByPartnerId, title: 'Registration lapsed',
    message: `${lead.refCode || 'A lead'} · ${lead.buyerName || 'your buyer'}: ${why}, so the registration no longer holds this buyer.`,
    type: 'LEAD_DROPPED', linkUrl: `/partners/leads/${lead.id}`,
  }).catch(() => null);
  await createAuditLog({
    adminId: null, actorRole: 'SYSTEM', action: 'PARTNER_REGISTRATION_LAPSED', targetType: 'Lead', targetId: lead.id,
    before: { status: lead.status, assignedPartnerId: lead.assignedPartnerId }, after: { registrationLapsedAt: now, why },
  }).catch(() => null);
}

async function runOnce(now = new Date()) {
  const out = { reminded: 0, returned: 0, warned: 0, lapsed: 0, proofWarned: 0, holdLapsed: 0, noShow: 0, nudged: 0, due: 0, late: 0, extensionLate: 0, lateFive: 0, extensionLateFive: 0 };
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

  const { partnerLeadWindowDays, partnerLeadProofHours } = await getMoneySettings();

  // Proof window: a registered buyer must show a sign of life in time, or the registration lapses and the buyer is free.
  if (partnerLeadProofHours > 0) {
    const registered = await prisma.lead.findMany({
      where: { addedByPartnerId: { isSet: true }, registrationLapsedAt: { isSet: false }, status: { in: ['ASSIGNED', 'UNASSIGNED'] } },
      include: { escrowTransactions: { select: { status: true } } },
      take: 500,
    });
    for (const lead of registered) {
      const account = lead.buyerPhone
        ? await prisma.user.findFirst({ where: { phone: lead.buyerPhone, role: 'USER', phoneVerified: true, deletedAt: { isSet: false } }, select: { id: true } })
        : null;
      const action = proofAction(lead, now, partnerLeadProofHours, !!account);
      if (action === 'warn') {
        await createNotification({
          userId: lead.addedByPartnerId, title: 'Show your buyer is real, soon',
          message: `${lead.refCode || 'A lead'} · ${lead.buyerName || 'your buyer'}: the buyer has not signed up and no visit is booked. Book the visit or ask them to sign up, or your registration lapses in about ${Math.ceil(partnerLeadProofHours / 3)} hours.`,
          type: 'LEAD_ASSIGNED', linkUrl: `/partners/leads/${lead.id}`,
        }).catch(() => null);
        await prisma.lead.update({ where: { id: lead.id }, data: { proofWarnedAt: now } });
        out.proofWarned += 1;
      } else if (action === 'lapse') {
        await lapseRegistration(lead, now, `no sign-up, visit or token within ${partnerLeadProofHours} hours`);
        out.lapsed += 1;
      }
    }
    if (out.lapsed) {
      await notifyAdmins({ title: 'Partner registrations lapsed', message: `${out.lapsed} registered buyer(s) showed no sign of life within ${partnerLeadProofHours} hours and are free again.`, type: 'LEAD_DROPPED', linkUrl: '/admin/leads/partner-added' }).catch(() => null);
    }
  }

  const { partnerLeadNudgeDays, leadLateHours, leadLateEscalateDays } = await getMoneySettings();

  // The one rule: the hold window (30 days) from the last real activity. A registered buyer with no token by then is free again.
  if (partnerLeadWindowDays > 0) {
    const held = await prisma.lead.findMany({
      where: { addedByPartnerId: { isSet: true }, registrationLapsedAt: { isSet: false }, status: { notIn: ['CLOSED', 'DROPPED', 'AWAITING_ADMIN'] } },
      include: { escrowTransactions: { select: { status: true, createdAt: true, heldAt: true, releasedAt: true } } },
      take: 500,
    });
    for (const lead of held) {
      if (holdAction(lead, now, partnerLeadWindowDays) !== 'lapse') continue;
      await lapseRegistration(lead, now, `no token or verified visit within ${partnerLeadWindowDays + (lead.holdExtensionApproved ? lead.holdExtensionDays || 0 : 0)} days`);
      out.holdLapsed += 1;
    }
    if (out.holdLapsed) {
      await notifyAdmins({ title: 'Partner registrations lapsed', message: `${out.holdLapsed} registered buyer(s) reached the end of their hold and are free again.`, type: 'LEAD_DROPPED', linkUrl: '/admin/leads/partner-added' }).catch(() => null);
    }

    // Company-given leads: a nudge to admin at the nudge day, and a notice when the window is over. Admin decides; nothing moves by itself.
    const given = await prisma.lead.findMany({
      where: { assignedPartnerId: { isSet: true }, addedByPartnerId: { isSet: false }, status: 'ASSIGNED' },
      include: { escrowTransactions: { select: { status: true, createdAt: true, heldAt: true, releasedAt: true } } },
      take: 500,
    });
    for (const lead of given) {
      const action = assignedLeadAction(lead, now, partnerLeadWindowDays, partnerLeadNudgeDays);
      if (action === 'nudge') {
        await notifyAdmins({ title: 'A given lead has gone quiet', message: `${lead.refCode || 'A lead'} has been with its partner for ${partnerLeadNudgeDays}+ days with no visit or token. Chase the partner or reassign it.`, type: 'LEAD_NEW', linkUrl: `/admin/leads/${lead.id}` }).catch(() => null);
        await prisma.lead.update({ where: { id: lead.id }, data: { assignmentNudgedAt: now } });
        out.nudged += 1;
      } else if (action === 'due') {
        await notifyAdmins({ title: 'A given lead needs your decision', message: `${lead.refCode || 'A lead'}: the partner's ${partnerLeadWindowDays} days are up with no token. Reassign it, or leave it with them.`, type: 'LEAD_NEW', linkUrl: `/admin/leads/${lead.id}` }).catch(() => null);
        await prisma.lead.update({ where: { id: lead.id }, data: { assignmentDueNotifiedAt: now } });
        out.due += 1;
      }
    }
  }

  // A booked visit nobody attended: admin is asked to confirm the no-show. Until then it still counts and the buyer stays held.
  const booked = partnerLeadWindowDays <= 0 ? [] : await prisma.lead.findMany({
    where: { siteVisitScheduledAt: { lt: new Date(now.getTime() - 7 * 24 * HOUR) }, noShowFlaggedAt: { isSet: false }, visitNoShowConfirmedAt: { isSet: false }, isOtpVerified: false, status: { notIn: ['CLOSED', 'DROPPED'] } },
    select: { id: true, refCode: true, status: true, siteVisitScheduledAt: true, noShowFlaggedAt: true, visitNoShowConfirmedAt: true, otpVerifiedAt: true, isOtpVerified: true, visitOutcomeAt: true },
    take: 200,
  });
  for (const lead of booked) {
    if (noShowAction(lead, now) !== 'flag') continue;
    await notifyAdmins({ title: 'A visit was not attended', message: `${lead.refCode || 'A lead'}: the booked visit was more than 7 days ago and nobody came. Confirm the no-show on the lead, or the buyer stays held.`, type: 'LEAD_NEW', linkUrl: `/admin/leads/${lead.id}` }).catch(() => null);
    await prisma.lead.update({ where: { id: lead.id }, data: { noShowFlaggedAt: now } });
    out.noShow += 1;
  }

  // Slow admin: a registration waiting too long for confirmation, or an extension request sitting undecided, is escalated once.
  if (leadLateHours > 0) {
    const cutoff = new Date(now.getTime() - leadLateHours * HOUR);
    const waiting = await prisma.lead.findMany({ where: { status: 'AWAITING_ADMIN', createdAt: { lt: cutoff }, lateNotifiedAt: { isSet: false } }, select: { id: true, refCode: true }, take: 200 });
    for (const lead of waiting) {
      await notifyAdmins({ title: 'Registration waiting too long', message: `${lead.refCode || 'A lead'} has waited more than ${leadLateHours} hours for confirmation.`, type: 'LEAD_NEW', linkUrl: `/admin/leads/${lead.id}` }).catch(() => null);
      await prisma.lead.update({ where: { id: lead.id }, data: { lateNotifiedAt: now } });
      out.late += 1;
    }
    const pending = await prisma.lead.findMany({ where: { holdExtensionRequestedAt: { lt: cutoff }, holdExtensionDecidedAt: { isSet: false }, holdExtensionEscalatedAt: { isSet: false } }, select: { id: true, refCode: true }, take: 200 });
    for (const lead of pending) {
      await notifyAdmins({ title: 'Extension request not decided', message: `${lead.refCode || 'A lead'}: a request for more time has waited more than ${leadLateHours} hours. The partner's clock is paused until you decide.`, type: 'LEAD_EXTENSION_REQUESTED', linkUrl: `/admin/leads/${lead.id}` }).catch(() => null);
      await prisma.lead.update({ where: { id: lead.id }, data: { holdExtensionEscalatedAt: now } });
      out.extensionLate += 1;
    }
  }

  // The second, stronger alert: still undecided after 5 days.
  if (leadLateEscalateDays > 0) {
    const cutoff5 = new Date(now.getTime() - leadLateEscalateDays * 24 * HOUR);
    const waiting5 = await prisma.lead.findMany({ where: { status: 'AWAITING_ADMIN', createdAt: { lt: cutoff5 }, lateEscalatedAt: { isSet: false } }, select: { id: true, refCode: true }, take: 200 });
    for (const lead of waiting5) {
      await notifyAdmins({ title: `Registration waiting ${leadLateEscalateDays} days`, message: `${lead.refCode || 'A lead'} has waited more than ${leadLateEscalateDays} days for confirmation. The partner is still waiting; please decide today.`, type: 'LEAD_NEW', linkUrl: `/admin/leads/${lead.id}` }).catch(() => null);
      await prisma.lead.update({ where: { id: lead.id }, data: { lateEscalatedAt: now } });
      out.lateFive += 1;
    }
    const pending5 = await prisma.lead.findMany({ where: { holdExtensionRequestedAt: { lt: cutoff5 }, holdExtensionDecidedAt: { isSet: false }, holdExtensionEscalatedFiveAt: { isSet: false } }, select: { id: true, refCode: true }, take: 200 });
    for (const lead of pending5) {
      await notifyAdmins({ title: `Extension request waiting ${leadLateEscalateDays} days`, message: `${lead.refCode || 'A lead'}: a request for more time has waited more than ${leadLateEscalateDays} days. The partner's clock is paused until you decide.`, type: 'LEAD_EXTENSION_REQUESTED', linkUrl: `/admin/leads/${lead.id}` }).catch(() => null);
      await prisma.lead.update({ where: { id: lead.id }, data: { holdExtensionEscalatedFiveAt: now } });
      out.extensionLateFive += 1;
    }
  }

  if (partnerLeadWindowDays > 0) {
    const registered = await prisma.lead.findMany({
      where: { OR: [{ addedByPartnerId: { isSet: true } }, { assignedPartnerId: { isSet: true } }], registrationLapsedAt: { isSet: false }, status: { notIn: ['CLOSED', 'DROPPED', 'AWAITING_ADMIN'] }, windowWarnedAt: { isSet: false } },
      include: { escrowTransactions: { select: { createdAt: true, heldAt: true, releasedAt: true } } },
      take: 500,
    });
    for (const lead of registered) {
      const left = windowWarning(lead, now, partnerLeadWindowDays, WARN_DAYS);
      if (left === null) continue;
      await createNotification({
        userId: lead.addedByPartnerId || lead.assignedPartnerId, title: 'Your hold on a buyer is running out',
        message: `${lead.refCode || 'A lead'} · ${lead.buyerName || 'your buyer'}: about ${left} day(s) left. With no site visit, token or deal by then, ${lead.addedByPartnerId ? 'the buyer is free for anyone to register' : 'admin may reassign this lead'}.${lead.holdExtensionRequestedAt ? '' : ` You can ask admin for up to ${HOLD_EXTENSION_DAYS} more days, once: open the lead and choose Ask for more time.`}`,
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
      if (Object.values(r).some(Boolean)) logger.info('[LeadHygiene] Run complete', r);
    } catch (err) { logger.error('[LeadHygiene] Run failed', { error: err.message }); }
  });
}

module.exports = { start, runOnce };
