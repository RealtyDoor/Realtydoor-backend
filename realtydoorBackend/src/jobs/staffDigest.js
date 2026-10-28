const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { alertStaff, recipients } = require('../lib/staffAlerts');

// Twice a day (9:00 and 15:00 IST) the team gets one email if anything is waiting: leads nobody has assigned for
// more than the 4-hour SLA, payouts that failed, and disputes still open. Nothing waiting means no email.
// Needs ADMIN_ALERT_EMAILS (see lib/staffAlerts.js); unset, the job does nothing.
const LEAD_SLA_HOURS = 4;

async function buildDigest(now = new Date()) {
  const slaCutoff = new Date(now.getTime() - LEAD_SLA_HOURS * 3600 * 1000);
  const [unassigned, payoutFailed, openDisputes] = await Promise.all([
    prisma.lead.count({ where: { status: 'UNASSIGNED', assignedPartnerId: { isSet: false }, createdAt: { lte: slaCutoff } } }),
    prisma.escrowTransaction.count({ where: { status: 'HELD_PAYOUT_FAILED' } }),
    prisma.dispute.count({ where: { status: 'OPEN' } }),
  ]);
  return { unassigned, payoutFailed, openDisputes };
}

async function sendDigest(now = new Date(), env = process.env) {
  if (recipients(env).length === 0) return false;
  const d = await buildDigest(now);
  if (!d.unassigned && !d.payoutFailed && !d.openDisputes) return false;
  const rows = [];
  if (d.unassigned) rows.push(`<li><strong>${d.unassigned}</strong> lead(s) unassigned for more than ${LEAD_SLA_HOURS} hours (Lead Dispatch)</li>`);
  if (d.payoutFailed) rows.push(`<li><strong>${d.payoutFailed}</strong> escrow(s) with a failed payout (Escrow)</li>`);
  if (d.openDisputes) rows.push(`<li><strong>${d.openDisputes}</strong> open dispute(s) (Dispute Resolution)</li>`);
  await alertStaff('Waiting for the team', `<p>Items waiting in the admin console:</p><ul>${rows.join('')}</ul>`, env);
  return true;
}

function start() {
  cron.schedule('0 9,15 * * *', async () => {
    try {
      await sendDigest();
    } catch (err) {
      logger.error('[StaffDigestJob] failed', { error: err.message });
    }
  }, { timezone: 'Asia/Kolkata' });
  logger.info('[Jobs] Staff digest job scheduled (09:00 and 15:00 IST)');
}

module.exports = { start, buildDigest, sendDigest };
