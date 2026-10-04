const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { broadcastNotification } = require('../lib/notifications');
const { getConfigNumber } = require('../modules/config/config.service');

const DEFAULT_AUTO_ESCALATE_DAYS = 14;

// Runs nightly. Flags any escrow that's sat HELD (undispatched — not released,
// not refunded) past the configured cool-off window (FRONTEND_HANDOFF_SPEC.md
// §2.3). autoEscalatedAt marks a row as already-flagged so re-runs don't spam
// admins with the same overdue escrow every night.
async function runOnce() {
  const days = await getConfigNumber('escrow_auto_escalate_days', DEFAULT_AUTO_ESCALATE_DAYS);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Filtered in JS, not in the query: on MongoDB, `autoEscalatedAt: null` only
  // matches documents where the field is explicitly null, NOT ones where it
  // was never written at all (which is every row until its first escalation)
  // — confirmed empirically, not a Prisma quirk to trust blindly here.
  const candidates = await prisma.escrowTransaction.findMany({
    where: { status: 'HELD', heldAt: { lte: cutoff } },
    select: { id: true, amount: true, leadId: true, autoEscalatedAt: true },
  });
  const stale = candidates.filter((e) => !e.autoEscalatedAt);

  if (stale.length === 0) return { escalated: 0 };

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  const adminIds = admins.map((a) => a.id);

  for (const escrow of stale) {
    if (adminIds.length > 0) {
      await broadcastNotification({
        userIds: adminIds,
        title: 'Escrow release overdue',
        message: `An escrow of ₹${escrow.amount.toLocaleString('en-IN')} has been held ${days}+ days without release or refund.`,
        type: 'ESCROW_AUTO_ESCALATED',
      });
    }
    await prisma.escrowTransaction.update({
      where: { id: escrow.id },
      data: { autoEscalatedAt: new Date() },
    });
  }

  logger.info('[EscrowAutoEscalate] Escalated overdue escrow(s)', { count: stale.length, days });
  return { escalated: stale.length };
}

function start() {
  cron.schedule('0 3 * * *', () => {
    runOnce().catch((err) => {
      logger.error('[EscrowAutoEscalate] Job failed', { error: err.message, stack: err.stack });
    });
  });

  logger.info('[Jobs] Escrow auto-escalate job scheduled (daily 3am)');
}

module.exports = { start, runOnce };
