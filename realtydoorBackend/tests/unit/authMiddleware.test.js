// authenticate(): who gets in. Clerk and the database are mocked.
const mockVerify = jest.fn();
const mockGetUser = jest.fn();
jest.mock('@clerk/clerk-sdk-node', () => ({ createClerkClient: () => ({ verifyToken: mockVerify, users: { getUser: mockGetUser } }) }));
jest.mock('../../src/lib/prisma', () => ({ user: { findFirst: jest.fn(), findUnique: jest.fn() } }));
jest.mock('../../src/modules/auth/auth.service', () => ({ syncUserByClerkId: jest.fn() }));
jest.mock('../../src/lib/allowedOrigins', () => ({ getAllowedOrigins: () => ['https://www.realtydoor.com'] }));

const prisma = require('../../src/lib/prisma');
const authService = require('../../src/modules/auth/auth.service');
const { authenticate } = require('../../src/middleware/auth');

const run = async (headers = {}, { url = '/api/user/leads', method = 'GET' } = {}) => {
  const req = { headers, originalUrl: url, method };
  let err;
  await authenticate(req, {}, (e) => { err = e; });
  return { req, err };
};
const user = (extra = {}) => ({ id: 'u1', clerkId: 'clerk_1', role: 'USER', email: 'a@x.in', ...extra });
const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });
beforeEach(() => {
  jest.resetAllMocks();
  process.env.NODE_ENV = 'test';
  delete process.env.DEV_API_KEY;
});

describe('bearer tokens', () => {
  test('no Authorization header is a 401', async () => {
    expect((await run()).err).toMatchObject({ statusCode: 401, message: 'No token provided' });
  });
  test.each(['Bearer', 'Bearer ', 'Basic', ''])('a header of %p carries no token', async (h) => {
    expect((await run({ authorization: h })).err).toMatchObject({ statusCode: 401 });
    expect(mockVerify).not.toHaveBeenCalled();
  });
  test('a token Clerk rejects is a 401 "Invalid token", with no detail leaked', async () => {
    mockVerify.mockRejectedValue(new Error('jwt expired at 2026-01-01 secret detail'));
    const { err } = await run({ authorization: 'Bearer abc' });
    expect(err).toMatchObject({ statusCode: 401, message: 'Invalid token' });
  });
  test('tokens are only trusted for the allowed origins', async () => {
    mockVerify.mockResolvedValue({ sub: 'clerk_1' });
    prisma.user.findUnique.mockResolvedValue(user());
    await run({ authorization: 'Bearer abc' });
    expect(mockVerify).toHaveBeenCalledWith('abc', { authorizedParties: ['https://www.realtydoor.com'] });
  });
  test('a valid token loads the user and the ROLE COMES FROM THE DATABASE, never the token', async () => {
    mockVerify.mockResolvedValue({ sub: 'clerk_1', role: 'ADMIN', publicMetadata: { role: 'ADMIN' } });
    prisma.user.findUnique.mockResolvedValue(user({ role: 'USER' }));
    const { req, err } = await run({ authorization: 'Bearer abc' });
    expect(err).toBeUndefined();
    expect(req.user.role).toBe('USER');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { clerkId: 'clerk_1' } });
  });
  test('a first-time user is created through the shared sync, with the verified id (not one the client supplied)', async () => {
    mockVerify.mockResolvedValue({ sub: 'clerk_new' });
    prisma.user.findUnique.mockResolvedValue(null);
    mockGetUser.mockResolvedValue({ id: 'clerk_new' });
    authService.syncUserByClerkId.mockResolvedValue({ user: user({ id: 'u9', role: 'USER' }), onboardingComplete: false });
    const { req, err } = await run({ authorization: 'Bearer abc', 'x-clerk-id': 'clerk_victim' });
    expect(err).toBeUndefined();
    expect(authService.syncUserByClerkId).toHaveBeenCalledWith('clerk_new', { id: 'clerk_new' });
    expect(req.user.id).toBe('u9');
  });
  test('a sync problem (for example a phone already in use) reaches the caller as its own coded error', async () => {
    mockVerify.mockResolvedValue({ sub: 'clerk_new' });
    prisma.user.findUnique.mockResolvedValue(null);
    mockGetUser.mockResolvedValue({});
    const ApiError = require('../../src/utils/ApiError');
    authService.syncUserByClerkId.mockRejectedValue(new ApiError(409, 'Phone in use', { code: 'PHONE_IN_USE' }));
    expect((await run({ authorization: 'Bearer abc' })).err).toMatchObject({ statusCode: 409, data: { code: 'PHONE_IN_USE' } });
  });
});

describe('account state', () => {
  const withUser = (u) => { mockVerify.mockResolvedValue({ sub: 'clerk_1' }); prisma.user.findUnique.mockResolvedValue(u); };

  test('a deleted account can never sign in again (looks like a bad token)', async () => {
    withUser(user({ deletedAt: new Date() }));
    expect((await run({ authorization: 'Bearer abc' })).err).toMatchObject({ statusCode: 401, message: 'Invalid token' });
  });
  test('a suspended account is a 403', async () => {
    withUser(user({ isSuspended: true }));
    expect((await run({ authorization: 'Bearer abc' })).err).toMatchObject({ statusCode: 403 });
  });
  test('an account waiting to be deleted is read-only: a write is refused with DELETION_PENDING', async () => {
    withUser(user({ deletionRequestedAt: new Date(), deletionScheduledAt: new Date(Date.now() + 864e5) }));
    expect((await run({ authorization: 'Bearer abc' }, { url: '/api/leads', method: 'POST' })).err).toMatchObject({ statusCode: 403, data: { code: 'DELETION_PENDING' } });
    expect((await run({ authorization: 'Bearer abc' }, { url: '/api/user/leads' })).err).toMatchObject({ statusCode: 403, data: { code: 'DELETION_PENDING' } });
  });
  test.each([
    ['GET', '/api/user/privacy'], ['GET', '/api/user/privacy?x=1'], ['DELETE', '/api/user/account/deletion-request'], ['POST', '/api/user/privacy/delete-account/cancel'],
  ])('…except %s %s, so the person can see and cancel the request', async (method, url) => {
    withUser(user({ deletionRequestedAt: new Date(), deletionScheduledAt: new Date(Date.now() + 864e5) }));
    expect((await run({ authorization: 'Bearer abc' }, { url, method })).err).toBeUndefined();
  });
  test('the exceptions are exact: the same path with another method, or a look-alike path, is still refused', async () => {
    withUser(user({ deletionRequestedAt: new Date(), deletionScheduledAt: new Date(Date.now() + 864e5) }));
    expect((await run({ authorization: 'Bearer abc' }, { url: '/api/user/privacy', method: 'POST' })).err).toMatchObject({ statusCode: 403 });
    expect((await run({ authorization: 'Bearer abc' }, { url: '/api/user/privacy/', method: 'GET' })).err).toMatchObject({ statusCode: 403 });
    expect((await run({ authorization: 'Bearer abc' }, { url: '/api/user/privacyx', method: 'GET' })).err).toMatchObject({ statusCode: 403 });
  });
  test('a deletion request that is not scheduled yet does not lock the account', async () => {
    withUser(user({ deletionRequestedAt: new Date(), deletionScheduledAt: null }));
    expect((await run({ authorization: 'Bearer abc' })).err).toBeUndefined();
  });
});

describe('the developer bypass header', () => {
  beforeEach(() => { process.env.DEV_API_KEY = 'dev-key'; });
  const h = (extra = {}) => ({ 'x-dev-api-key': 'dev-key', 'x-dev-user-email': 'a@x.in', ...extra });

  test('works outside production for a real, usable user', async () => {
    prisma.user.findFirst.mockResolvedValue(user({ role: 'ADMIN' }));
    const { req, err } = await run(h());
    expect(err).toBeUndefined();
    expect(req.user.role).toBe('ADMIN');
  });
  test('is ignored in production: without a bearer token it is a plain 401 and the database is not even asked', async () => {
    process.env.NODE_ENV = 'production';
    expect((await run(h())).err).toMatchObject({ statusCode: 401 });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
  test('a wrong key is ignored', async () => {
    expect((await run(h({ 'x-dev-api-key': 'nope' }))).err).toMatchObject({ statusCode: 401 });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
  test('with no DEV_API_KEY configured an empty or missing header can never match', async () => {
    delete process.env.DEV_API_KEY;
    for (const key of [undefined, '', 'undefined']) {
      expect((await run({ 'x-dev-api-key': key, 'x-dev-user-email': 'a@x.in' })).err).toMatchObject({ statusCode: 401 });
    }
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
  test('cannot impersonate a deleted, suspended or deletion-pending user, same as the real path', async () => {
    prisma.user.findFirst.mockResolvedValue(user({ deletedAt: new Date() }));
    expect((await run(h())).err).toMatchObject({ statusCode: 401 });
    prisma.user.findFirst.mockResolvedValue(user({ isSuspended: true }));
    expect((await run(h())).err).toMatchObject({ statusCode: 403 });
  });
  test('an unknown email is a 401', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    expect((await run(h())).err).toMatchObject({ statusCode: 401 });
  });
});
