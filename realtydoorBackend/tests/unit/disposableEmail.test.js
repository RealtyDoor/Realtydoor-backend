// Temp-mail blocklist (18 Nov 2026): the list itself, and the rule that only a NEW account is ever refused, only when the switch is on.
const mockDeleteUser = jest.fn().mockResolvedValue({});
jest.mock('@clerk/clerk-sdk-node', () => ({ createClerkClient: () => ({ users: { deleteUser: (...a) => mockDeleteUser(...a) } }) }));
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
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn(), createNotification: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendWelcomeEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/lib/wati', () => ({ sendWelcomeWhatsApp: jest.fn(() => Promise.resolve()) }));

const { isDisposableEmail, isBlockingEnabled, BUILTIN } = require('../../src/lib/disposableEmail');
const prisma = require('../../src/lib/prisma');

describe('isDisposableEmail', () => {
  test.each(['a@mailinator.com', 'A@Mailinator.COM', 'x@sub.mailinator.com', 'me@yopmail.com', 'q@10minutemail.com'])('%s is blocked', (e) => {
    expect(isDisposableEmail(e, {})).toBe(true);
  });
  test.each(['a@gmail.com', 'a@realtydoor.com', 'a@aashrithaa.com', 'a@mailinator.com.au.example.org', 'not-an-email', '', null, 'a@localhost', '@mailinator.com'])('%s is allowed', (e) => {
    expect(isDisposableEmail(e, {})).toBe(false);
  });
  test('extra domains from the environment are added', () => {
    expect(isDisposableEmail('a@my-temp.test', {})).toBe(false);
    expect(isDisposableEmail('a@my-temp.test', { DISPOSABLE_EMAIL_EXTRA_DOMAINS: ' other.test , my-temp.test ' })).toBe(true);
  });
  test('the built-in list holds no real mail provider', () => {
    for (const d of ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'icloud.com', 'protonmail.com', 'realtydoor.com']) expect(BUILTIN).not.toContain(d);
  });
  test('the switch is off unless exactly "true"', () => {
    expect(isBlockingEnabled({})).toBe(false);
    expect(isBlockingEnabled({ BLOCK_DISPOSABLE_EMAILS: '1' })).toBe(false);
    expect(isBlockingEnabled({ BLOCK_DISPOSABLE_EMAILS: 'true' })).toBe(true);
  });
});

describe('syncUserByClerkId and temporary emails', () => {
  const clerkUser = (email) => ({ emailAddresses: [{ emailAddress: email, verification: { status: 'verified' } }], firstName: 'Test', lastName: 'User', createdAt: Date.now() - 1000, publicMetadata: {} });
  const svc = () => require('../../src/modules/auth/auth.service');
  const refusal = async (p) => p.then(() => null, (e) => (e.data && e.data.code) || e.message);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOCK_DISPOSABLE_EMAILS;
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
  });
  afterEach(() => { delete process.env.BLOCK_DISPOSABLE_EMAILS; });

  test('switch ON, new account, temp mail: refused with a clear code and the stray Clerk identity removed', async () => {
    process.env.BLOCK_DISPOSABLE_EMAILS = 'true';
    const p = svc().syncUserByClerkId('user_1', clerkUser('buyer@mailinator.com'));
    await expect(p).rejects.toMatchObject({ statusCode: 403, data: { code: 'DISPOSABLE_EMAIL' } });
    expect(mockDeleteUser).toHaveBeenCalledWith('user_1');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
  test('switch OFF: the same sign-up is not refused for this reason', async () => {
    expect(await refusal(svc().syncUserByClerkId('user_2', clerkUser('buyer@mailinator.com')))).not.toBe('DISPOSABLE_EMAIL');
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
  test('switch ON, an account that already exists is never locked out', async () => {
    process.env.BLOCK_DISPOSABLE_EMAILS = 'true';
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', clerkId: 'user_3', email: 'old@mailinator.com', role: 'USER', isSuspended: false });
    expect(await refusal(svc().syncUserByClerkId('user_3', clerkUser('old@mailinator.com')))).not.toBe('DISPOSABLE_EMAIL');
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
  test('switch ON, a normal address is not refused for this reason', async () => {
    process.env.BLOCK_DISPOSABLE_EMAILS = 'true';
    expect(await refusal(svc().syncUserByClerkId('user_4', clerkUser('buyer@gmail.com')))).not.toBe('DISPOSABLE_EMAIL');
  });
});
