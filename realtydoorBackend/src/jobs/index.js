// Single place that starts the scheduled jobs. Add new jobs to JOB_MODULES.
//
// T54: with two or more API tasks behind a load balancer every task would run
// every job, so buyers got each WhatsApp follow-up twice. Set RUN_JOBS=false on
// every task except one (or on all of them, with a separate scheduler task
// that has RUN_JOBS=true). Unset means "run", so local and single-task setups
// behave as before.
const logger = require('../lib/logger');

const JOB_MODULES = [
  './whatsappFeedback',
  './expiredOtp',
  './stillDecidingFollowup',
  './cleanupIncompleteSignups',
  './escrowAutoEscalate',
  './escrowHoldExpiry',
  './resetWeeklyViews',
  './processAccountDeletions',
  './paymentReconcile',
];

function shouldRunJobs(env = process.env) {
  const v = String(env.RUN_JOBS ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(v);
}

function startJobs(env = process.env) {
  if (!shouldRunJobs(env)) {
    logger.info('Scheduled jobs disabled on this process (RUN_JOBS=false)');
    return false;
  }
  JOB_MODULES.forEach((m) => require(m).start());
  return true;
}

module.exports = { startJobs, shouldRunJobs, JOB_MODULES };
