const rateLimit = require('express-rate-limit');

const BASE = {
  standardHeaders: true,  // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,   // Disable X-RateLimit-* headers
  skip: () => process.env.NODE_ENV === 'test',
};

// A header/polling-style endpoint the frontend hits on effectively every page
// load to render a badge count — never worth rate-limiting on its own, at
// either the IP or the per-user layer below.
const skipUnreadCount = (req) => process.env.NODE_ENV === 'test' || req.path.endsWith('/unread-count');

// IP-keyed, app-wide outer safety net (app.js mounts this on all of /api).
// Raised substantially from the old max: 100 — behind a proxy/SSR layer that
// forwards every browser's request through one outbound IP (e.g. a Next.js
// server making server-side calls to this API), every real visitor shared
// that single IP's budget, so a handful of active users could 429 each other
// on routine polling (unread-count was the one actually observed in the
// browser). Authenticated routes get the real, meaningful limit from
// perUserLimiter below instead — this is just the outer DDoS/scrape backstop.
const defaultLimiter = rateLimit({
  ...BASE,
  skip: skipUnreadCount,
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

// Keyed by the authenticated user, not the connecting IP — apply this *after*
// `authenticate` in a router (req.user must already be set). Mounted on the
// big authenticated routers (admin/users/partners/disputes/notifications)
// so many real users behind the same proxy IP each get their own budget,
// instead of all sharing defaultLimiter's one IP-keyed bucket.
const perUserLimiter = rateLimit({
  ...BASE,
  skip: skipUnreadCount,
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: (req) => req.user?.id || req.ip,
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

// Per-user guard on the Google-onboarding phone-completion endpoints. Unlike
// signup/login (public, keyed by IP is all we have), these routes run behind
// `authenticate`, so any signed-in user could otherwise target a different
// phone number on every request — bounded only by per-IP and per-phone caps,
// neither of which stops one account from working through many numbers.
// Keyed by req.user.id, so this must sit after `authenticate` in the chain.
const perUserPhoneOtpLimiter = rateLimit({
  ...BASE,
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { success: false, message: 'Too many phone-verification requests. Try again later.' },
});

// Backend gaps handoff, 2026-10-10 (#4) — withdraw and account-deletion
// requests are idempotent (re-calling just re-stamps the same state), so
// this is purely abuse/mistake protection, not a correctness requirement.
// Keyed by user, same pattern as perUserPhoneOtpLimiter.
const privacyActionLimiter = rateLimit({
  ...BASE,
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { success: false, message: 'Too many requests. Try again later.' },
});

module.exports = {
  defaultLimiter, perUserLimiter, otpLimiter, authLimiter, uploadLimiter, searchLimiter,
  otpSendLimiter, otpVerifyLimiter, perUserPhoneOtpLimiter, privacyActionLimiter,
};
