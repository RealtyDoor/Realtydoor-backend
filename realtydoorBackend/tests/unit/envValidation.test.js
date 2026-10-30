// The boot-time check that stops a production server starting with a dangerous setting (a login bypass key, OTP echo, an open WATI
// webhook, a weak OTP secret, or no NODE_ENV at all). process.exit is replaced so the check can be observed.
const { validateEnv } = require('../../src/config/env');

const GOOD = {
  NODE_ENV: 'production', DATABASE_URL: 'mongodb://x', CLERK_SECRET_KEY: 'k', CLERK_WEBHOOK_SECRET: 'k', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 'k',
  RAZORPAY_WEBHOOK_SECRET: 'k', RAZORPAYX_ACCOUNT_NUMBER: '1', WATI_API_ENDPOINT: 'https://wati.example.com', WATI_ACCESS_TOKEN: 'k', WATI_WEBHOOK_TOKEN: 'tok',
  AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 'k', AWS_REGION: 'ap-south-2', AWS_S3_BUCKET: 'b', GMAIL_APP_PASSWORD: 'k', EMAIL_FROM: 'a@b.in',
  FRONTEND_URL: 'https://www.realtydoor.com', OTP_HASH_SECRET: 'x'.repeat(16),
};
const ENV = process.env;
let exit; let err;
beforeEach(() => {
  exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  err = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = ENV; exit.mockRestore(); err.mockRestore(); });
const check = (env) => { process.env = { ...env }; try { validateEnv(); return 'ok'; } catch { return 'exit'; } };

test('a complete production environment boots', () => expect(check(GOOD)).toBe('ok'));
test('a complete development environment boots without the WATI webhook token', () => {
  const { WATI_WEBHOOK_TOKEN, ...rest } = GOOD;
  expect(check({ ...rest, NODE_ENV: 'development' })).toBe('ok');
});
test.each([
  ['NODE_ENV missing (a forgotten value must not silently mean "not production")', { NODE_ENV: undefined }],
  ['NODE_ENV misspelled', { NODE_ENV: 'prod' }],
  ['DEV_API_KEY set in production (a login-as-anyone bypass)', { DEV_API_KEY: 'x' }],
  ['DEV_EXPOSE_OTP=true in production (OTP codes echoed in responses)', { DEV_EXPOSE_OTP: 'true' }],
  ['no WATI webhook token in production (forged replies)', { WATI_WEBHOOK_TOKEN: undefined }],
  ['an empty WATI webhook token in production', { WATI_WEBHOOK_TOKEN: '' }],
  ['an OTP hash secret under 16 characters', { OTP_HASH_SECRET: 'short' }],
  ['no OTP hash secret', { OTP_HASH_SECRET: undefined }],
  ['no Razorpay webhook secret', { RAZORPAY_WEBHOOK_SECRET: '' }],
  ['no Clerk webhook secret', { CLERK_WEBHOOK_SECRET: undefined }],
  ['a WATI endpoint that is not a URL', { WATI_API_ENDPOINT: 'nope' }],
])('refuses to boot with %s', (_n, change) => {
  expect(check({ ...GOOD, ...change })).toBe('exit');
  expect(exit).toHaveBeenCalledWith(1);
});
test('DEV_EXPOSE_OTP=false in production is fine (only "true" is dangerous)', () => expect(check({ ...GOOD, DEV_EXPOSE_OTP: 'false' })).toBe('ok'));
test('the error output names the variable but never prints its value', () => {
  check({ ...GOOD, OTP_HASH_SECRET: 'tooshort-secret' });
  expect(JSON.stringify(err.mock.calls)).not.toContain('tooshort-secret');
});

// Production on AWS: the task's IAM role supplies S3 credentials (no static keys), and the API may sit behind several frontend hosts.
test('production boots on an IAM role: no AWS keys, with a list of frontend origins as well', () => {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ...rest } = GOOD;
  expect(check({ ...rest, FRONTEND_URLS: 'https://www.realtydoor.com,https://app.realtydoor.com' })).toBe('ok');
});
test.each([
  ['only the AWS access key id (half a key pair)', { AWS_SECRET_ACCESS_KEY: undefined }],
  ['only the AWS secret key (half a key pair)', { AWS_ACCESS_KEY_ID: undefined }],
  ['no FRONTEND_URL, even with FRONTEND_URLS (emails and PDFs build their links from it)', { FRONTEND_URL: undefined, FRONTEND_URLS: 'https://www.realtydoor.com' }],
  ['a FRONTEND_URL that is not a URL', { FRONTEND_URL: 'nope' }],
])('refuses to boot with %s', (_n, change) => {
  expect(check({ ...GOOD, ...change })).toBe('exit');
});
