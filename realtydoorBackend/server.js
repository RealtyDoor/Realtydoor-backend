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
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled promise rejection — shutting down', {
    error: err.message,
    stack: err.stack,
  });
  server.close(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', {
    error: err.message,
    stack: err.stack,
  });
  server.close(() => process.exit(1));
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — graceful shutdown');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — graceful shutdown');
  server.close(() => process.exit(0));
});
