const prisma = require('../../lib/prisma');
const { getConfigNumber } = require('../config/config.service');

// ─── Period helper ───────────────────────────────────────────────────────────
// 13.2/13.3's period chips. ALL means no lower bound.

const PERIODS = ['MTD', '3M', '6M', 'YTD', 'ALL'];

function periodStart(period = 'MTD') {
  const now = new Date();
  switch (period) {
    case 'ALL': return null;
    case 'YTD': return new Date(now.getFullYear(), 0, 1);
    case '3M':  return new Date(now.getFullYear(), now.getMonth() - 3, 1);
    case '6M':  return new Date(now.getFullYear(), now.getMonth() - 6, 1);
    case 'MTD':
    default:    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
}

function sinceFilter(period) {
  const start = periodStart(period);
  return start ? { gte: start } : undefined;
}

function pct(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Median, not mean — a single stalled lead sitting open for months would drag
// an average far enough to make the number useless.
function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  // Rounded on both branches — the odd-count path used to return the raw
  // value and leak float noise like 1.0000000115740741 into the response.
  return round2(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

// A negative elapsed time is not a fast partner, it is out-of-order
// timestamps — this database has rows where releasedAt precedes createdAt and
// where otpVerifiedAt precedes siteVisitScheduledAt. Including them produced a
// median hold of MINUS six days and a negative float projection. They are
// dropped from the statistic and counted separately, so the data problem is
// visible instead of silently skewing the number.
function medianOfPositive(values) {
  const clean = values.filter((n) => Number.isFinite(n) && n >= 0);
  return { median: median(clean), samples: clean.length, discardedNegative: values.length - clean.length };
}

const DAY_MS = 86_400_000;

// ─── 13.3 — conversion funnel ────────────────────────────────────────────────

async function getFunnel(period = 'MTD') {
  const since = sinceFilter(period);
  const leadWhere = since ? { createdAt: since } : {};

  const [registrations, inquiries, assigned, visitsScheduled, otpVerified, decided, escrowHeld, closed] =
    await Promise.all([
      prisma.user.count({ where: { role: 'USER', deletedAt: { isSet: false }, ...(since ? { createdAt: since } : {}) } }),
      prisma.lead.count({ where: leadWhere }),
      prisma.lead.count({ where: { ...leadWhere, assignedPartnerId: { isSet: true } } }),
      prisma.lead.count({ where: { ...leadWhere, siteVisitScheduledAt: { not: null } } }),
      prisma.lead.count({ where: { ...leadWhere, isOtpVerified: true } }),
      // "Decided" = the buyer or partner recorded an outcome either way.
      prisma.lead.count({ where: { ...leadWhere, OR: [{ visitOutcome: { not: null } }, { buyerFeedbackStatus: { in: ['VERIFIED_CLOSED', 'VERIFIED_DROPPED'] } }] } }),
      prisma.lead.count({ where: { ...leadWhere, escrowTransactions: { some: { status: { in: ['HELD', 'HELD_PAYOUT_FAILED', 'RELEASED'] } } } } }),
      prisma.lead.count({ where: { ...leadWhere, status: 'CLOSED' } }),
    ]);

  const stages = [
    // 13.3 asks for visitors first. Nothing in this backend records anonymous
    // site traffic — Property.viewsThisWeek is per-listing and resets weekly,
    // so it can't be summed into a visitor count. Reported as null with a
    // reason rather than substituted with something that isn't visitors.
    { key: 'VISITORS', count: null, unavailable: 'anonymous site traffic is not tracked by the backend' },
    { key: 'REGISTRATIONS', count: registrations },
    { key: 'INQUIRIES', count: inquiries },
    { key: 'ASSIGNED', count: assigned },
    { key: 'VISITS_SCHEDULED', count: visitsScheduled },
    { key: 'OTP_VERIFIED', count: otpVerified },
    { key: 'DECIDED', count: decided },
    { key: 'ESCROW_HELD', count: escrowHeld },
    { key: 'CLOSED', count: closed },
  ];

  // Step conversion is measured against the previous *available* stage, so the
  // untracked visitor stage doesn't produce a bogus 0% on registrations.
  let prev = null;
  for (const s of stages) {
    s.conversionFromPrev = prev != null && s.count != null ? pct(s.count, prev) : null;
    if (s.count != null) prev = s.count;
  }

  return { period, stages, inquiryToClosePct: pct(closed, inquiries) };
}

// ─── 13.2 — user growth ──────────────────────────────────────────────────────

async function getUserGrowth(period = 'MTD') {
  const since = sinceFilter(period);
  const base = { role: 'USER', deletedAt: { isSet: false } };

  const [newUsers, otpVerifiedUsers, nriUsers, totalUsers] = await Promise.all([
    prisma.user.count({ where: { ...base, ...(since ? { createdAt: since } : {}) } }),
    prisma.user.count({ where: { ...base, phoneVerified: true, ...(since ? { createdAt: since } : {}) } }),
    prisma.user.count({ where: { ...base, isNRI: true, ...(since ? { createdAt: since } : {}) } }),
    prisma.user.count({ where: base }),
  ]);

  return {
    period,
    newUsers,
    otpVerifiedUsers,
    otpVerifiedPct: pct(otpVerifiedUsers, newUsers),
    nriUsers,
    totalUsers,
  };
}

// ─── 13.1 — NRI segment ──────────────────────────────────────────────────────

async function getNriSegment(period = 'MTD') {
  const since = sinceFilter(period);
  const nriUserIds = (await prisma.user.findMany({
    where: { isNRI: true, deletedAt: { isSet: false } },
    select: { id: true },
  })).map((u) => u.id);

  const [registrations, videoTours, nriLeadsCaptured, closedLeads] = await Promise.all([
    prisma.user.count({ where: { isNRI: true, deletedAt: { isSet: false }, ...(since ? { createdAt: since } : {}) } }),
    prisma.videoTourRequest.count({ where: since ? { createdAt: since } : {} }),
    // The public NRI capture form is a separate funnel from registered users.
    prisma.nriLead.count({ where: since ? { createdAt: since } : {} }),
    nriUserIds.length
      ? prisma.lead.findMany({
          where: { buyerId: { in: nriUserIds }, status: 'CLOSED', ...(since ? { createdAt: since } : {}) },
          select: { dealPriceAtLock: true, property: { select: { price: true } } },
        })
      : [],
  ]);

  const dealValues = closedLeads
    .map((l) => l.dealPriceAtLock ?? l.property?.price)
    .filter((v) => Number.isFinite(v));

  return {
    period,
    registrations,
    videoToursBooked: videoTours,
    nriLeadsCaptured,
    dealsClosed: closedLeads.length,
    avgDealValue: dealValues.length ? round2(dealValues.reduce((a, b) => a + b, 0) / dealValues.length) : null,
  };
}

// ─── 13.4 / 13.5 — revenue by stream and escrow float ────────────────────────

async function getRevenueByStream(period = 'MTD') {
  const start = periodStart(period);
  // Previous window of the same length, for the change-vs-last-period column.
  // ALL has no "before" to compare against, so the comparison is skipped
  // rather than querying a window that starts before the epoch.
  const prevStart = start ? new Date(start.getTime() - (Date.now() - start.getTime())) : null;

  async function streams(from, to) {
    const range = to ? { gte: from, lt: to } : { gte: from };

    const [subs, released] = await Promise.all([
      prisma.userSubscription.findMany({
        where: { paymentStatus: 'SUCCESS', startDate: range },
        select: { amountPaid: true, service: { select: { name: true } } },
      }),
      // The platform's own revenue is its slice of the fee, which is recorded
      // per lead as commissionAmountPaise once terms are locked.
      prisma.lead.findMany({
        where: { status: 'CLOSED', commissionAmountPaise: { not: null }, updatedAt: range },
        select: { commissionAmountPaise: true },
      }),
    ]);

    const byName = {};
    for (const s of subs) {
      const name = s.service?.name || 'Other service';
      byName[name] = byName[name] || { volume: 0, revenue: 0 };
      byName[name].volume += 1;
      byName[name].revenue += s.amountPaid || 0;
    }

    const commissionRevenue = released.reduce((sum, l) => sum + (l.commissionAmountPaise || 0), 0) / 100;
    if (released.length) {
      byName['Escrow commission'] = { volume: released.length, revenue: round2(commissionRevenue) };
    }
    return byName;
  }

  const [current, previous] = await Promise.all([
    streams(start ?? new Date(0)),
    prevStart ? streams(prevStart, start) : Promise.resolve({}),
  ]);

  const names = [...new Set([...Object.keys(current), ...Object.keys(previous)])];
  const rows = names.map((name) => {
    const cur = current[name] || { volume: 0, revenue: 0 };
    const prv = previous[name] || { volume: 0, revenue: 0 };
    return {
      stream: name,
      volume: cur.volume,
      revenue: round2(cur.revenue),
      avgTicket: cur.volume ? round2(cur.revenue / cur.volume) : null,
      previousRevenue: round2(prv.revenue),
      // null rather than Infinity when there's no prior revenue to compare to.
      changePct: prv.revenue ? pct(cur.revenue - prv.revenue, prv.revenue) : null,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  return {
    period,
    totalRevenue: round2(rows.reduce((s, r) => s + r.revenue, 0)),
    streams: rows,
  };
}

// 13.5 — float income potential on money sitting in escrow. The yield is
// admin-set and defaults to 0, so this reports ₹0 rather than inventing an
// interest rate the business hasn't agreed.
async function getEscrowFloat() {
  const [held, releasedForAvg, yieldPct] = await Promise.all([
    prisma.escrowTransaction.aggregate({
      where: { status: { in: ['HELD', 'HELD_PAYOUT_FAILED'] } },
      _sum: { amount: true }, _count: { _all: true },
    }),
    prisma.escrowTransaction.findMany({
      where: { status: 'RELEASED', releasedAt: { not: null } },
      select: { createdAt: true, releasedAt: true },
    }),
    getConfigNumber('escrow_float_annual_yield_pct', 0),
  ]);

  // Only non-negative holds: some rows have releasedAt before createdAt, which
  // previously produced an average hold of -6 days and a negative "income".
  const rawHoldDays = releasedForAvg.map((t) => (new Date(t.releasedAt) - new Date(t.createdAt)) / DAY_MS);
  const holdDays = rawHoldDays.filter((d) => d >= 0);
  const avgHoldDays = holdDays.length ? round2(holdDays.reduce((a, b) => a + b, 0) / holdDays.length) : null;
  const heldAmount = held._sum.amount || 0;

  return {
    heldAmount,
    heldCount: held._count._all,
    avgHoldDays,
    // Surfaced rather than swallowed: these rows have releasedAt < createdAt.
    anomalousHoldRecords: rawHoldDays.length - holdDays.length,
    annualYieldPct: yieldPct,
    // Potential, not earned: what the current float would yield over the
    // average hold period at the configured rate.
    floatIncomePotential: yieldPct && avgHoldDays
      ? round2((heldAmount * (yieldPct / 100) * avgHoldDays) / 365)
      : 0,
  };
}

// ─── B9.4 / B9.5 / B9.6 — platform benchmarks ────────────────────────────────
//
// Response-time stages are named for what they actually measure. B9.5 asks for
// "lead to first contact", but no first-contact timestamp exists anywhere, so
// assignment is used and labelled as such rather than passed off as contact.

// siteVisitScheduledAt is the *booked appointment slot*, not the moment
// scheduling happened — scheduleVisit's validator requires it to be in the
// future. So otpVerifiedAt is routinely EARLIER than it (the buyer's OTP can
// be verified any time before the slot), and an earlier version of this file
// wrongly treated that as corrupt data and threw the records away. There is no
// timestamp for when scheduling occurred, so "time to schedule" is not
// measurable; the stages below only measure differences that are genuinely
// expected to be non-negative.
const DURATION_STAGES = ['leadToAssignment', 'assignmentToOtp', 'otpToEscrow', 'visitBookingLeadDays'];

function leadDurations(leads) {
  const out = {};
  for (const k of DURATION_STAGES) out[k] = [];
  for (const l of leads) {
    const created = new Date(l.createdAt).getTime();
    const assigned = l.assignedAt ? new Date(l.assignedAt).getTime() : null;
    const scheduled = l.siteVisitScheduledAt ? new Date(l.siteVisitScheduledAt).getTime() : null;
    const verified = l.otpVerifiedAt ? new Date(l.otpVerifiedAt).getTime() : null;
    const held = l.escrowTransactions?.find((e) => e.heldAt)?.heldAt;
    const heldAt = held ? new Date(held).getTime() : null;

    if (assigned) out.leadToAssignment.push((assigned - created) / DAY_MS);
    // Assignment through to a completed, OTP-verified visit. This is the real
    // partner throughput number, and it replaces the slot-relative stage.
    if (assigned && verified) out.assignmentToOtp.push((verified - assigned) / DAY_MS);
    if (verified && heldAt) out.otpToEscrow.push((heldAt - verified) / DAY_MS);
    // Not a response time: how far ahead the appointment slot was booked.
    if (assigned && scheduled) out.visitBookingLeadDays.push((scheduled - assigned) / DAY_MS);
  }
  return out;
}

function funnelOf(leads) {
  const received = leads.length;
  const accepted = leads.filter((l) => l.assignedPartnerId).length;
  const visits = leads.filter((l) => l.siteVisitScheduledAt).length;
  const otps = leads.filter((l) => l.isOtpVerified).length;
  const decided = leads.filter((l) => l.visitOutcome || ['VERIFIED_CLOSED', 'VERIFIED_DROPPED'].includes(l.buyerFeedbackStatus)).length;
  const closed = leads.filter((l) => l.status === 'CLOSED').length;
  return {
    received, accepted, visitsScheduled: visits, otpsVerified: otps, decided, closed,
    otpRatePct: pct(otps, visits),
    closeRatePct: pct(closed, received),
  };
}

const LEAD_METRIC_SELECT = {
  id: true, assignedPartnerId: true, status: true, isOtpVerified: true,
  createdAt: true, assignedAt: true, siteVisitScheduledAt: true, otpVerifiedAt: true,
  visitOutcome: true, buyerFeedbackStatus: true,
  escrowTransactions: { select: { heldAt: true } },
};

async function getPlatformBenchmarks(period = 'ALL') {
  const since = sinceFilter(period);
  const leads = await prisma.lead.findMany({
    where: {
      assignedPartnerId: { isSet: true },
      ...(since ? { createdAt: since } : {}),
    },
    select: LEAD_METRIC_SELECT,
  });

  const d = leadDurations(leads);
  const funnel = funnelOf(leads);
  return {
    period,
    sampleLeads: leads.length,
    funnel,
    responseDays: buildResponseDays(d),
    anomalies: detectAnomalies(funnel, d),
  };
}

// Each stage reports its median plus how many records were unusable, so a
// thin or dirty sample can't masquerade as a confident number.
function buildResponseDays(d) {
  const out = {
    note: 'No first-contact timestamp exists, so leadToAssignment measures assignment, not contact. visitBookingLeadDays is a booking horizon, not a response time. Time-to-schedule is not measurable: siteVisitScheduledAt is the booked slot, not when scheduling happened.',
  };
  for (const key of DURATION_STAGES) {
    const r = medianOfPositive(d[key]);
    out[key] = r.median;
    out[key + 'Samples'] = r.samples;
    if (r.discardedNegative) out[key + 'DiscardedNegative'] = r.discardedNegative;
  }
  return out;
}

// Stage counts that can't physically happen point at data problems, not
// performance. Reported so the page can warn rather than show 125%.
function detectAnomalies(fn, d) {
  const out = [];
  if (fn.otpsVerified > fn.visitsScheduled) {
    out.push({
      key: 'OTP_WITHOUT_SCHEDULED_VISIT',
      detail: `${fn.otpsVerified} OTPs verified but only ${fn.visitsScheduled} visits scheduled — some leads are OTP-verified with no siteVisitScheduledAt`,
    });
  }
  const negatives = DURATION_STAGES
    .map((k) => [k, d[k].filter((n) => n < 0).length]).filter(([, c]) => c > 0);
  for (const [stage, count] of negatives) {
    out.push({ key: 'NEGATIVE_DURATION', detail: `${count} lead(s) have out-of-order timestamps for ${stage}` });
  }
  return out;
}

// Partner funnel and response times side by side with the platform median,
// plus B9.6's percentile rank. Replaces the frontend's fixed multipliers.
async function getPartnerBenchmark(partnerId, period = 'ALL') {
  const since = sinceFilter(period);
  const [mine, platform, allPartnerLeads] = await Promise.all([
    prisma.lead.findMany({
      where: { assignedPartnerId: partnerId, ...(since ? { createdAt: since } : {}) },
      select: LEAD_METRIC_SELECT,
    }),
    getPlatformBenchmarks(period),
    prisma.lead.findMany({
      where: { assignedPartnerId: { isSet: true }, ...(since ? { createdAt: since } : {}) },
      select: { assignedPartnerId: true, status: true },
    }),
  ]);

  const d = leadDurations(mine);
  const myFunnel = funnelOf(mine);

  // B9.6 — percentile among partners who actually have leads in this window.
  const closedByPartner = new Map();
  for (const l of allPartnerLeads) {
    const key = l.assignedPartnerId;
    if (!closedByPartner.has(key)) closedByPartner.set(key, 0);
    if (l.status === 'CLOSED') closedByPartner.set(key, closedByPartner.get(key) + 1);
  }
  const scores = [...closedByPartner.values()].sort((a, b) => a - b);
  const myScore = closedByPartner.get(partnerId) ?? 0;
  const below = scores.filter((s) => s < myScore).length;
  const percentile = scores.length ? Math.round((below / scores.length) * 100) : null;

  return {
    period,
    partner: {
      funnel: myFunnel,
      responseDays: buildResponseDays(d),
    },
    platform: { funnel: platform.funnel, responseDays: platform.responseDays },
    anomalies: detectAnomalies(myFunnel, d),
    ranking: {
      // Percentile of partners this partner closed MORE than. null when
      // there aren't enough partners for a rank to mean anything.
      percentile: scores.length > 1 ? percentile : null,
      partnersCompared: scores.length,
      closedDeals: myScore,
    },
  };
}

module.exports = {
  PERIODS, periodStart,
  getFunnel, getUserGrowth, getNriSegment, getRevenueByStream, getEscrowFloat,
  getPlatformBenchmarks, getPartnerBenchmark,
  median, medianOfPositive, pct,
};
