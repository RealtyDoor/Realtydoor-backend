jest.mock('../../src/lib/prisma', () => {
  const rows = new Map();
  return { __rows: rows, counter: {
    create: jest.fn(async ({ data }) => { if (rows.has(data.id)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } rows.set(data.id, data.seq); }),
    findUnique: jest.fn(async ({ where }) => (rows.has(where.id) ? { id: where.id, seq: rows.get(where.id) } : null)),
    updateMany: jest.fn(async ({ where, data }) => { if (rows.get(where.id) === where.seq) { rows.set(where.id, data.seq); return { count: 1 }; } return { count: 0 }; }),
    deleteMany: jest.fn(async ({ where }) => { rows.delete(where.id); return { count: 1 }; }),
  } };
});
const prisma = require('../../src/lib/prisma');
const { withKeyLock } = require('../../src/lib/keyLock');

beforeEach(() => prisma.__rows.clear());

test('two callers at the same instant: one runs, the other is told it is busy', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = withKeyLock('k', async () => { await gate; return 'done'; });
  const second = await withKeyLock('k', async () => 'never');
  expect(second).toEqual({ busy: true });
  release();
  expect(await first).toEqual({ busy: false, value: 'done' });
});

test('the lock is released afterwards, even when the work throws', async () => {
  await expect(withKeyLock('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(await withKeyLock('k', async () => 1)).toEqual({ busy: false, value: 1 });
});

test('a stale lock left by a crashed process is taken over', async () => {
  prisma.__rows.set('lock:k', Math.floor(Date.now() / 1000) - 120);
  expect(await withKeyLock('k', async () => 'ok')).toEqual({ busy: false, value: 'ok' });
});

test('a fresh lock is respected', async () => {
  prisma.__rows.set('lock:k', Math.floor(Date.now() / 1000) - 2);
  expect(await withKeyLock('k', async () => 'no')).toEqual({ busy: true });
});
