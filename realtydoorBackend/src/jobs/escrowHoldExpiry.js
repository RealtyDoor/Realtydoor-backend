const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { notifyAdmins } = require('../lib/notifications');
const { getConfigValue } = require('../modules/config/config.service');
const { getMoneySettings } = require('../modules/money/moneyConfig');

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
    where: { status: 'HELD', heldAt: { lte: cutoff } },
    select: { id: true, amount: true, leadId: true, holdLimitAlertedAt: true },
  });
  const result = { due: due.length, refunded: 0, alerted: 0, failed: 0, auto };
  if (!due.length) return result;

  const escrowService = require('../modules/escrow/escrow.service');
  for (const e of due) {
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
