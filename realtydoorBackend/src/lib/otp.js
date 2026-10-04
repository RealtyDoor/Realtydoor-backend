const crypto = require('crypto');

const EXPIRY_MS = Number(process.env.OTP_EXPIRY_MINUTES || 120) * 60 * 1000;
const MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 3);

// 6 digits, matching the phone-auth OTP in lib/otpAuth.js and every frontend
// screen (partner OTP entry, user visit-OTP page, schedule preview).
// randomInt's upper bound is exclusive, so 100000–999999 inclusive — the old
// 4-digit version used randomInt(1000, 9999), which could never produce 9999
// and had a redundant padStart since the range already guaranteed 4 digits.
function generate() {
  return String(crypto.randomInt(100000, 1000000));
}

function expiresAt() {
  return new Date(Date.now() + EXPIRY_MS);
}

function isExpired(otpExpiresAt) {
  return !otpExpiresAt || new Date() > new Date(otpExpiresAt);
}

function isLocked(otpLockedUntil) {
  return otpLockedUntil && new Date() < new Date(otpLockedUntil);
}

function lockUntil() {
  return new Date(Date.now() + 30 * 60 * 1000); // 30-min lock
}

function maxAttemptsReached(attempts) {
  return attempts >= MAX_ATTEMPTS;
}

module.exports = { generate, expiresAt, isExpired, isLocked, lockUntil, maxAttemptsReached, MAX_ATTEMPTS };
