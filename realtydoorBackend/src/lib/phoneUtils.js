'use strict';

/**
 * Anti-leakage rule: PARTNER can never see buyer's full phone until OTP is verified.
 * Rule 1 from PRD §5.
 */
function maskPhone(phone) {
  if (!phone || phone.length < 6) return phone;
  return phone.slice(0, 6) + 'XXXXX';
}

function formatPhone(phone, isOtpVerified) {
  return isOtpVerified ? phone : maskPhone(phone);
}

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Normalizes common Indian mobile number input shapes to E.164 (+91XXXXXXXXXX).
 * Returns null if the input can't be resolved to a valid 10-digit Indian mobile number.
 */
function normalizeIndianPhone(input) {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 13 && digits.startsWith('091')) digits = digits.slice(3);

  return INDIAN_MOBILE.test(digits) ? `+91${digits}` : null;
}

module.exports = { maskPhone, formatPhone, normalizeIndianPhone };
