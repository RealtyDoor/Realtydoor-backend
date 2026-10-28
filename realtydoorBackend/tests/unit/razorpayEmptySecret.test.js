// Security pass 28 Oct 2026: a webhook or payment secret that is empty or unset must never "verify" anything. HMAC with an empty key is
// computable by anyone, so an empty RAZORPAY_WEBHOOK_SECRET would have let a forged webhook through.
const crypto = require('crypto');
const { verifyWebhookSignature, verifyPaymentSignature } = require('../../src/lib/razorpay');

const sign = (key, body) => crypto.createHmac('sha256', key).update(body).digest('hex');
const saved = { w: process.env.RAZORPAY_WEBHOOK_SECRET, k: process.env.RAZORPAY_KEY_SECRET };
afterEach(() => { process.env.RAZORPAY_WEBHOOK_SECRET = saved.w; process.env.RAZORPAY_KEY_SECRET = saved.k; });

test('an empty webhook secret rejects a signature made with an empty key', () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = '';
  expect(verifyWebhookSignature('{"event":"payment.captured"}', sign('', '{"event":"payment.captured"}'))).toBe(false);
});

test('an unset webhook secret rejects instead of throwing', () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  expect(verifyWebhookSignature('{}', 'abc')).toBe(false);
});

test('an empty payment secret rejects a forged payment signature', () => {
  process.env.RAZORPAY_KEY_SECRET = '';
  expect(verifyPaymentSignature('order_1', 'pay_1', sign('', 'order_1|pay_1'))).toBe(false);
});

test('a real secret still verifies the right signature and refuses a wrong one', () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = 'a-long-random-test-secret';
  const body = '{"event":"payment.captured"}';
  expect(verifyWebhookSignature(body, sign('a-long-random-test-secret', body))).toBe(true);
  expect(verifyWebhookSignature(body, sign('another-secret', body))).toBe(false);
});
