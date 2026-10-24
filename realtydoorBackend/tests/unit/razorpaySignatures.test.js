// Webhook and checkout signatures (real HMAC, no network), and the bank-account check before a payout.
const crypto = require('crypto');
const ENV = { ...process.env };
let rz;
beforeEach(() => {
  jest.resetModules();
  process.env = { ...ENV, RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 'key-secret', RAZORPAY_WEBHOOK_SECRET: 'wh-secret', RAZORPAYX_ACCOUNT_NUMBER: '1234' };
  rz = require('../../src/lib/razorpay');
});
afterAll(() => { process.env = ENV; });

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

describe('verifyWebhookSignature', () => {
  const body = Buffer.from('{"event":"payment.captured"}');
  test('the correct HMAC of the exact bytes passes', () => expect(rz.verifyWebhookSignature(body, hmac('wh-secret', body))).toBe(true));
  test('a one-byte change in the body fails', () => expect(rz.verifyWebhookSignature(Buffer.from('{"event":"payment.captureD"}'), hmac('wh-secret', body))).toBe(false));
  test('a signature made with another secret fails', () => expect(rz.verifyWebhookSignature(body, hmac('other', body))).toBe(false));
  test('the checkout key secret is not the webhook secret', () => expect(rz.verifyWebhookSignature(body, hmac('key-secret', body))).toBe(false));
  test('upper-case hex is not accepted (exact match only)', () => expect(rz.verifyWebhookSignature(body, hmac('wh-secret', body).toUpperCase())).toBe(false));
  test.each([[undefined], [null], [''], [123], [['a']], [{}], ['short'], ['x'.repeat(10000)]])('a signature of %p is false and never throws', (sig) => {
    expect(rz.verifyWebhookSignature(body, sig)).toBe(false);
  });
  test('with no webhook secret configured it cannot be satisfied (it throws, which the handler turns into a 500)', () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect(() => rz.verifyWebhookSignature(body, 'a'.repeat(64))).toThrow();
  });
});

describe('verifyPaymentSignature', () => {
  test('order|payment signed with the key secret passes', () => expect(rz.verifyPaymentSignature('order_1', 'pay_1', hmac('key-secret', 'order_1|pay_1'))).toBe(true));
  test('swapping the payment or the order fails', () => {
    const sig = hmac('key-secret', 'order_1|pay_1');
    expect(rz.verifyPaymentSignature('order_1', 'pay_2', sig)).toBe(false);
    expect(rz.verifyPaymentSignature('order_2', 'pay_1', sig)).toBe(false);
    expect(rz.verifyPaymentSignature('pay_1', 'order_1', sig)).toBe(false);
  });
  test('the webhook secret does not sign a checkout', () => expect(rz.verifyPaymentSignature('order_1', 'pay_1', hmac('wh-secret', 'order_1|pay_1'))).toBe(false));
  test.each([[undefined], [''], [5], ['zz']])('a signature of %p is false and never throws', (sig) => expect(rz.verifyPaymentSignature('o', 'p', sig)).toBe(false));
});

describe('validateFundAccountOrWarn', () => {
  const stub = (post, get) => { rz.razorpay.api = { rq: { post: jest.fn(post), get: jest.fn(get || (async () => ({ data: {} }))) } }; };

  test('in test mode the check is skipped entirely', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    stub(async () => { throw new Error('should not be called'); });
    await expect(rz.validateFundAccountOrWarn('fa_1', 'seller')).resolves.toBeUndefined();
    expect(rz.razorpay.api.rq.post).not.toHaveBeenCalled();
  });
  test('an account the bank reports inactive refuses the payout', async () => {
    stub(async () => ({ data: { id: 'v1', status: 'completed', results: { account_status: 'inactive' } } }));
    await expect(rz.validateFundAccountOrWarn('fa_1', 'seller')).rejects.toThrow(/inactive/);
  });
  test('an active account passes', async () => {
    stub(async () => ({ data: { id: 'v1', status: 'completed', results: { account_status: 'active' } } }));
    await expect(rz.validateFundAccountOrWarn('fa_1', 'partner')).resolves.toBeUndefined();
  });
  test('the check being unavailable does not block a payout (soft fail)', async () => {
    stub(async () => { throw Object.assign(new Error('x'), { response: { status: 400, data: { error: { description: 'not enabled' } } } }); });
    await expect(rz.validateFundAccountOrWarn('fa_1', 'seller')).resolves.toBeUndefined();
  });
  test('the check not finishing in time does not block a payout', async () => {
    jest.useFakeTimers();
    stub(async () => ({ data: { id: 'v1', status: 'created' } }), async () => ({ data: { id: 'v1', status: 'created' } }));
    const p = rz.validateFundAccountOrWarn('fa_1', 'seller');
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    jest.useRealTimers();
  });
});
