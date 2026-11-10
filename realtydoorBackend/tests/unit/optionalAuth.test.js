// optionalAuthenticate(): for public routes whose answer can be tailored to a signed-in person (the checkout quote). It never blocks anyone:
// no token, a bad token or a suspended account all continue as anonymous; a good token continues with req.user set.
const mockVerify = jest.fn();
jest.mock('@clerk/clerk-sdk-node', () => ({ createClerkClient: () => ({ verifyToken: mockVerify, users: { getUser: jest.fn() } }) }));
jest.mock('../../src/lib/prisma', () => ({ user: { findFirst: jest.fn(), findUnique: jest.fn() } }));
jest.mock('../../src/modules/auth/auth.service', () => ({ syncUserByClerkId: jest.fn() }));
jest.mock('../../src/lib/allowedOrigins', () => ({ getAllowedOrigins: () => ['https://www.realtydoor.com'] }));

const prisma = require('../../src/lib/prisma');
const { optionalAuthenticate } = require('../../src/middleware/auth');

const run = async (headers = {}) => {
  const req = { headers, originalUrl: '/api/escrow/quote', method: 'GET' };
  const calls = [];
  await optionalAuthenticate(req, {}, (e) => calls.push(e));
  return { req, calls };
};
beforeEach(() => { jest.resetAllMocks(); process.env.NODE_ENV = 'test'; delete process.env.DEV_API_KEY; });

test('no token continues anonymously', async () => {
  const { req, calls } = await run();
  expect(calls).toEqual([undefined]);
  expect(req.user).toBeUndefined();
});
test('a bad token continues anonymously', async () => {
  mockVerify.mockRejectedValue(new Error('bad'));
  const { req, calls } = await run({ authorization: 'Bearer nope' });
  expect(calls).toEqual([undefined]);
  expect(req.user).toBeUndefined();
});
test('a suspended account continues anonymously', async () => {
  mockVerify.mockResolvedValue({ sub: 'clerk_1' });
  prisma.user.findFirst.mockResolvedValue({ id: 'u1', clerkId: 'clerk_1', role: 'USER', isSuspended: true });
  prisma.user.findUnique.mockResolvedValue({ id: 'u1', clerkId: 'clerk_1', role: 'USER', isSuspended: true });
  const { req, calls } = await run({ authorization: 'Bearer t' });
  expect(calls).toEqual([undefined]);
  expect(req.user).toBeUndefined();
});
test('a good token sets req.user', async () => {
  mockVerify.mockResolvedValue({ sub: 'clerk_1' });
  const u = { id: 'u1', clerkId: 'clerk_1', role: 'USER', email: 'a@x.in', isNRI: true };
  prisma.user.findFirst.mockResolvedValue(u);
  prisma.user.findUnique.mockResolvedValue(u);
  const { req, calls } = await run({ authorization: 'Bearer t' });
  expect(calls).toEqual([undefined]);
  expect(req.user).toMatchObject({ id: 'u1', isNRI: true });
});
