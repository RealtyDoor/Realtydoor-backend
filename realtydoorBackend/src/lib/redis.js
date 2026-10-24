const Redis = require('ioredis');
const logger = require('./logger');

let client = null;

if (process.env.REDIS_URL) {
  // The cache must never slow a request down. If Redis is unreachable (not started, wrong address, network blip) a cached
  // endpoint used to wait through ioredis's own retries for 2 to 6 seconds before falling back to the database, on every call,
  // and the log filled with thousands of identical errors. So: commands fail at once while not connected (no offline queue),
  // no command may take longer than half a second, and reconnecting backs off up to 10 seconds.
  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 500,
    retryStrategy: (attempt) => Math.min(attempt * 500, 10000),
    lazyConnect: false,
  });

  // One line per 30 seconds (with how many were left out) instead of one per reconnect attempt.
  let lastLogged = 0;
  let suppressed = 0;
  client.on('error', (err) => {
    const now = Date.now();
    if (now - lastLogged < 30000) { suppressed += 1; return; }
    logger.warn(`Redis error: ${err.message || err.code || 'connection problem'}${suppressed ? ` (${suppressed} similar errors in the last 30 s not logged)` : ''}`);
    lastLogged = now;
    suppressed = 0;
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });
} else {
  logger.warn('REDIS_URL not set — response caching is disabled');
}

module.exports = client;
