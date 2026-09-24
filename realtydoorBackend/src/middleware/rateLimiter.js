const rateLimit = require('express-rate-limit');

const BASE = {
  standardHeaders: true,  // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,   // Disable X-RateLimit-* headers
  skip: () => process.env.NODE_ENV === 'test',
};

const defaultLimiter = rateLimit({
  ...BASE,
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const otpLimiter = rateLimit({
  ...BASE,
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many OTP requests. Try again in 1 hour.' },
});

const authLimiter = rateLimit({
  ...BASE,
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many auth attempts.' },
});

const uploadLimiter = rateLimit({
  ...BASE,
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { success: false, message: 'Upload limit reached. Try again later.' },
});

// Property search runs an unindexed regex scan on `q`/`locality` — cap it
// tighter than the global default so typeahead-style hammering can't drown
// out the DB for everyone else.
const searchLimiter = rateLimit({
  ...BASE,
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many search requests, please slow down.' },
});

// Per-IP guard on the new phone-OTP auth endpoints (signup/login/Google-complete).
// The per-phone limit (resend cooldown + hourly cap) is enforced separately in
// lib/otpAuth.js against the PhoneOtp row itself — that's what actually stops
// someone spamming a stranger's WhatsApp; this just slows distributed abuse
// across many phone numbers from one IP.
const otpSendLimiter = rateLimit({
  ...BASE,
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many requests. Try again later.' },
});

const otpVerifyLimiter = rateLimit({
  ...BASE,
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many attempts. Try again later.' },
});

module.exports = {
  defaultLimiter, otpLimiter, authLimiter, uploadLimiter, searchLimiter,
  otpSendLimiter, otpVerifyLimiter,
};
