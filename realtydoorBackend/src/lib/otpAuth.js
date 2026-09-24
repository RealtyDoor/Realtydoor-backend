const crypto = require('crypto');
const prisma = require('./prisma');
const ApiError = require('../utils/ApiError');
const { sendPhoneVerificationOtp } = require('./wati');
const logger = require('./logger');

// Dedicated to the PhoneOtp table (signup / login / Google-onboarding / lazy
// profile verification). Deliberately separate from lib/otp.js, which backs
// the unrelated site-visit anti-leakage OTP on Lead — do not merge the two.

const EXPIRY_MS           = 10 * 60 * 1000;      // 10 minutes
const MAX_ATTEMPTS        = 3;
const LOCK_MS             = 30 * 60 * 1000;      // 30 minutes
const RESEND_COOLDOWN_MS  = 30 * 1000;           // 30 seconds
const MAX_SENDS_PER_HOUR  = 3;
const SEND_WINDOW_MS      = 60 * 60 * 1000;      // 1 hour

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

  if (!codeMatches(code, row.codeHash)) {
    const attempts = row.attempts + 1;
    const locked = attempts >= MAX_ATTEMPTS;
    await prisma.phoneOtp.update({
      where: { id: row.id },
      data: { attempts, lockedUntil: locked ? new Date(now.getTime() + LOCK_MS) : null },
    });
    throw genericError();
  }

  await prisma.phoneOtp.delete({ where: { id: row.id } });
  return { payload: row.payload };
}

module.exports = { createAndSendOtp, verifyOtp, generateCode, hashCode, codeMatches };
