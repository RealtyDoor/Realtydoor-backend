const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

async function createOrder(amountInPaise, receipt, notes = {}) {
  return razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt,
    notes,
  });
}

async function createEscrowOrder(amountInPaise, receipt) {
  return razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt,
    notes: { type: 'escrow' },
  });
}

async function releaseEscrow(paymentId, sellerAccountId, releaseAmountInPaise) {
  return razorpay.payments.transfer(paymentId, {
    transfers: [
      {
        account: sellerAccountId,
        amount: releaseAmountInPaise,
        currency: 'INR',
        on_hold: false,
      },
    ],
  });
}

async function refundPayment(paymentId, amountInPaise) {
  return razorpay.payments.refund(paymentId, { amount: amountInPaise });
}

// Both signature checks below must NEVER throw — a missing or wrong-length
// `signature` (fully attacker/caller-controlled: a webhook header or request
// body field) previously reached crypto.timingSafeEqual with mismatched
// buffer lengths, which throws a RangeError instead of returning false. In
// the webhook controller that throw escaped as an unhandled promise
// rejection and crashed the entire process — a single unauthenticated
// request to a necessarily-public endpoint. Same guard pattern as
// otpAuth.js's codeMatches.
function verifyWebhookSignature(rawBody, signature) {
  if (typeof signature !== 'string' || !signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function verifyPaymentSignature(orderId, paymentId, signature) {
  if (typeof signature !== 'string' || !signature) return false;
  const body = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

module.exports = {
  razorpay,
  createOrder,
  createEscrowOrder,
  releaseEscrow,
  refundPayment,
  verifyWebhookSignature,
  verifyPaymentSignature,
};
