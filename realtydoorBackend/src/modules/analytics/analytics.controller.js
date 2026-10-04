const { success } = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const service = require('./analytics.service');
const { PERIODS } = require('./analytics.service');

// Shared so an unknown chip value fails loudly instead of silently being
// treated as MTD.
function parsePeriod(req, fallback = 'MTD') {
  const p = req.query.period;
  if (p && !PERIODS.includes(p)) {
    throw new ApiError(400, `period must be one of: ${PERIODS.join(', ')}`);
  }
  return p || fallback;
}

async function funnel(req, res, next) {
  try { success(res, await service.getFunnel(parsePeriod(req))); } catch (err) { next(err); }
}

async function users(req, res, next) {
  try { success(res, await service.getUserGrowth(parsePeriod(req))); } catch (err) { next(err); }
}

async function nri(req, res, next) {
  try { success(res, await service.getNriSegment(parsePeriod(req))); } catch (err) { next(err); }
}

async function revenue(req, res, next) {
  try { success(res, await service.getRevenueByStream(parsePeriod(req))); } catch (err) { next(err); }
}

async function escrowFloat(req, res, next) {
  try { success(res, await service.getEscrowFloat()); } catch (err) { next(err); }
}

async function benchmarks(req, res, next) {
  try { success(res, await service.getPlatformBenchmarks(parsePeriod(req, 'ALL'))); } catch (err) { next(err); }
}

// Everything the admin analytics page needs in one call.
async function overview(req, res, next) {
  try {
    const period = parsePeriod(req);
    const [f, u, n, r, fl] = await Promise.all([
      service.getFunnel(period), service.getUserGrowth(period), service.getNriSegment(period),
      service.getRevenueByStream(period), service.getEscrowFloat(),
    ]);
    success(res, { period, funnel: f, users: u, nri: n, revenue: r, escrowFloat: fl });
  } catch (err) { next(err); }
}

// B9.4-B9.6 — the partner's own figures against the platform median.
async function myBenchmark(req, res, next) {
  try {
    success(res, await service.getPartnerBenchmark(req.user.id, parsePeriod(req, 'ALL')));
  } catch (err) { next(err); }
}

module.exports = { funnel, users, nri, revenue, escrowFloat, benchmarks, overview, myBenchmark };
