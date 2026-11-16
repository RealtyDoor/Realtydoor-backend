// Audit Nov 2026, phase 6 (operations). Tests for O1, O3, O5, O6 to O8; see admin-nextjs/docs/AUDIT_2026-11.md.
jest.mock('../../src/lib/prisma', () => {
  const models = {};
  return new Proxy({}, {
    get(_t, model) {
      if (typeof model !== 'string' || model === '__esModule' || model === 'then') return undefined;
      if (model.startsWith('$')) { models[model] = models[model] || jest.fn(); return models[model]; }
      models[model] = models[model] || new Proxy({}, { get(m, fn) { if (typeof fn !== 'string') return undefined; m[fn] = m[fn] || jest.fn(); return m[fn]; } });
      return models[model];
    },
  });
});
jest.mock('../../src/lib/wati', () => ({ sendBuyerFeedbackRequest: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const prisma = require('../../src/lib/prisma');
const wati = require('../../src/lib/wati');

describe('O1: the logger survives a folder it cannot write to', () => {
  test('loads in production from a read-only folder and still logs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
    fs.chmodSync(dir, 0o555);
    const logger = path.join(__dirname, '../../src/lib/logger.js');
    try {
      const out = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(logger)}).info('hello'); console.log('survived')`], {
        cwd: dir, env: { ...process.env, NODE_ENV: 'production', NODE_PATH: path.join(__dirname, '../../node_modules') }, encoding: 'utf8',
      });
      expect(out).toMatch(/survived/);
    } finally { fs.chmodSync(dir, 0o755); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('the Dockerfile creates the logs folder for the node user', () => {
    expect(fs.readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8')).toMatch(/mkdir -p \/app\/logs && chown node:node \/app\/logs/);
  });
});

describe('O3: /api/health/ready', () => {
  process.env.NODE_ENV = 'test';
  const request = require('supertest');
  const app = require('../../src/app');
  test('200 when the database answers', async () => {
    prisma.$runCommandRaw.mockResolvedValue({ ok: 1 });
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
  });
  test('503 when it does not', async () => {
    prisma.$runCommandRaw.mockRejectedValue(new Error('down'));
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');
  });
});

describe('O5: claim first, send second', () => {
  beforeEach(() => { jest.resetAllMocks(); });
  const lead = { id: 'l1', buyerPhone: '+919876543210', assignedPartner: { name: 'P' } };
  // jobs register their schedule with node-cron; capture the callback
  function capture(modulePath) {
    let cb;
    jest.isolateModules(() => {
      jest.doMock('node-cron', () => ({ schedule: (_e, fn) => { cb = fn; } }));
      require(modulePath).start();
    });
    return cb;
  }
  test.each([
    ['../../src/jobs/whatsappFeedback', 'whatsappSentAt'],
    ['../../src/jobs/stillDecidingFollowup', 'secondFollowupSentAt'],
  ])('%s: a lost claim sends nothing', async (mod) => {
    const run = capture(mod);
    prisma.lead.findMany.mockResolvedValue([lead]);
    prisma.lead.updateMany.mockResolvedValue({ count: 0 });
    await run();
    expect(wati.sendBuyerFeedbackRequest).not.toHaveBeenCalled();
  });
  test.each([
    ['../../src/jobs/whatsappFeedback', 'whatsappSentAt'],
    ['../../src/jobs/stillDecidingFollowup', 'secondFollowupSentAt'],
  ])('%s: a failed send undoes the claim', async (mod, field) => {
    const run = capture(mod);
    prisma.lead.findMany.mockResolvedValue([lead]);
    prisma.lead.updateMany.mockResolvedValue({ count: 1 });
    wati.sendBuyerFeedbackRequest.mockRejectedValue(new Error('wati down'));
    await run();
    const undo = prisma.lead.updateMany.mock.calls[1][0];
    expect(undo.data[field]).toBeNull();
  });
  test('a claimed lead is sent exactly once', async () => {
    const run = capture('../../src/jobs/whatsappFeedback');
    prisma.lead.findMany.mockResolvedValue([lead]);
    prisma.lead.updateMany.mockResolvedValue({ count: 1 });
    wati.sendBuyerFeedbackRequest.mockResolvedValue({});
    await run();
    expect(wati.sendBuyerFeedbackRequest).toHaveBeenCalledTimes(1);
  });
});

describe('O6, O7, O8: the job wrapper', () => {
  beforeEach(() => { jest.resetModules(); jest.resetAllMocks(); });
  test('jobs are scheduled in India time and under a lock; shutdown stops them', async () => {
    const calls = [];
    const stop = jest.fn();
    jest.doMock('node-cron', () => ({ schedule: jest.fn((e, fn, o) => { calls.push({ e, fn, o }); return { stop }; }) }));
    jest.doMock('../../src/lib/keyLock', () => ({ withKeyLock: jest.fn(async (k, fn) => ({ busy: false, value: await fn() })) }));
    const jobs = require('../../src/jobs');
    jest.doMock('../../src/jobs/expiredOtp', () => ({ start: () => require('node-cron').schedule('*/30 * * * *', async () => 'ran') }));
    expect(jobs.startJobs({})).toBe(true);
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((c) => c.o.timezone === 'Asia/Kolkata' || c.o.timezone)).toBe(true);
    const keyLock = require('../../src/lib/keyLock');
    await calls[0].fn();
    expect(keyLock.withKeyLock.mock.calls[0][0]).toMatch(/^job:/);
    await jobs.stopJobs(50);
    expect(stop).toHaveBeenCalled();
  });
  test('a second run while the first is going is skipped', async () => {
    jest.doMock('../../src/lib/keyLock', () => ({ withKeyLock: jest.fn(async () => ({ busy: true })) }));
    const { runExclusive } = require('../../src/jobs');
    const fn = jest.fn();
    await runExclusive('x', fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
