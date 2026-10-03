const redis = require('./redis');
const logger = require('./logger');

// Fails open everywhere: if Redis is unset, down, or errors, callers fall
// straight through to the DB instead of the request breaking.

async function cacheGet(key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn(`cacheGet failed for ${key}: ${err.message}`);
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn(`cacheSet failed for ${key}: ${err.message}`);
  }
}

async function cacheDel(...keys) {
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    logger.warn(`cacheDel failed for ${keys.join(', ')}: ${err.message}`);
  }
}

async function cacheDelPattern(pattern) {
  if (!redis) return;
  try {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    logger.warn(`cacheDelPattern failed for ${pattern}: ${err.message}`);
  }
}

async function withCache(key, ttlSeconds, fn) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const fresh = await fn();
  cacheSet(key, fresh, ttlSeconds);
  return fresh;
}

module.exports = { cacheGet, cacheSet, cacheDel, cacheDelPattern, withCache };
