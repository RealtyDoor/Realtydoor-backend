// 23 Nov 2026: parallel lead intake hit MongoDB write conflicts on the counter row; nextRefCode now retries them.
jest.mock('../../src/lib/prisma', () => ({ counter: { upsert: jest.fn() } }));
const prisma = require('../../src/lib/prisma');
const { nextRefCode } = require('../../src/lib/refCode');

const conflict = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), { code: 'P2034' });
const pause = () => Promise.resolve();

beforeEach(() => prisma.counter.upsert.mockReset());

test('retries a write conflict and returns the next code', async () => {
  prisma.counter.upsert.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ seq: 166 });
  await expect(nextRefCode('lead', { pause })).resolves.toBe('RD-L-000166');
  expect(prisma.counter.upsert).toHaveBeenCalledTimes(3);
});

test('recognises the conflict by its message when the code is missing', async () => {
  prisma.counter.upsert.mockRejectedValueOnce(new Error('write conflict')).mockResolvedValueOnce({ seq: 7 });
  await expect(nextRefCode('user', { pause })).resolves.toBe('RD-U-000007');
});

test('gives up after 10 conflicts', async () => {
  prisma.counter.upsert.mockRejectedValue(conflict());
  await expect(nextRefCode('lead', { pause })).rejects.toThrow(/write conflict/);
  expect(prisma.counter.upsert).toHaveBeenCalledTimes(10);
});

test('does not retry other errors', async () => {
  prisma.counter.upsert.mockRejectedValueOnce(new Error('connection refused'));
  await expect(nextRefCode('lead', { pause })).rejects.toThrow('connection refused');
  expect(prisma.counter.upsert).toHaveBeenCalledTimes(1);
});
