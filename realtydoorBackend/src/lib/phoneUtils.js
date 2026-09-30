'use strict';

const { z } = require('zod');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

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

/**
 * Normalizes any phone number input to E.164. A number with a leading "+"
 * (or "00" IDD prefix, converted to "+") is parsed as full international
 * input against whatever country it declares. Anything else — a bare
 * national number with no country info, e.g. "9000000099" or "09000000099"
 * — is assumed Indian, since that's still virtually every signup; an NRI
 * or anyone dialing in from abroad types their own country code, which
 * takes the international branch instead. Returns null if the input can't
 * be resolved to a valid number either way.
 */
function normalizePhone(input) {
  if (!input) return null;
  let raw = String(input).trim();
  if (raw.startsWith('00')) raw = '+' + raw.slice(2);

  const defaultCountry = raw.startsWith('+') ? undefined : 'IN';
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  return parsed && parsed.isValid() ? parsed.number : null;
}

// Shared by every endpoint that accepts a phone number for OTP send/verify
// (auth.validator.js and users.validator.js) so "+1 415-555-2671", "090000...",
// and "9000000099" are all accepted the same way everywhere, and all end up
// normalized to the same E.164 string before touching the DB or PhoneOtp table.
const phoneField = z.string().transform((val, ctx) => {
  const normalized = normalizePhone(val);
  if (!normalized) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a valid phone number' });
    return z.NEVER;
  }
  return normalized;
});

// Backed by a partial unique index on User.phone (scripts/createPhoneUniqueIndex.js,
// name: phone_unique_partial — not expressible as a native Prisma @unique on
// Mongo since a plain unique index would reject a second null phone). Every
// call site that writes phone after its own findFirst-based duplicate check
// still has a TOCTOU race window; this lets each one catch the DB-level
// backstop and turn it into the same clean 409 PHONE_IN_USE the check itself
// throws, instead of a raw unhandled P2002.
function isPhoneUniqueViolation(err) {
  return err?.code === 'P2002' && err?.meta?.target === 'phone_unique_partial';
}

module.exports = { maskPhone, formatPhone, normalizePhone, phoneField, isPhoneUniqueViolation };
