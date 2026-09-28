const { createClerkClient } = require('@clerk/clerk-sdk-node');
const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const otpAuth = require('../../lib/otpAuth');
const { setUserRole, syncUserFields } = require('../../lib/clerkAdmin');
const { computeOnboardingComplete } = require('../../lib/onboarding');

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

async function createAccount({ name, email, phone, isNRI = false, marketingOptIn = false }) {
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
      publicMetadata: { role: 'USER', phone },
    });
  } catch (err) {
    logger.error('[createAccount] Clerk user creation failed', { email, error: err.message });
    throw new ApiError(500, 'Could not create account. Please try again.');
  }

  // Trust Clerk's verification status at creation time as the initial value —
  // decided over re-deriving our own rule (open point B4/B8 flagged in the plan).
  const emailVerified = clerkUser.emailAddresses?.[0]?.verification?.status === 'verified';

  const now = new Date();
  let dbUser;
  try {
    dbUser = await prisma.user.create({
      data: {
        clerkId: clerkUser.id,
        name,
        email,
        phone,
        role: 'USER',
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
    throw err;
  }

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

async function signupOtp({ name, email, phone, isNRI, marketingOptIn }) {
  const existingDb = await prisma.user.findFirst({ where: { OR: [{ email }, { phone }] } });
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
    payload: { name, email, isNRI, marketingOptIn },
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
  });
}

async function loginOtp({ phone }) {
  const user = await prisma.user.findFirst({ where: { phone } });
  if (!user) throw new ApiError(404, 'No account found for this number', { code: 'ACCOUNT_NOT_FOUND' });
  return otpAuth.createAndSendOtp({ phone, purpose: 'LOGIN' });
}

async function loginVerify({ phone, code }) {
  await otpAuth.verifyOtp({ phone, purpose: 'LOGIN', code });

  const user = await prisma.user.findFirst({ where: { phone } });
  if (!user) throw new ApiError(400, 'Invalid or expired code.', { code: 'OTP_INVALID' });

  if (user.isSuspended) {
    throw new ApiError(403, 'Your account has been suspended. Contact support@realtydoor.in');
  }
  if (user.role !== 'USER') {
    throw new ApiError(403, `This account is registered as ${user.role}. Please use the correct portal to sign in.`, {
      code: 'WRONG_PORTAL',
      role: user.role,
    });
  }

  const signInToken = await createSignInToken(user.clerkId);
  return { user, signInToken };
}

// ─── B5: Google flow — sync + onboarding + phone completion ──────────────────

async function syncUser(token) {
  // Only a genuine token-verification failure is a 401 — everything else
  // below (DB errors, Clerk API errors) is a real server error and should
  // surface as one, not look like an expired session to the frontend.
  let payload;
  try {
    payload = await clerk.verifyToken(token);
  } catch (err) {
    throw new ApiError(401, 'Invalid or expired session.');
  }
  const clerkId = payload.sub;

  const clerkUser = await clerk.users.getUser(clerkId);

  const email = clerkUser.emailAddresses?.[0]?.emailAddress;
  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email;
  const phone = clerkUser.phoneNumbers?.[0]?.phoneNumber || null;
  const profileImageUrl = clerkUser.imageUrl || null;
  const clerkRole = clerkUser.publicMetadata?.role;

  if (!email) {
    throw new ApiError(400, 'An email address is required to complete signup.', { code: 'EMAIL_REQUIRED' });
  }

  let existing = await prisma.user.findUnique({ where: { clerkId } });
  if (!existing && email) {
    existing = await prisma.user.findUnique({ where: { email } });
  }

  // Email already belongs to a DIFFERENT Clerk identity — collision (B5).
  if (existing && existing.clerkId !== clerkId) {
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

  if (existing?.isSuspended) {
    throw new ApiError(403, 'Your account has been suspended. Contact support@realtydoor.in');
  }

  const resolvedRole = clerkRole || existing?.role || 'USER';
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
  if (!existing) {
    writeData.name = name;
    writeData.profileImageUrl = profileImageUrl;
    writeData.emailVerified = clerkUser.emailAddresses?.[0]?.verification?.status === 'verified';
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
    if (err.code === 'P2002') {
      const found = await prisma.user.findFirst({ where: { OR: [{ clerkId }, { email }] } });
      if (!found) throw err;
      // The row already exists (a concurrent sync created it) — never stomp
      // its name/photo/emailVerified here, same rule as the normal update path.
      const { name: _n, profileImageUrl: _p, emailVerified: _e, ...raceData } = writeData;
      user = await prisma.user.update({ where: { id: found.id }, data: raceData });
    } else {
      throw err;
    }
  }

  if (!clerkRole) {
    await setUserRole(clerkId, resolvedRole).catch((err) =>
      logger.warn('[authSync] setUserRole failed', { clerkId, error: err.message })
    );
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

  await syncUserFields(currentUser.id, { phone });
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
  googlePhoneOtp,
  googlePhoneVerify,
};
