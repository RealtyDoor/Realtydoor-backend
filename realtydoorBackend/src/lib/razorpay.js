const Razorpay = require('razorpay');
const crypto = require('crypto');
const logger = require('./logger');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// razorpay@2.9.x has no `contacts`, `payouts`, or fund-account-validation
// resource wrappers, and its own `api.post()` helper doesn't forward custom
// headers (needed below for the payout idempotency header) — so these go
// straight through the underlying axios instance the SDK already configures
// with the right baseURL and basic-auth credentials, mirroring the error
// shape (`{statusCode, error}`) the SDK's own resources throw.
function normalizeRawApiError(err) {
  if (err.response) throw { statusCode: err.response.status, error: err.response.data.error };
  throw err;
}

async function rawPost(url, data, headers) {
  try {
    const res = await razorpay.api.rq.post(url, data, headers ? { headers } : undefined);
    return res.data;
  } catch (err) {
    normalizeRawApiError(err);
  }
}

async function rawGet(url) {
  try {
    const res = await razorpay.api.rq.get(url);
    return res.data;
  } catch (err) {
    normalizeRawApiError(err);
  }
}

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

// RazorpayX Payouts — escrow release pays the seller's bank account directly
// from the RAZORPAYX_ACCOUNT_NUMBER current account (IFSC + account number),
// so sellers never need to be onboarded as a Razorpay Route linked account.
async function createPayoutContact(name, email, phone) {
  return rawPost('/v1/contacts', { name, email, contact: phone, type: 'vendor' });
}

async function createPayoutFundAccount(contactId, name, ifsc, accountNumber) {
  return razorpay.fundAccount.create({
    contact_id: contactId,
    account_type: 'bank_account',
    bank_account: { name, ifsc, account_number: accountNumber },
  });
}

// referenceId is just a human-readable label RazorpayX stores on the payout —
// it is NOT an idempotency mechanism (confirmed against current Razorpay
// docs). Real idempotency requires the `X-Payout-Idempotency` header
// (mandatory on every payout since March 2025): a retried request with the
// same header value returns the original payout's state instead of paying
// out twice. The key is derived deterministically from referenceId so a
// retried release() call for the same escrow/leg reuses the same key.
async function createPayout(fundAccountId, amountInPaise, referenceId) {
  const idempotencyKey = crypto.createHash('sha256').update(referenceId).digest('hex');
  return rawPost('/v1/payouts', {
    account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
    fund_account_id: fundAccountId,
    amount: amountInPaise,
    currency: 'INR',
    mode: 'NEFT',
    purpose: 'payout',
    reference_id: referenceId,
  }, { 'X-Payout-Idempotency': idempotencyKey });
}

const FUND_ACCOUNT_VALIDATION_POLL_ATTEMPTS = 3;
const FUND_ACCOUNT_VALIDATION_POLL_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Penny-drop check before sending real money to a bank account for the first
// time (e.g. a typo'd-but-valid account number belonging to someone else).
// Account Validation is unavailable in Razorpay test mode and is itself
// async, so this is deliberately soft-fail: anything that isn't a definite
// "this account is inactive" (an unsupported/test-mode error, or the
// validation not completing within a few seconds) is logged and the payout
// proceeds anyway, rather than blocking release on a check that can't always
// run. label is 'seller' or 'partner', used only for logging.
async function validateFundAccountOrWarn(fundAccountId, label) {
  if (process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) return;

  let validation;
  try {
    validation = await rawPost('/v1/fund_accounts/validations', {
      account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
      fund_account: { id: fundAccountId },
      amount: 100,
      currency: 'INR',
    });
  } catch (err) {
    logger.warn('[RazorpayX] Fund account validation unavailable — proceeding without it', {
      fundAccountId, label, error: err?.error?.description || err.message,
    });
    return;
  }

  for (let attempt = 0; attempt < FUND_ACCOUNT_VALIDATION_POLL_ATTEMPTS && validation.status === 'created'; attempt++) {
    await sleep(FUND_ACCOUNT_VALIDATION_POLL_DELAY_MS);
    try {
      validation = await rawGet(`/v1/fund_accounts/validations/${validation.id}`);
    } catch (err) {
      break;
    }
  }

  if (validation.status === 'completed' && validation.results?.account_status === 'inactive') {
    throw new Error(`Fund account validation flagged the ${label}'s account as inactive — refusing to pay out`);
  }
  if (validation.status !== 'completed') {
    logger.warn('[RazorpayX] Fund account validation did not complete in time — proceeding without confirmation', {
      fundAccountId, label, status: validation.status,
    });
  }
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
  createPayoutContact,
  createPayoutFundAccount,
  createPayout,
  validateFundAccountOrWarn,
  refundPayment,
  verifyWebhookSignature,
  verifyPaymentSignature,
};
