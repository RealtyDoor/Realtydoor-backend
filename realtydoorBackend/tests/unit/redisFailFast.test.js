// QA 24 Oct: with REDIS_URL set but nothing listening, GET /api/config/public took 2 to 6 seconds on every call (and the log held
// 3,600+ identical errors). The cache layer must fail open at once.
describe('src/lib/redis.js options', () => {
  let seen;
  beforeEach(() => {
    jest.resetModules();
    seen = { args: null, handlers: {} };
    jest.doMock('ioredis', () => function FakeRedis(url, opts) { seen.args = [url, opts]; this.on = (ev, fn) => { seen.handlers[ev] = fn; }; });
    jest.doMock('../../src/lib/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
    process.env.REDIS_URL = 'redis://localhost:6379';
  });
  afterEach(() => { delete process.env.REDIS_URL; jest.dontMock('ioredis'); jest.dontMock('../../src/lib/logger'); });

  test('commands fail at once when not connected, and none can take longer than half a second', () => {
    require('../../src/lib/redis');
    const opts = seen.args[1];
    expect(opts.enableOfflineQueue).toBe(false);
    expect(opts.commandTimeout).toBeLessThanOrEqual(500);
    expect(opts.maxRetriesPerRequest).toBeLessThanOrEqual(1);
    expect(opts.connectTimeout).toBeLessThanOrEqual(2000);
  });

  test('reconnecting backs off, capped at 10 seconds', () => {
    require('../../src/lib/redis');
    const { retryStrategy } = seen.args[1];
    expect(retryStrategy(1)).toBe(500);
    expect(retryStrategy(4)).toBe(2000);
    expect(retryStrategy(1000)).toBe(10000);
  });

  test('a storm of connection errors is logged once, with the count of the ones left out', () => {
    const logger = require('../../src/lib/logger');
    require('../../src/lib/redis');
    for (let i = 0; i < 50; i += 1) seen.handlers.error(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('ECONNREFUSED');
  });

  test('with no REDIS_URL there is no client at all (the cache is simply off)', () => {
    delete process.env.REDIS_URL;
    expect(require('../../src/lib/redis')).toBeNull();
  });
});

describe('the cache falls back to the database when Redis errors', () => {
  test('withCache returns the fresh value, quickly, when redis.get rejects', async () => {
    jest.resetModules();
    jest.doMock('../../src/lib/redis', () => ({ get: jest.fn().mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false")), set: jest.fn().mockRejectedValue(new Error('down')) }));
    jest.doMock('../../src/lib/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
    const { withCache } = require('../../src/lib/cache');
    const fn = jest.fn().mockResolvedValue({ ok: true });
    const t0 = Date.now();
    await expect(withCache('k', 60, fn)).resolves.toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(fn).toHaveBeenCalledTimes(1);
    jest.dontMock('../../src/lib/redis');
  });
});
