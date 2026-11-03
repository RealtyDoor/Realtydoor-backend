const { lastActivity } = require('./leadOwnership');

// Pure timing rules for the lead jobs (jobs/leadHygiene.js). The company holds the buyer: a lead a partner is not working goes back to
// the pool, and a partner is warned before their hold on a buyer lapses. All hours and days come from platform config, so they can be
// tuned without a release; 0 switches a rule off.
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MONEY = ['HELD', 'HELD_PAYOUT_FAILED', 'FROZEN', 'RELEASED', 'PARTIALLY_REFUNDED'];

/**
 * What to do about an assigned lead the partner has not started (no site visit booked, no money). `hours` is how long they get:
 * a reminder at half that, the lead back to the pool at the full time.
 */
function partnerResponseAction(lead, now, hours) {
  if (!hours || hours <= 0) return 'none';
  if (lead.status !== 'ASSIGNED' || !lead.assignedPartnerId) return 'none';
  if (lead.siteVisitScheduledAt || lead.isOtpVerified) return 'none';
  if ((lead.escrowTransactions || []).some((e) => MONEY.includes(e.status))) return 'none';
  const since = new Date(lead.assignedAt || lead.createdAt).getTime();
  const age = now.getTime() - since;
  if (age >= hours * HOUR) return 'return';
  if (age >= (hours / 2) * HOUR && !lead.responseReminderAt) return 'remind';
  return 'none';
}

/**
 * A partner who registered a buyer holds them for `windowDays` after the last real activity. Warn once when `warnDays` or fewer
 * remain. Returns the days left, or null when no warning is due.
 */
function windowWarning(lead, now, windowDays, warnDays = 15) {
  if (!windowDays || windowDays <= 0) return null;
  if (!lead.addedByPartnerId || ['CLOSED', 'DROPPED'].includes(lead.status) || lead.windowWarnedAt) return null;
  const idle = (now.getTime() - lastActivity(lead)) / DAY;
  const left = Math.ceil(windowDays - idle);
  return left > 0 && left <= warnDays ? left : null;
}

const ATTEMPTS_BEFORE_DECISION = 5;
const DAYS_BEFORE_DECISION = 14;

/** A lead a BDE has tried to reach many times over two weeks with no progress: time to decide (qualify, or let it go), not chase. */
function needsDecision(lead, now) {
  const open = !lead.salesStage || ['NEW', 'CONTACTED', 'FOLLOW_UP'].includes(lead.salesStage);
  return open && (lead.contactAttempts || 0) >= ATTEMPTS_BEFORE_DECISION && (now.getTime() - new Date(lead.createdAt).getTime()) >= DAYS_BEFORE_DECISION * DAY;
}

module.exports = { partnerResponseAction, windowWarning, needsDecision, ATTEMPTS_BEFORE_DECISION, DAYS_BEFORE_DECISION };
