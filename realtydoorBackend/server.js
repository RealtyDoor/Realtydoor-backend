require('dotenv').config();
const app = require('./src/app');
const { validateEnv } = require('./src/config/env');
const logger = require('./src/lib/logger');

validateEnv();

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  logger.info(`RealtyDoor API started`, {
    port: PORT,
    env: process.env.NODE_ENV,
    pid: process.pid,
  });

  require('./src/jobs/whatsappFeedback').start();
  require('./src/jobs/expiredOtp').start();
  require('./src/jobs/stillDecidingFollowup').start();
  require('./src/jobs/cleanupIncompleteSignups').start();
  require('./src/jobs/escrowAutoEscalate').start();
  require('./src/jobs/resetWeeklyViews').start();
  require('./src/jobs/processAccountDeletions').start();
  require('./src/jobs/paymentReconcile').start();
});

// Under nodemon a restart sends SIGUSR2/SIGINT and waits for the process to
// exit. server.close() alone waits for every open keep-alive connection to
// end, which in dev (browser tabs, polling clients) can be forever, so the dev
// server froze on restart. Drop idle connections right away and force the exit
// after a short deadline whatever is still open.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 5000;

function shutdown(exitCode) {
  const forceTimer = setTimeout(() => {
    logger.warn('Shutdown timed out — forcing exit', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  server.close(() => {
    logger.info('Server closed');
    process.exit(exitCode);
  });
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled promise rejection — shutting down', {
    error: err.message,
    stack: err.stack,
  });
  shutdown(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', {
    error: err.message,
    stack: err.stack,
  });
  shutdown(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — graceful shutdown');
  shutdown(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — graceful shutdown');
  shutdown(0);
});
