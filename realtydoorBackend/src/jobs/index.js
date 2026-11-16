// Single place that starts the scheduled jobs. Add new jobs to JOB_MODULES.
//
// T54: with two or more API tasks behind a load balancer every task would run
// every job, so buyers got each WhatsApp follow-up twice. Set RUN_JOBS=false on
// every task except one (or on all of them, with a separate scheduler task
// that has RUN_JOBS=true). Unset means "run", so local and single-task setups
// behave as before.
const logger = require('../lib/logger');
const cron = require('node-cron');
const { withKeyLock } = require('../lib/keyLock');

// Audit Nov 2026 (O6, O7, O8). Every job's schedule goes through one wrapper that
//  - runs the job under a lock, so a run that is still going when the next one is due (or the same job on a second server) is skipped;
//  - remembers what is running, so shutdown can wait for it;
//  - uses India time unless the job names a time zone, so "3 am" in a comment is 3 am in India.
const JOB_TIME_ZONE = 'Asia/Kolkata';
const JOB_LOCK_STALE_SECONDS = 30 * 60;
const tasks = [];
const running = new Set();

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
  './visitReminder',
  './staffDigest',
  './leadHygiene',
];

function shouldRunJobs(env = process.env) {
  const v = String(env.RUN_JOBS ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(v);
}

async function runExclusive(name, fn) {
  const done = (async () => {
    const r = await withKeyLock(`job:${name}`, fn, { staleSeconds: JOB_LOCK_STALE_SECONDS });
    if (r.busy) logger.warn('[Jobs] skipped a run: the previous run of this job is still going', { job: name });
  })().catch((err) => logger.error('[Jobs] a job run failed', { job: name, error: err.message }));
  running.add(done);
  try { await done; } finally { running.delete(done); }
}

function startJobs(env = process.env) {
  if (!shouldRunJobs(env)) {
    logger.info('Scheduled jobs disabled on this process (RUN_JOBS=false)');
    return false;
  }
  const original = cron.schedule;
  try {
    JOB_MODULES.forEach((m) => {
      let n = 0;
      cron.schedule = (expression, fn, options = {}) => {
        const name = `${m.replace('./', '')}:${n += 1}`;
        const task = original.call(cron, expression, () => runExclusive(name, async () => fn()), { timezone: JOB_TIME_ZONE, ...options });
        tasks.push(task);
        return task;
      };
      require(m).start();
    });
  } finally {
    cron.schedule = original;
  }
  return true;
}

// Stops the schedules and waits (up to waitMs) for a run that is already going.
async function stopJobs(waitMs = 4000) {
  tasks.forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
  if (running.size) {
    await Promise.race([Promise.allSettled([...running]), new Promise((resolve) => { setTimeout(resolve, waitMs).unref(); })]);
  }
}

module.exports = { startJobs, stopJobs, runExclusive, shouldRunJobs, JOB_MODULES };
