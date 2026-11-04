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

// A registered buyer can be held up to this many days longer, once, if admin agrees. Never more.
const HOLD_EXTENSION_DAYS = 10;
// The partner is reminded, and may ask, in the last days of the hold.
const HOLD_REMINDER_DAYS = 5;

/** The hold for one lead: the platform window plus any extension admin approved (at most 10 days). */
function holdWindowDays(lead, windowDays) {
  const extra = lead && lead.holdExtensionApproved ? Math.min(Math.max(Number(lead.holdExtensionDays) || 0, 0), HOLD_EXTENSION_DAYS) : 0;
  return windowDays + extra;
}

/**
 * Where a registered buyer's hold stands, for the partner who registered them. `state` is NONE, REQUESTED (waiting for admin), APPROVED or
 * DECLINED. `canRequest` is true only in the last days of the hold, once ever, while the lead is open and not lapsed.
 */
function holdInfo(lead, now, windowDays) {
  const total = holdWindowDays(lead, windowDays);
  const endsAt = new Date(lastActivity(lead) + total * DAY);
  const daysLeft = Math.ceil((endsAt.getTime() - now.getTime()) / DAY);
  let state = 'NONE';
  if (lead.holdExtensionRequestedAt) state = lead.holdExtensionDecidedAt ? (lead.holdExtensionApproved ? 'APPROVED' : 'DECLINED') : 'REQUESTED';
  const open = !['CLOSED', 'DROPPED'].includes(lead.status) && !lead.registrationLapsedAt;
  const canRequest = windowDays > 0 && open && !lead.holdExtensionRequestedAt && daysLeft > 0 && daysLeft <= HOLD_REMINDER_DAYS;
  return { state, endsAt, daysLeft, canRequest, extensionDays: HOLD_EXTENSION_DAYS };
}

/**
 * A partner who registered a buyer holds them for `windowDays` after the last real activity. Warn once when `warnDays` or fewer
 * remain. Returns the days left, or null when no warning is due.
 */
function windowWarning(lead, now, windowDays, warnDays = 15) {
  if (!windowDays || windowDays <= 0) return null;
  if (!lead.addedByPartnerId || ['CLOSED', 'DROPPED'].includes(lead.status) || lead.windowWarnedAt) return null;
  const idle = (now.getTime() - lastActivity(lead)) / DAY;
  const left = Math.ceil(holdWindowDays(lead, windowDays) - idle);
  return left > 0 && left <= warnDays ? left : null;
}

/**
 * The proof window for a lead a partner registered. The partner has `hours` to show the buyer is real: the buyer signs up with that
 * number (`buyerHasAccount`), a visit is booked or done, or money is held. Otherwise the registration lapses. A warning goes out once,
 * when a third of the time is left. The clock starts when the lead became the partner's (confirmed by admin), or when it was added
 * if it was never held up for review; a lead still waiting for admin is not timed, because the delay is ours, not the partner's.
 * Returns 'lapse', 'warn' or 'none'.
 */
function proofAction(lead, now, hours, buyerHasAccount = false) {
  if (!hours || hours <= 0) return 'none';
  if (!lead.addedByPartnerId || lead.registrationLapsedAt) return 'none';
  if (['CLOSED', 'DROPPED', 'AWAITING_ADMIN'].includes(lead.status)) return 'none';
  if (lead.siteVisitScheduledAt || lead.isOtpVerified || buyerHasAccount) return 'none';
  if ((lead.escrowTransactions || []).some((e) => MONEY.includes(e.status))) return 'none';
  const since = new Date(lead.assignedAt || lead.createdAt).getTime();
  const age = now.getTime() - since;
  if (age >= hours * HOUR) return 'lapse';
  if (age >= (hours * 2 / 3) * HOUR && !lead.proofWarnedAt) return 'warn';
  return 'none';
}

const ATTEMPTS_BEFORE_DECISION = 5;
const DAYS_BEFORE_DECISION = 14;

/** A lead a BDE has tried to reach many times over two weeks with no progress: time to decide (qualify, or let it go), not chase. */
function needsDecision(lead, now) {
  const open = !lead.salesStage || ['NEW', 'CONTACTED', 'FOLLOW_UP'].includes(lead.salesStage);
  return open && (lead.contactAttempts || 0) >= ATTEMPTS_BEFORE_DECISION && (now.getTime() - new Date(lead.createdAt).getTime()) >= DAYS_BEFORE_DECISION * DAY;
}

module.exports = { HOLD_EXTENSION_DAYS, HOLD_REMINDER_DAYS, holdWindowDays, holdInfo, partnerResponseAction, proofAction, windowWarning, needsDecision, ATTEMPTS_BEFORE_DECISION, DAYS_BEFORE_DECISION };
