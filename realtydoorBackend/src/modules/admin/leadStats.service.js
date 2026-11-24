// Lead numbers counted in the database (23 Nov 2026). The admin screens used to load the newest 50 leads and count those in the browser,
// so every number was wrong once there were more than 50 leads. Everything here is a count or an aggregate, never a list.
const prisma = require('../../lib/prisma');
const { LEAD_STATUSES } = require('../../lib/leadListFilter');
const { LIVE_LEADS } = require('../../lib/poolLeads');

const OPEN_STATUSES = ['UNASSIGNED', 'ASSIGNED', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_DONE'];
const STALL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Exact number of leads in each status, one request for all chips. Counts per status (not groupBy: groupBy on an enum fails on old rows). */
async function statusCounts() {
  const pairs = await Promise.all(LEAD_STATUSES.map(async (status) => [status, await prisma.lead.count({ where: { status, ...LIVE_LEADS } })]));
  return Object.fromEntries(pairs);
}

const stalledWhere = (now = Date.now()) => ({ status: { in: OPEN_STATUSES }, updatedAt: { lt: new Date(now - STALL_DAYS * DAY_MS) }, ...LIVE_LEADS });

/** Average days from a lead's creation to its close, over every closed lead with a close date, worked out by the database. */
async function averageCloseDays() {
  const res = await prisma.lead.aggregateRaw({
    pipeline: [
      { $match: { status: 'CLOSED', closedAt: { $type: 'date' }, createdAt: { $type: 'date' } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$closedAt', '$createdAt'] } }, n: { $sum: 1 } } },
    ],
  });
  const row = Array.isArray(res) ? res[0] : null;
  if (!row || !row.n) return { avgCloseDays: null, closedCount: 0 };
  return { avgCloseDays: Math.round((Number(row.avgMs) / DAY_MS) * 10) / 10, closedCount: row.n };
}

/** The Lead Monitor's cards and tab counts, across all leads. */
async function monitorSummary(now = Date.now()) {
  const [total, open, otpVerified, stalled, close] = await Promise.all([
    prisma.lead.count({ where: LIVE_LEADS }),
    prisma.lead.count({ where: { status: { in: OPEN_STATUSES }, ...LIVE_LEADS } }),
    prisma.lead.count({ where: { isOtpVerified: true, ...LIVE_LEADS } }),
    prisma.lead.count({ where: stalledWhere(now) }),
    averageCloseDays(),
  ]);
  // "Discrepancy" looked for a buyer feedback value DISPUTED that the schema does not have (BuyerFeedbackStatus), so it is always 0.
  // Kept at 0 rather than guessed; the owner decides what a discrepancy should mean.
  const discrepancy = 0;
  return { total, open, otpVerified, stalled, discrepancy, flagged: stalled + discrepancy, stallDays: STALL_DAYS, ...close };
}

/** The choices for the Monitor's partner and city filters: partners that hold leads, and the cities of listed properties. */
async function monitorFilterOptions() {
  const [partnerIds, cities] = await Promise.all([
    prisma.lead.findMany({ where: { assignedPartnerId: { not: null } }, distinct: ['assignedPartnerId'], select: { assignedPartnerId: true }, take: 500 }),
    prisma.property.findMany({ distinct: ['city'], select: { city: true }, take: 200 }),
  ]);
  const ids = partnerIds.map((r) => r.assignedPartnerId).filter(Boolean);
  const partners = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, companyName: true }, orderBy: { name: 'asc' } })
    : [];
  return {
    partners: partners.map((p) => ({ id: p.id, name: p.companyName || p.name || p.id })),
    cities: cities.map((c) => c.city).filter(Boolean).sort(),
  };
}

/** The qualification pool: how many unreleased leads per batch and group (A, B, C), for the pool screen's cards. */
async function poolSummary() {
  const rows = await prisma.lead.findMany({ where: { poolBatch: { isSet: true }, poolReleasedAt: { isSet: false } }, distinct: ['poolBatch'], select: { poolBatch: true }, take: 100 });
  const batches = rows.map((r) => r.poolBatch).filter(Boolean).sort();
  const out = [];
  for (const batch of batches) {
    const [A, B, C, released] = await Promise.all([
      ...['A', 'B', 'C'].map((g) => prisma.lead.count({ where: { poolBatch: batch, poolReleasedAt: { isSet: false }, poolGroup: g } })),
      prisma.lead.count({ where: { poolBatch: batch, poolReleasedAt: { isSet: true } } }),
    ]);
    out.push({ batch, A, B, C, released, total: A + B + C });
  }
  return { batches: out, total: out.reduce((s, b) => s + b.total, 0) };
}

module.exports = { poolSummary, statusCounts, monitorSummary, monitorFilterOptions, stalledWhere, OPEN_STATUSES, STALL_DAYS };
