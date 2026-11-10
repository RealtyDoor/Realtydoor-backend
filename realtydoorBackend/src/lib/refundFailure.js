// What to say, and what to write down, when Razorpay refuses a refund. Shared by the standard, partial and
// refund-remaining routes so an admin always gets the same instruction and the failure is always traceable.
const ApiError = require('../utils/ApiError');
const logger = require('./logger');
const { createAuditLog } = require('./auditLog');
const { notifyAdmins } = require('./notifications');

// Razorpay's SDK rejects with a plain {statusCode, error} object, so `err.message` is usually undefined and the
// reason sits in err.error.description (or err.error as a string). Never fall back to a bare "Unknown error".
function razorpayErrorText(err, fallback = 'Unknown error') {
  const e = err?.error;
  return (e && (e.description || e.reason || (typeof e === 'string' ? e : null)))
    || err?.message
    || (err?.statusCode ? `HTTP ${err.statusCode} from Razorpay` : fallback);
}

// Audit Nov 2026, F1. A payout request can fail in two very different ways. RazorpayX answering with a 4xx is a clear "no":
// no payout exists. Anything else (a timeout, a dropped connection, a 5xx) is "we do not know": RazorpayX may have created
// the payout and only the answer was lost. Callers must never treat the second kind as "not paid".
function isClearRefusal(err) {
  const code = Number(err?.statusCode);
  return code >= 400 && code < 500;
}

// A refund Razorpay cannot cover from the payments balance (earlier payments already settled to the bank) comes back as a bare 400
// "invalid request sent", or as an explicit balance message.
function isLowBalance(err) {
  return /balance|insufficient|invalid request sent/i.test(razorpayErrorText(err)) && (!err?.statusCode || err.statusCode === 400);
}

const LOW_BALANCE_MESSAGE = 'Razorpay refund failed: there is not enough balance in the Razorpay payments account to cover this refund. '
  + 'Top up that balance in the Razorpay dashboard (Account & Settings, Payments and Refunds, Balances, Add Funds), then try again. The token has not changed.';
// A buyer must never read about our Razorpay balance or see Razorpay's raw text.
const BUYER_MESSAGE = 'We could not send your refund just now. Nothing has changed: your token is safe and your inquiry is still open. '
  + 'Our team has been told. Please try again in a little while, or contact support.';

// The error to throw. Admins get the instruction (low balance) or Razorpay's own words; a buyer gets one plain sentence.
function refundFailure(err, { forBuyer = false } = {}) {
  if (forBuyer) return new ApiError(502, BUYER_MESSAGE, { code: 'REFUND_NOT_SENT' });
  const text = razorpayErrorText(err);
  if (isLowBalance(err)) return new ApiError(502, LOW_BALANCE_MESSAGE, { code: 'RAZORPAY_BALANCE_LOW', providerMessage: text });
  return new ApiError(502, `Razorpay refund failed: ${text}`, { code: 'RAZORPAY_ERROR' });
}

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;

// Writes the failed attempt to the audit trail (who, how much, Razorpay's own words). When nobody from the team is on
// screen (a buyer's cancel, the automatic refund job) it also tells the admins. Never throws: the caller is already
// on its way to throwing the refund error, and a logging problem must not replace it.
async function recordRefundFailure({ escrowId, actorId, actorRole = 'ADMIN', ip, amountPaise, paymentId, route, err }) {
  const providerMessage = razorpayErrorText(err);
  const lowBalance = isLowBalance(err);
  logger.error('[escrow] Razorpay refund failed', { escrowId, route, paymentId, amountPaise, actorRole, lowBalance, statusCode: err?.statusCode, razorpayError: err?.error || err?.message });
  try {
    await createAuditLog({
      adminId: actorId || null, actorRole, action: 'ESCROW_REFUND_FAILED', targetType: 'EscrowTransaction', targetId: escrowId,
      reason: lowBalance ? 'Razorpay balance too low' : 'Razorpay refused the refund',
      after: { route, amountPaise, paymentId, code: lowBalance ? 'RAZORPAY_BALANCE_LOW' : 'RAZORPAY_ERROR', providerMessage, statusCode: err?.statusCode ?? null },
      ipAddress: ip,
    });
  } catch (auditErr) {
    logger.error('[escrow] Could not write the failed refund to the audit trail', { escrowId, error: auditErr?.message });
  }
  if (actorRole === 'ADMIN') return;
  try {
    const who = actorRole === 'USER' ? "A buyer's cancel" : 'An automatic refund';
    await notifyAdmins({
      title: lowBalance ? 'Refund failed: Razorpay balance too low' : 'Refund failed',
      message: lowBalance
        ? `${who} could not refund ${rupees(amountPaise)} (payment ${paymentId}) because the Razorpay payments balance is too low. Top up the balance in Razorpay, then refund it from the escrow page. The token is still held.`
        : `${who} could not refund ${rupees(amountPaise)} (payment ${paymentId}). Razorpay said: ${providerMessage}. The token is still held; refund it from the escrow page.`,
      type: 'ESCROW_REFUNDED', linkUrl: '/admin/escrow',
    });
  } catch (notifyErr) {
    logger.error('[escrow] Could not tell admins about the failed refund', { escrowId, error: notifyErr?.message });
  }
}

module.exports = { razorpayErrorText, isClearRefusal, isLowBalance, refundFailure, recordRefundFailure };
