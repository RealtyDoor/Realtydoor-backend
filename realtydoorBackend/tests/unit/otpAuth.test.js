// Phone sign-up / sign-in codes (lib/otpAuth.js). Prisma is replaced by a tiny in-memory table that, like the real database, lets
// requests interleave, so a race between parallel guesses can be shown. WhatsApp is a recorder.
process.env.OTP_HASH_SECRET = 'unit-test-secret-0123456789';
process.env.NODE_ENV = 'test';

const mockTable = new Map();
let mockSeq = 0;
const tick = () => new Promise((r) => setImmediate(r));
const matches = (row, where) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return v.some((w) => matches(row, w));
  if (v && typeof v === 'object' && 'lte' in v) return row[k] != null && row[k] <= v.lte;
  if (k === 'phone_purpose') return row.phone === v.phone && row.purpose === v.purpose;
  if (v && typeof v === 'object' && 'lt' in v) return row[k] < v.lt;
  return row[k] === v;
});
const apply = (row, data) => {
  for (const [k, v] of Object.entries(data)) row[k] = (v && typeof v === 'object' && 'increment' in v) ? (row[k] || 0) + v.increment : v;
  return row;
};
jest.mock('../../src/lib/prisma', () => ({
  phoneOtp: {
    findUnique: jest.fn(async ({ where }) => { await tick(); const r = [...mockTable.values()].find((x) => matches(x, where)); return r ? { ...r } : null; }),
    create: jest.fn(async ({ data }) => { await tick(); const row = { id: `o${++mockSeq}`, attempts: 0, lockCount: 0, lockedUntil: null, lastLockedAt: null, ...data }; mockTable.set(row.id, row); return { ...row }; }),
    update: jest.fn(async ({ where, data }) => {
      await tick();
      const r = [...mockTable.values()].find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
      return { ...apply(r, data) };
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      await tick();
      const rows = [...mockTable.values()].filter((x) => matches(x, where));
      rows.forEach((r) => apply(r, data));
      return { count: rows.length };
    }),
    delete: jest.fn(async ({ where }) => { await tick(); if (!mockTable.has(where.id)) throw Object.assign(new Error('gone'), { code: 'P2025' }); mockTable.delete(where.id); }),
  },
}));
jest.mock('../../src/lib/wati', () => ({ sendPhoneVerificationOtp: jest.fn().mockResolvedValue() }));

const prisma = require('../../src/lib/prisma');
const { sendPhoneVerificationOtp } = require('../../src/lib/wati');
const otpAuth = require('../../src/lib/otpAuth');

const PHONE = '+919000000001';
const rowOf = () => [...mockTable.values()][0];
const lastCode = () => sendPhoneVerificationOtp.mock.calls.at(-1)[1];
const wrongCode = () => (lastCode() === '000000' ? '000001' : '000000');
const expectCode = async (p, code) => { const e = await p.then(() => null, (x) => x); expect(e?.data?.code).toBe(code); };
const age = (ms) => { const r = rowOf(); r.lastSentAt = new Date(Date.now() - ms); };

beforeEach(() => { mockTable.clear(); jest.clearAllMocks(); });

describe('sending', () => {
  test('creates one row per phone and purpose, stores only a hash, and sends a 6-digit code', async () => {
    await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' });
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(rowOf().codeHash).toBe(otpAuth.hashCode(lastCode()));
    expect(rowOf().codeHash).not.toContain(lastCode());
    expect(sendPhoneVerificationOtp).toHaveBeenCalledWith(PHONE, lastCode());
  });
  test('the result never contains the code outside development exposure', async () => {
    const out = await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' });
    expect(JSON.stringify(out)).not.toContain(lastCode());
    expect(out._devOtp).toBeUndefined();
  });
  test('development exposure echoes the code only outside production and only when switched on', async () => {
    process.env.DEV_EXPOSE_OTP = 'true';
    expect((await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' }))._devOtp).toBe(lastCode());
    mockTable.clear();
    process.env.NODE_ENV = 'production';
    expect((await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' }))._devOtp).toBeUndefined();
    process.env.NODE_ENV = 'test';
    delete process.env.DEV_EXPOSE_OTP;
  });
  test('a second request inside 30 seconds is refused (OTP_RESEND_COOLDOWN) and sends nothing', async () => {
    await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' });
    await expectCode(otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' }), 'OTP_RESEND_COOLDOWN');
    expect(sendPhoneVerificationOtp).toHaveBeenCalledTimes(1);
  });
  test('at most 3 codes an hour for one number, then OTP_SEND_LIMIT', async () => {
    for (let i = 0; i < 3; i += 1) { await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' }); age(31e3); }
    await expectCode(otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' }), 'OTP_SEND_LIMIT');
    expect(sendPhoneVerificationOtp).toHaveBeenCalledTimes(3);
  });
  test('after the hour the counter starts again', async () => {
    for (let i = 0; i < 3; i += 1) { await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' }); age(31e3); }
    age(61 * 60e3);
    await expect(otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' })).resolves.toBeTruthy();
  });
  test('different purposes and different numbers do not share limits', async () => {
    await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' });
    await expect(otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'SIGNUP' })).resolves.toBeTruthy();
    await expect(otpAuth.createAndSendOtp({ phone: '+919000000002', purpose: 'LOGIN' })).resolves.toBeTruthy();
  });
  test('a locked number cannot ask for a new code (so a lock cannot be skipped by resending)', async () => {
    await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' });
    rowOf().lockedUntil = new Date(Date.now() + 60e3);
    await expectCode(otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' }), 'OTP_LOCKED');
  });
  test('a resend replaces the code and clears the attempt count', async () => {
    await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' });
    const first = lastCode();
    rowOf().attempts = 4; age(31e3);
    await otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' });
    expect(rowOf().attempts).toBe(0);
    if (lastCode() !== first) await expectCode(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: first }), 'OTP_INVALID');
  });
  test('in production a WhatsApp failure is an error; elsewhere it is logged and the flow continues', async () => {
    sendPhoneVerificationOtp.mockRejectedValueOnce(new Error('WATI down'));
    await expect(otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' })).resolves.toBeTruthy();
    mockTable.clear();
    process.env.NODE_ENV = 'production';
    sendPhoneVerificationOtp.mockRejectedValueOnce(new Error('WATI down'));
    await expect(otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN' })).rejects.toThrow('WATI down');
    process.env.NODE_ENV = 'test';
  });
});

describe('verifying', () => {
  const issue = () => otpAuth.createAndSendOtp({ phone: PHONE, purpose: 'LOGIN', payload: { name: 'A' } });

  test('the right code returns the stored payload and is used up (a replay is invalid)', async () => {
    await issue();
    const code = lastCode();
    await expect(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code })).resolves.toEqual({ payload: { name: 'A' } });
    await expectCode(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code }), 'OTP_INVALID');
  });
  test('a code for another number or purpose is invalid', async () => {
    await issue();
    await expectCode(otpAuth.verifyOtp({ phone: '+919000000002', purpose: 'LOGIN', code: lastCode() }), 'OTP_INVALID');
    await expectCode(otpAuth.verifyOtp({ phone: PHONE, purpose: 'SIGNUP', code: lastCode() }), 'OTP_INVALID');
  });
  test('an expired code is invalid even if correct', async () => {
    await issue();
    rowOf().expiresAt = new Date(Date.now() - 1);
    await expectCode(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: lastCode() }), 'OTP_INVALID');
  });
  test('every failure looks the same: nothing says whether the number exists, the code was wrong or expired', async () => {
    const msg = async (p) => (await p.then(() => null, (e) => e)).message;
    const none = await msg(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: '123456' }));
    await issue();
    const wrong = await msg(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: wrongCode() }));
    rowOf().expiresAt = new Date(Date.now() - 1);
    const expired = await msg(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: lastCode() }));
    expect(new Set([none, wrong, expired]).size).toBe(1);
  });
  test.each([[undefined], [null], [''], [123456], [['123456']], [{}], ['12345'], ['1234567'], ['abcdef']])('a guess of %j is invalid and never throws a server error', async (code) => {
    await issue();
    const e = await otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code }).then(() => null, (x) => x);
    expect(e?.statusCode).toBe(400);
  });
  test('five wrong guesses lock the number; then even the right code is refused', async () => {
    await issue();
    const good = lastCode();
    for (let i = 0; i < 5; i += 1) await expectCode(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: wrongCode() }), 'OTP_INVALID');
    expect(rowOf().lockedUntil.getTime()).toBeGreaterThan(Date.now());
    await expectCode(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: good }), 'OTP_LOCKED');
  });
  test('the right code on the fifth try still works (four wrong before it)', async () => {
    await issue();
    const good = lastCode();
    for (let i = 0; i < 4; i += 1) await expectCode(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: wrongCode() }), 'OTP_INVALID');
    await expect(otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: good })).resolves.toBeTruthy();
  });
  test('locks get longer when they are triggered again within a day (10 min, 30 min, 90 min, capped at 4 hours)', async () => {
    await issue();
    const lockMinutes = [];
    for (let round = 0; round < 6; round += 1) {
      const r = rowOf();
      r.lockedUntil = null; r.attempts = 0; r.expiresAt = new Date(Date.now() + 600e3);
      for (let i = 0; i < 5; i += 1) await otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: wrongCode() }).catch(() => {});
      lockMinutes.push(Math.round((rowOf().lockedUntil.getTime() - Date.now()) / 60e3));
    }
    expect(lockMinutes.slice(0, 3)).toEqual([10, 30, 90]);
    expect(lockMinutes[3]).toBe(240);
    expect(lockMinutes[5]).toBe(240);
  });

  test('PARALLEL GUESSES: sending many wrong codes at once must not get more than five of them checked', async () => {
    await issue();
    const results = await Promise.all(Array.from({ length: 40 }, () => otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code: wrongCode() }).then(() => 'accepted', (e) => e.data.code)));
    const checked = results.filter((r) => r === 'OTP_INVALID').length;
    expect(results).not.toContain('accepted');
    expect(checked).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r === 'OTP_LOCKED').length).toBe(40 - checked);
  });

  test('two parallel submissions of the RIGHT code: one succeeds, the other is told it is invalid (no crash)', async () => {
    await issue();
    const code = lastCode();
    const results = await Promise.all([1, 2].map(() => otpAuth.verifyOtp({ phone: PHONE, purpose: 'LOGIN', code }).then(() => 'ok', (e) => e.data.code)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'OTP_INVALID')).toHaveLength(1);
  });
});

describe('helpers', () => {
  test('codeMatches is false, not a throw, for a stored hash of the wrong length', () => {
    expect(otpAuth.codeMatches('123456', 'abcd')).toBe(false);
    expect(otpAuth.codeMatches('123456', otpAuth.hashCode('123456'))).toBe(true);
  });
  test('generateCode is always 6 digits, including leading zeros', () => {
    for (let i = 0; i < 500; i += 1) expect(otpAuth.generateCode()).toMatch(/^\d{6}$/);
  });
});
