const { verifyPaymentSchema } = require('../../src/lib/paymentSchemas');
const { overrideOtpSchema, suspendUserSchema } = require('../../src/modules/admin/admin.validator');
const { collectCommissionSchema } = require('../../src/modules/commission/commission.validator');
const { assertTdsWithinInvoice } = require('../../src/modules/commission/commission.service');

const goodVerify = { razorpayOrderId: 'order_Abc123', razorpayPaymentId: 'pay_Xyz789', razorpaySignature: 'a1b2c3d4e5f6' };

describe('verifyPaymentSchema (Razorpay checkout result)', () => {
  test('accepts the real shape', () => { expect(verifyPaymentSchema.parse(goodVerify)).toEqual(goodVerify); });

  test.each([
    ['an object instead of text', { ...goodVerify, razorpayOrderId: { $ne: null } }],
    ['an array', { ...goodVerify, razorpayPaymentId: ['pay_1', 'pay_2'] }],
    ['a number', { ...goodVerify, razorpayOrderId: 12345 }],
    ['a missing field', { razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1' }],
    ['an empty string', { ...goodVerify, razorpaySignature: '' }],
    ['a huge string', { ...goodVerify, razorpaySignature: 'a'.repeat(5000) }],
    ['odd characters in an id', { ...goodVerify, razorpayOrderId: 'order_1; DROP' }],
    ['a non-hex signature', { ...goodVerify, razorpaySignature: 'not-hex!' }],
    ['null', null],
    ['undefined', undefined],
    ['a plain string', 'hello'],
  ])('rejects %s', (_n, body) => { expect(() => verifyPaymentSchema.parse(body)).toThrow(); });
});

describe('admin body validators', () => {
  test('OTP override: the note is optional text of a sane length, and the body may be empty', () => {
    expect(overrideOtpSchema.parse(undefined)).toEqual({});
    expect(overrideOtpSchema.parse({})).toEqual({});
    expect(overrideOtpSchema.parse({ note: '  buyer called  ' })).toEqual({ note: 'buyer called' });
    expect(() => overrideOtpSchema.parse({ note: 'x'.repeat(501) })).toThrow();
    expect(() => overrideOtpSchema.parse({ note: { a: 1 } })).toThrow();
  });

  test('suspend user: a real boolean is required, the reason is bounded text', () => {
    expect(suspendUserSchema.parse({ suspend: true, reason: ' spam ' })).toEqual({ suspend: true, reason: 'spam' });
    expect(suspendUserSchema.parse({ suspend: false })).toEqual({ suspend: false });
    for (const bad of [{ suspend: 'true' }, { suspend: 1 }, {}, { suspend: true, reason: 'x'.repeat(501) }, { suspend: true, reason: ['a'] }]) {
      expect(() => suspendUserSchema.parse(bad)).toThrow();
    }
  });
});

describe('collecting a seller fee: the TDS the seller held back', () => {
  test('defaults to zero and accepts a normal amount, including one sent as text', () => {
    expect(collectCommissionSchema.parse(undefined)).toEqual({ tdsDeductedRupees: 0 });
    expect(collectCommissionSchema.parse({})).toEqual({ tdsDeductedRupees: 0 });
    expect(collectCommissionSchema.parse({ tdsDeductedRupees: 1500.5 }).tdsDeductedRupees).toBe(1500.5);
    expect(collectCommissionSchema.parse({ tdsDeductedRupees: '2000' }).tdsDeductedRupees).toBe(2000);
  });

  test.each([-1, -0.01, 'abc', Infinity, NaN, 1e12])('rejects %p', (bad) => {
    expect(() => collectCommissionSchema.parse({ tdsDeductedRupees: bad })).toThrow();
  });

  test('the TDS can never exceed the invoice it came out of', () => {
    expect(() => assertTdsWithinInvoice(0, 1000000)).not.toThrow();
    expect(() => assertTdsWithinInvoice(10000, 1000000)).not.toThrow(); // exactly the total
    expect(() => assertTdsWithinInvoice(10000.01, 1000000)).toThrow(/more than the invoice/);
    expect(() => assertTdsWithinInvoice(-1, 1000000)).toThrow(/negative/);
    expect(() => assertTdsWithinInvoice(undefined, 1000000)).not.toThrow();
  });
});
