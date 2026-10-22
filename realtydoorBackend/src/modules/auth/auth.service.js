const { createClerkClient } = require('@clerk/clerk-sdk-node');
const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const { SUSPENDED_MESSAGE } = require('../../lib/supportContact');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const otpAuth = require('../../lib/otpAuth');
const { setUserRole, syncUserFields } = require('../../lib/clerkAdmin');
const { computeOnboardingComplete } = require('../../lib/onboarding');
const { isPhoneUniqueViolation } = require('../../lib/phoneUtils');
const { nextRefCode } = require('../../lib/refCode');
const { sendWelcomeEmail } = require('../../lib/email');
const { getAllowedOrigins } = require('../../lib/allowedOrigins');
const { anonymizeUser, hasMoneyInFlight } = require('../../lib/accountDeletion');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const SIGN_IN_TOKEN_TTL_SECONDS = 60;
const RECENT_CLERK_USER_MS = 5 * 60 * 1000; // only auto-delete Clerk users created moments ago

function randomAlphaNumeric(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function generateUsername() {
  return `user_${randomAlphaNumeric(10)}`;
}

function generateStrongPassword() {
  const upper = randomAlphaNumeric(6).toUpperCase();
  const lower = randomAlphaNumeric(6).toLowerCase();
  const digits = String(crypto.randomInt(100000, 1000000));
  const symbol = '!@#$%^&*'[crypto.randomInt(0, 8)];
  return `${upper}${lower}${digits}${symbol}`;
}

async function createSignInToken(clerkId) {
  const token = await clerk.signInTokens.createSignInToken({
    userId: clerkId,
    expiresInSeconds: SIGN_IN_TOKEN_TTL_SECONDS,
  });
  return token.token;
}

// ─── B4: account creation (Clerk + DB, one function, all-or-nothing) ─────────

async function createAccount({ name, email, phone, isNRI = false, marketingOptIn = false, role = 'USER' }) {
  const [firstName, ...rest] = name.trim().split(/\s+/);
  const lastName = rest.join(' ') || undefined;

  let clerkUser;
  try {
    clerkUser = await clerk.users.createUser({
      emailAddress: [email],
      username: generateUsername(),
      password: generateStrongPassword(),
      firstName,
      lastName,
      publicMetadata: { role, phone },
    });
  } catch (err) {
    logger.error('[createAccount] Clerk user creation failed', { email, error: err.message });
    throw new ApiError(500, 'Could not create account. Please try again.');
  }

  // Trust Clerk's verification status at creation time as the initial value —
  // decided over re-deriving our own rule (open point B4/B8 flagged in the plan).
  const emailVerified = clerkUser.emailAddresses?.[0]?.verification?.status === 'verified';

  const now = new Date();
  const refCode = await nextRefCode('user');
  let dbUser;
  try {
    dbUser = await prisma.user.create({
      data: {
        clerkId: clerkUser.id,
        refCode,
        name,
        email,
        phone,
        role,
        phoneVerified: true,
        phoneVerifiedAt: now,
        emailVerified,
        isNRI,
        // Submitting the signup form is the agreement action (see the signup
        // screen's "By continuing you agree to..." line) — record it here
        // rather than requiring a separate authenticated consent call.
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
        marketingOptIn,
        ...(marketingOptIn && { marketingOptInAt: now }),
      },
    });
  } catch (err) {
    await clerk.users.deleteUser(clerkUser.id).catch((delErr) => {
      logger.error('[createAccount] Rollback failed — orphaned Clerk user', {
        clerkId: clerkUser.id, error: delErr.message,
      });
    });
    // signupOtp already checked for a duplicate phone before sending the
    // OTP, but two signups for the same number can both pass that check
    // before either writes — the DB-level partial unique index is the real
    // backstop for that race; surface it the same way the pre-check does.
    if (isPhoneUniqueViolation(err)) {
      throw new ApiError(409, 'An account with this email or phone already exists.', { code: 'ALREADY_REGISTERED' });
    }
    throw err;
  }

  // Fire-and-forget, same as every other notification send in this codebase
  // — a flaky email send must never fail or delay account creation itself.
  sendWelcomeEmail(dbUser.email, dbUser.name, dbUser.role, dbUser).catch(() => {});

  // The account (Clerk user + DB row) already exists by this point — a failure
  // here doesn't leave a broken account (the user can still log in normally
  // afterward via /login/otp), but it is a bad first-run experience, and this
  // step is the one most likely to hit a transient network blip right after
  // the createUser call above. One immediate retry meaningfully cuts how often
  // a real user actually hits the fallback message below.
  let signInToken;
  try {
    signInToken = await createSignInToken(clerkUser.id);
  } catch (firstErr) {
    logger.warn('[createAccount] Sign-in token creation failed, retrying once', { clerkId: clerkUser.id, error: firstErr.message });
    try {
      signInToken = await createSignInToken(clerkUser.id);
    } catch (err) {
      logger.error('[createAccount] Sign-in token creation failed after retry', { clerkId: clerkUser.id, error: err.message });
      throw new ApiError(500, 'Account created but sign-in failed. Please log in from the sign-in screen.');
    }
  }

  return { user: dbUser, signInToken };
}

// ─── B3: signup / login by phone OTP ──────────────────────────────────────────

async function signupOtp({ name, email, phone, isNRI, marketingOptIn, role }) {
  // Scoped to active rows only — a soft-deleted account's old email/phone
  // must not permanently block that same person from signing up again.
  const existingDb = await prisma.user.findFirst({ where: { OR: [{ email }, { phone }], deletedAt: { isSet: false } } });
  if (existingDb) {
    throw new ApiError(409, 'An account with this email or phone already exists.', { code: 'ALREADY_REGISTERED' });
  }

  const clerkMatches = await clerk.users.getUserList({ emailAddress: [email] });
  if (clerkMatches.length > 0) {
    throw new ApiError(409, 'An account with this email already exists.', { code: 'ALREADY_REGISTERED' });
  }

  return otpAuth.createAndSendOtp({
    phone,
    purpose: 'SIGNUP',
    payload: { name, email, isNRI, marketingOptIn, role },
  });
}

async function signupVerify({ phone, code }) {
  const { payload } = await otpAuth.verifyOtp({ phone, purpose: 'SIGNUP', code });
  if (!payload?.name || !payload?.email) {
    throw new ApiError(400, 'Signup session expired. Please start again.', { code: 'OTP_INVALID' });
  }
  return createAccount({
    name: payload.name,
    email: payload.email,
    phone,
    isNRI: !!payload.isNRI,
    marketingOptIn: !!payload.marketingOptIn,
    // Old OTP payloads from before this field existed have no `role` at
    // all — default to 'USER' so an in-flight signup from just before a
    // deploy doesn't fail rather than silently becoming a partner.
    role: payload.role === 'PARTNER' ? 'PARTNER' : 'USER',
  });
}

async function loginOtp({ phone }) {
  // Same deletedAt scoping as loginVerify — without it, a soft-deleted
  // user's number still triggered a real WhatsApp OTP send that could never
  // actually be used (loginVerify rejects the account either way), wasting
  // the message and surfacing a confusing "invalid code" error instead of
  // a clean "no account" one.
  const user = await prisma.user.findFirst({ where: { phone, deletedAt: { isSet: false } } });
  if (!user) throw new ApiError(404, 'No account found for this number', { code: 'ACCOUNT_NOT_FOUND' });
  return otpAuth.createAndSendOtp({ phone, purpose: 'LOGIN' });
}

async function loginVerify({ phone, code }) {
  await otpAuth.verifyOtp({ phone, purpose: 'LOGIN', code });

  // deletedAt: null as a Prisma/Mongo filter matches only an *explicit* null —
  // every pre-existing row has the field missing entirely (added after they
  // were created), which that filter does NOT match, so it would have 400'd
  // every real user's login. isSet: false matches "missing OR never deleted".
  const user = await prisma.user.findFirst({ where: { phone, deletedAt: { isSet: false } } });
  if (!user) throw new ApiError(400, 'Invalid or expired code.', { code: 'OTP_INVALID' });

  if (user.isSuspended) {
    throw new ApiError(403, SUSPENDED_MESSAGE);
  }
  // USER and PARTNER both sign in through this phone flow — a USER who later
  // upgrades to PARTNER (POST /auth/set-role, or direct partner signup below)
  // otherwise lost phone sign-in entirely and had to use Google only. ADMIN
  // stays blocked here deliberately — no phone-login path for that role.
  if (user.role === 'ADMIN') {
    throw new ApiError(403, `This account is registered as ${user.role}. Please use the correct portal to sign in.`, {
      code: 'WRONG_PORTAL',
      role: user.role,
    });
  }

  const signInToken = await createSignInToken(user.clerkId);
  return { user, signInToken };
}

// ─── B5: Google flow — sync + onboarding + phone completion ──────────────────

// Thin wrapper for POST /auth/sync, which only has a raw token. authenticate
// (middleware/auth.js) already has a verified payload/clerkId by the time it
// needs this on its missing-row path, so it calls syncUserByClerkId directly
// instead — avoiding a second, redundant clerk.verifyToken call for every
// first-request-after-signup. This function holds no logic of its own beyond
// that verify-then-fetch step, specifically so there is only ever one copy
// of the actual sync logic (in syncUserByClerkId) for the two callers to
// drift apart from.
async function syncUser(token) {
  // Only a genuine token-verification failure is a 401 — everything else
  // below (DB errors, Clerk API errors) is a real server error and should
  // surface as one, not look like an expired session to the frontend.
  let payload;
  try {
    // Security fix, 2026-10-13 (B5) — same authorizedParties check as
    // middleware/auth.js's own verifyToken call.
    payload = await clerk.verifyToken(token, { authorizedParties: getAllowedOrigins() });
  } catch (err) {
    throw new ApiError(401, 'Invalid or expired session.');
  }
  const clerkId = payload.sub;
  const clerkUser = await clerk.users.getUser(clerkId);
  return syncUserByClerkId(clerkId, clerkUser);
}

async function syncUserByClerkId(clerkId, clerkUser) {
  // Same case-normalization as auth.validator.js's emailField, and for the
  // same reason — Clerk returns whatever case the Google account/email
  // happened to be in, and this is a separate entry point into User.email
  // that never passes through that schema.
  const email = clerkUser.emailAddresses?.[0]?.emailAddress?.toLowerCase().trim();
  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email;
  const phone = clerkUser.phoneNumbers?.[0]?.phoneNumber || null;
  const profileImageUrl = clerkUser.imageUrl || null;
  const clerkRole = clerkUser.publicMetadata?.role;

  if (!email) {
    throw new ApiError(400, 'An email address is required to complete signup.', { code: 'EMAIL_REQUIRED' });
  }

  let existing = await prisma.user.findUnique({ where: { clerkId } });
  if (!existing && email) {
    // email is no longer @unique (see user.prisma) — findFirst, not
    // findUnique. Scoped to active rows only: a soft-deleted account's old
    // email must never block a brand-new Google sign-in with that address.
    existing = await prisma.user.findFirst({ where: { email, deletedAt: { isSet: false } } });
  }

  // Email already belongs to a DIFFERENT Clerk identity — collision (B5).
  if (existing && existing.clerkId !== clerkId) {
    // Security fix, 2026-10-13 (B4) — email squatting. /auth/signup/otp
    // never verifies the signer owns the email they typed (only the phone,
    // via OTP), so anyone can "claim" another person's email that way. When
    // that squatter's email was never actually verified and this NEW
    // identity's email IS Clerk-verified (a real Google account — Clerk
    // always verifies those), trust the newcomer over the squatter: free up
    // the email (same anonymize-in-place mechanism as a self-requested
    // account deletion) and fall through to create a fresh row below,
    // instead of permanently locking the real owner out with EXISTING_USER.
    // Skipped when the squatter has money in flight (escrow/loan) — wiping
    // their bank/billing fields mid-transaction would be worse than the
    // lockout this is meant to fix; that case still gets the 409 below.
    const newcomerVerified = clerkUser.emailAddresses?.[0]?.verification?.status === 'verified';
    if (!existing.emailVerified && newcomerVerified && !(await hasMoneyInFlight(existing.id))) {
      await anonymizeUser(existing.id);
      logger.warn('[authSync] reclaimed squatted, never-verified email for a verified sign-in', {
        email, reclaimedUserId: existing.id, clerkId,
      });
      existing = null;
    } else {
      const createdRecently = Date.now() - clerkUser.createdAt < RECENT_CLERK_USER_MS;
      if (createdRecently) {
        await clerk.users.deleteUser(clerkId).catch((err) =>
          logger.warn('[authSync] cleanup of duplicate Clerk identity failed', { clerkId, error: err.message })
        );
      }
      throw new ApiError(409, 'An account with this email already exists. Please sign in with your original method.', {
        code: 'EXISTING_USER',
      });
    }
  }

  if (existing?.isSuspended) {
    throw new ApiError(403, SUSPENDED_MESSAGE);
  }

  // DB is the sole authority on role once a row exists — Clerk's
  // publicMetadata.role only ever seeds a brand-new row. Previously this was
  // `clerkRole || existing?.role`, which let anything that could set Clerk
  // metadata (dashboard edit, a compromised API key, a bug) silently
  // override an admin-set DB role on every resync — directly contradicting
  // middleware/auth.js's "trust the DB, never the token" rule.
  const resolvedRole = existing?.role || clerkRole || 'USER';
  const phoneToWrite = phone || undefined;

  // Guard against two different accounts ending up with the same phone (e.g.
  // someone changes their phone in Clerk to a number another user already owns).
  if (phoneToWrite !== undefined && phoneToWrite !== existing?.phone) {
    const phoneOwner = await prisma.user.findFirst({ where: { phone: phoneToWrite, NOT: { clerkId } } });
    if (phoneOwner) {
      throw new ApiError(409, 'This phone number is already linked to another account.', { code: 'PHONE_IN_USE' });
    }
  }

  const writeData = {
    clerkId,
    email,
    ...(phoneToWrite !== undefined && { phone: phoneToWrite }),
    role: resolvedRole,
  };

  // name/profileImageUrl are only seeded from Clerk when the row is first
  // created — after that, profile edits (PATCH /user/profile) own them, so
  // a sync must never revert a user's edited name back to their Google name.
  let isNewUser = !existing;
  if (!existing) {
    writeData.name = name;
    writeData.profileImageUrl = profileImageUrl;
    writeData.emailVerified = clerkUser.emailAddresses?.[0]?.verification?.status === 'verified';
    writeData.refCode = await nextRefCode('user');
    // Phone signup stamps consent at account-creation time (completing the
    // signup form is the agreement action). Do the same here so a Google
    // user who never explicitly hits PATCH /user/consent isn't left with a
    // blank consent record — this call, completing signup, is that action.
    const now = new Date();
    writeData.termsAcceptedAt = now;
    writeData.privacyAcceptedAt = now;
  }

  let user;
  try {
    user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data: writeData })
      : await prisma.user.create({ data: writeData });
  } catch (err) {
    // The phone check above (findFirst) has the same TOCTOU race as every
    // other phone-write call site — two concurrent syncs claiming the same
    // number can both pass it before either writes. The partial unique index
    // is the real backstop; surface it as the same clean error the pre-check
    // throws, rather than a raw P2002.
    if (isPhoneUniqueViolation(err)) {
      throw new ApiError(409, 'This phone number is already linked to another account.', { code: 'PHONE_IN_USE' });
    }
    if (err.code === 'P2002') {
      const found = await prisma.user.findFirst({ where: { OR: [{ clerkId }, { email }] } });
      if (!found) throw err;
      // The row already exists (a concurrent sync created it) — never stomp
      // its name/photo/emailVerified/refCode here, same rule as the normal
      // update path (the winner of the race already got a refCode; this
      // loser must not overwrite it with a second, wasted one).
      const { name: _n, profileImageUrl: _p, emailVerified: _e, refCode: _r, ...raceData } = writeData;
      user = await prisma.user.update({ where: { id: found.id }, data: raceData });
      // The winner of the race already sent (or is sending) the welcome
      // email for this row — this losing call must not send a second one.
      isNewUser = false;
    } else {
      throw err;
    }
  }

  if (!clerkRole) {
    await setUserRole(clerkId, resolvedRole).catch((err) =>
      logger.warn('[authSync] setUserRole failed', { clerkId, error: err.message })
    );
  }

  // Google sign-in's equivalent of createAccount's welcome email — only on
  // the row's first-ever sync, never on a later login/resync.
  if (isNewUser) {
    sendWelcomeEmail(user.email, user.name, user.role, user).catch(() => {});
  }

  logger.info('[authSync] user synced', { clerkId, role: resolvedRole });
  return { user, onboardingComplete: computeOnboardingComplete(user) };
}

async function googlePhoneOtp(currentUser, { phone }) {
  if (currentUser.phoneVerified) {
    throw new ApiError(400, 'Phone already verified.', { code: 'PHONE_ALREADY_VERIFIED' });
  }
  const dup = await prisma.user.findFirst({ where: { phone, NOT: { id: currentUser.id } } });
  if (dup) throw new ApiError(409, 'This number is already linked to another account.', { code: 'PHONE_IN_USE' });

  return otpAuth.createAndSendOtp({ phone, purpose: 'GOOGLE_COMPLETE' });
}

async function googlePhoneVerify(currentUser, { phone, code }) {
  await otpAuth.verifyOtp({ phone, purpose: 'GOOGLE_COMPLETE', code });

  const dup = await prisma.user.findFirst({ where: { phone, NOT: { id: currentUser.id } } });
  if (dup) throw new ApiError(409, 'This number is already linked to another account.', { code: 'PHONE_IN_USE' });

  try {
    await syncUserFields(currentUser.id, { phone });
  } catch (err) {
    // Same TOCTOU race as the check above — someone else could have claimed
    // this number between the findFirst and this write.
    if (isPhoneUniqueViolation(err)) {
      throw new ApiError(409, 'This number is already linked to another account.', { code: 'PHONE_IN_USE' });
    }
    throw err;
  }
  const user = await prisma.user.update({
    where: { id: currentUser.id },
    data: { phoneVerified: true, phoneVerifiedAt: new Date() },
  });

  return user;
}

module.exports = {
  createAccount,
  signupOtp,
  signupVerify,
  loginOtp,
  loginVerify,
  syncUser,
  syncUserByClerkId,
  googlePhoneOtp,
  googlePhoneVerify,
};
