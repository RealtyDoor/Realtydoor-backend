const crypto = require('crypto');
const prisma = require('./prisma');
const ApiError = require('../utils/ApiError');
const { sendPhoneVerificationOtp } = require('./wati');
const logger = require('./logger');

// Dedicated to the PhoneOtp table (signup / login / Google-onboarding / lazy
// profile verification). Deliberately separate from lib/otp.js, which backs
// the unrelated site-visit anti-leakage OTP on Lead — do not merge the two.

const EXPIRY_MS           = 10 * 60 * 1000;      // 10 minutes
// Verify is public by design (anyone who has the code the owner received
// needs to be able to submit it) — which also means anyone who merely knows
// the *phone number* can deliberately submit wrong codes to lock it out from
// under its real owner. A 6-digit code has 1,000,000 possibilities, so even
// 5 attempts is a ~0.0005% brute-force success chance — negligible — while
// raising the bar from 3 to 5 wrong guesses, and cutting the lock from 30
// to 10 minutes, meaningfully reduces how disruptive that griefing is.
const MAX_ATTEMPTS        = 5;
const LOCK_MS             = 10 * 60 * 1000;      // 10 minutes, base duration
const RESEND_COOLDOWN_MS  = 30 * 1000;           // 30 seconds
const MAX_SENDS_PER_HOUR  = 3;
const SEND_WINDOW_MS      = 60 * 60 * 1000;      // 1 hour

// Security fix, 2026-10-13 (B8) — escalating lockout. A flat 10-minute lock
// resets to the same 10 minutes no matter how many times it's deliberately
// re-triggered, so griefing a number is cheap and repeatable. Each lock
// within ESCALATION_RESET_MS of the previous one triples the next lock's
// duration (10m, 30m, 90m, ...), capped at MAX_LOCK_MS — raising the cost of
// sustained harassment while a single, isolated lockout still only costs the
// base 10 minutes. The counter (PhoneOtp.lockCount) is untouched by a normal
// resend, so it only grows across repeated *lockouts*, not repeated codes.
const ESCALATION_RESET_MS = 24 * 60 * 60 * 1000; // 24 hours
const ESCALATION_FACTOR   = 3;
const MAX_LOCK_MS         = 4 * 60 * 60 * 1000;  // 4 hours

function nextLockDurationMs(row, now) {
  const withinEscalationWindow = row.lastLockedAt && now - row.lastLockedAt.getTime() < ESCALATION_RESET_MS;
  const lockCount = withinEscalationWindow ? (row.lockCount || 0) + 1 : 1;
  const lockMs = Math.min(LOCK_MS * ESCALATION_FACTOR ** (lockCount - 1), MAX_LOCK_MS);
  return { lockCount, lockMs };
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code) {
  const secret = process.env.OTP_HASH_SECRET;
  return crypto.createHmac('sha256', secret).update(code).digest('hex');
}

function codeMatches(code, hash) {
  const computed = Buffer.from(hashCode(code), 'hex');
  const stored   = Buffer.from(hash, 'hex');
  if (computed.length !== stored.length) return false;
  return crypto.timingSafeEqual(computed, stored);
}

function devExposeEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.DEV_EXPOSE_OTP === 'true';
}

// Creates (or resends into) the (phone, purpose) OTP row, enforcing the resend
// cooldown and hourly send cap, then dispatches it via WhatsApp.
async function createAndSendOtp({ phone, purpose, payload = null }) {
  const now = new Date();
  const existing = await prisma.phoneOtp.findUnique({ where: { phone_purpose: { phone, purpose } } });

  if (existing) {
    if (existing.lockedUntil && existing.lockedUntil > now) {
      throw new ApiError(429, 'Too many attempts. Try again later.', { code: 'OTP_LOCKED' });
    }
    if (now - new Date(existing.lastSentAt).getTime() < RESEND_COOLDOWN_MS) {
      throw new ApiError(429, 'Please wait before requesting another code.', { code: 'OTP_RESEND_COOLDOWN' });
    }

    const withinWindow = now - new Date(existing.lastSentAt).getTime() < SEND_WINDOW_MS;
    const nextSendCount = withinWindow ? existing.sendCount + 1 : 1;
    if (withinWindow && nextSendCount > MAX_SENDS_PER_HOUR) {
      throw new ApiError(429, 'Too many codes requested. Try again in an hour.', { code: 'OTP_SEND_LIMIT' });
    }

    const code = generateCode();
    const expiresAt = new Date(now.getTime() + EXPIRY_MS);
    await prisma.phoneOtp.update({
      where: { id: existing.id },
      data: {
        codeHash: hashCode(code),
        expiresAt,
        attempts: 0,
        lockedUntil: null,
        sendCount: nextSendCount,
        lastSentAt: now,
        payload: payload ?? existing.payload,
      },
    });
    await dispatch(phone, code);
    return { expiresAt, ...(devExposeEnabled() ? { _devOtp: code } : {}) };
  }

  const code = generateCode();
  const expiresAt = new Date(now.getTime() + EXPIRY_MS);
  await prisma.phoneOtp.create({
    data: { phone, purpose, codeHash: hashCode(code), expiresAt, sendCount: 1, lastSentAt: now, payload },
  });
  await dispatch(phone, code);
  return { expiresAt, ...(devExposeEnabled() ? { _devOtp: code } : {}) };
}

async function dispatch(phone, code) {
  try {
    await sendPhoneVerificationOtp(phone, code);
  } catch (err) {
    if (process.env.NODE_ENV === 'production') throw err;
    logger.warn(`[DEV] WATI send failed — OTP for ${phone}: ${code}`);
  }
}

// Verifies a submitted code against the (phone, purpose) row. On success,
// consumes (deletes) the row and returns its payload. Throws a single generic
// ApiError for every failure mode per B11 — callers shouldn't leak which.
async function verifyOtp({ phone, purpose, code }) {
  const now = new Date();
  const row = await prisma.phoneOtp.findUnique({ where: { phone_purpose: { phone, purpose } } });

  const genericError = () => new ApiError(400, 'Invalid or expired code.', { code: 'OTP_INVALID' });

  if (!row) throw genericError();
  if (row.lockedUntil && row.lockedUntil > now) {
    throw new ApiError(429, 'Too many attempts. Try again later.', { code: 'OTP_LOCKED' });
  }
  if (row.expiresAt <= now) throw genericError();
  // The code must be text (anything else cannot be a code, and would crash the hashing below as a 500).
  if (typeof code !== 'string') throw genericError();

  // Reserve one of the allowed attempts BEFORE looking at the code, in one atomic database step (updateMany, the same claim pattern
  // used for payments) that only succeeds while attempts are left. Counting after the check (read, compare, write) let a burst of
  // parallel guesses all read "0 attempts so far" and all be checked, so the limit of five held for one-at-a-time guesses only.
  const reserved = await prisma.phoneOtp.updateMany({
    where: { id: row.id, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (reserved.count === 0) throw new ApiError(429, 'Too many attempts. Try again later.', { code: 'OTP_LOCKED' });

  if (!codeMatches(code, row.codeHash)) {
    const after = await prisma.phoneOtp.findUnique({ where: { id: row.id } });
    if (after && after.attempts >= MAX_ATTEMPTS) {
      // Only the first request to see the limit reached sets the lock (and counts one escalation step).
      const { lockCount, lockMs } = nextLockDurationMs(after, now);
      await prisma.phoneOtp.updateMany({
        where: { id: row.id, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
        data: { lockedUntil: new Date(now.getTime() + lockMs), lockCount, lastLockedAt: now },
      });
    }
    throw genericError();
  }

  // A double-submit (double-tap, a retried request after a slow response)
  // can get two concurrent calls past the codeMatches check above on the
  // same still-valid row before either deletes it — Prisma's delete throws
  // P2025 ("record not found") for whichever one loses that race. Surfaced
  // as the same generic invalid/expired error rather than an unhandled
  // 500 — from the caller's side, "someone already consumed this code" and
  // "this code is no longer valid" are the same outcome.
  try {
    await prisma.phoneOtp.delete({ where: { id: row.id } });
  } catch (err) {
    if (err.code === 'P2025') throw genericError();
    throw err;
  }
  return { payload: row.payload };
}

module.exports = { createAndSendOtp, verifyOtp, generateCode, hashCode, codeMatches };
