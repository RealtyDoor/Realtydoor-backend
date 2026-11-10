const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { notifyAdmins } = require('../lib/notifications');
const { getConfigValue } = require('../modules/config/config.service');
const { getMoneySettings } = require('../modules/money/moneyConfig');
const { HOLDING_STATUSES } = require('../lib/escrowTotals');

// Why a token that is not plainly HELD is still with us at the limit (audit Nov 2026, F7). These are never refunded
// automatically: a person has to decide them.
const NOT_PLAIN_HELD = {
  FROZEN: { title: 'Frozen escrow past the hold limit', what: 'is frozen. Decide it: unfreeze, release or refund. (It is never refunded automatically while frozen.)' },
  PARTIALLY_REFUNDED: { title: 'Part-refunded escrow past the hold limit', what: 'is part refunded: the rest is still held. Refund the rest or settle it. (It is never refunded automatically.)' },
  HELD_PAYOUT_FAILED: { title: 'Payout-failed escrow past the hold limit', what: 'has a payout that failed or was not confirmed. Retry the payout or refund what is left. (It is never refunded automatically.)' },
};

// T59 / money model Rev 3: a token is held for up to `escrow_hold_days` (30).
// At the limit it is refunded to the buyer (token only; the processing fee is
// not returned) unless the escrow is frozen for a dispute. Real money moves, so
// the automatic refund is OFF until `escrow_hold_auto_refund` is set to "true";
// with it off the job only alerts admins once per escrow.
async function runOnce({ now = new Date() } = {}) {
  const settings = await getMoneySettings();
  const days = settings.refund.holdDays;
  const auto = (await getConfigValue('escrow_hold_auto_refund', 'false')) === 'true';
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const due = await prisma.escrowTransaction.findMany({
    where: { status: { in: HOLDING_STATUSES }, heldAt: { lte: cutoff } },
    select: { id: true, status: true, amount: true, leadId: true, holdLimitAlertedAt: true },
  });
  const result = { due: due.length, refunded: 0, alerted: 0, failed: 0, auto };
  if (!due.length) return result;

  const escrowService = require('../modules/escrow/escrow.service');
  for (const e of due) {
    // A frozen escrow is never refunded here (a person is deciding it, usually in a dispute), even with automatic refund on.
    // An admin is told once, so a freeze nobody remembers does not sit silent.
    // The same goes for a part-refunded token and one whose payout failed: only a plain HELD token is refunded here.
    if (e.status !== 'HELD') {
      if (e.holdLimitAlertedAt) continue;
      const why = NOT_PLAIN_HELD[e.status] || { title: 'Escrow past the hold limit', what: `is ${e.status}. Decide it by hand.` };
      await notifyAdmins({
        title: why.title,
        message: `A ₹${e.amount.toLocaleString('en-IN')} token has been held ${days}+ days and ${why.what}`,
        type: 'ESCROW_HOLD_LIMIT', linkUrl: '/admin/escrow',
      });
      await prisma.escrowTransaction.update({ where: { id: e.id }, data: { holdLimitAlertedAt: now } });
      result.alerted += 1;
      continue;
    }
    if (!auto) {
      // Once per escrow. Not filtered in the query: on MongoDB a never-written field does not match `null`.
      if (e.holdLimitAlertedAt) continue;
      await notifyAdmins({
        title: 'Escrow past the hold limit',
        message: `A ₹${e.amount.toLocaleString('en-IN')} token has been held ${days}+ days. Refund it or extend with the parties' written OK. (Automatic refund is off.)`,
        type: 'ESCROW_HOLD_LIMIT', linkUrl: '/admin/escrow',
      });
      await prisma.escrowTransaction.update({ where: { id: e.id }, data: { holdLimitAlertedAt: now } });
      result.alerted += 1;
      continue;
    }
    try {
      await escrowService.refund(e.id, null, null, {
        reason: 'ADMIN_TOKEN_ONLY', actorType: 'SYSTEM', autoReason: `Held ${days} days: automatic refund (money model Rev 3)`,
      });
      result.refunded += 1;
    } catch (err) {
      result.failed += 1;
      logger.error('[EscrowHoldExpiry] automatic refund failed', { escrowId: e.id, error: err.message });
    }
  }
  logger.info('[EscrowHoldExpiry] run finished', result);
  return result;
}

function start() {
  cron.schedule('30 3 * * *', () => {
    runOnce().catch((err) => logger.error('[EscrowHoldExpiry] Job failed', { error: err.message, stack: err.stack }));
  });
  logger.info('[Jobs] Escrow hold-expiry job scheduled (daily 3:30am)');
}

module.exports = { start, runOnce };
