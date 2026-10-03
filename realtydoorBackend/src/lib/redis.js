const Redis = require('ioredis');
const logger = require('./logger');

let client = null;

if (process.env.REDIS_URL) {
  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });

  client.on('error', (err) => {
    logger.warn(`Redis error: ${err.message}`);
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });
} else {
  logger.warn('REDIS_URL not set — response caching is disabled');
}

module.exports = client;
