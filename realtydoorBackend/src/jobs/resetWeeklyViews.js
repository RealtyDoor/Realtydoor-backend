const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');

// Runs every Monday at midnight — Property.viewsThisWeek needs to actually
// reset on a weekly cadence for the "this week" figure to mean what it says
// (FRONTEND_HANDOFF_SPEC.md §3.2).
async function runOnce() {
  const { count } = await prisma.property.updateMany({
    where: { viewsThisWeek: { gt: 0 } },
    data: { viewsThisWeek: 0 },
  });
  logger.info('[ResetWeeklyViews] Reset viewsThisWeek', { propertiesReset: count });
  return { propertiesReset: count };
}

function start() {
  cron.schedule('0 0 * * 1', () => {
    runOnce().catch((err) => {
      logger.error('[ResetWeeklyViews] Job failed', { error: err.message, stack: err.stack });
    });
  });

  logger.info('[Jobs] Weekly property views reset scheduled (Monday 00:00)');
}

module.exports = { start, runOnce };
