const { createClerkClient } = require('@clerk/clerk-sdk-node');
const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const otpAuth = require('../../lib/otpAuth');
const { setUserRole, syncUserFields } = require('../../lib/clerkAdmin');

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

  let signInToken;
  try {
    signInToken = await createSignInToken(clerkUser.id);
  } catch (err) {
    logger.error('[createAccount] Sign-in token creation failed', { clerkId: clerkUser.id, error: err.message });
    throw new ApiError(500, 'Account created but sign-in failed. Please log in from the sign-in screen.');
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
  const payload = await clerk.verifyToken(token);
  const clerkId = payload.sub;

  const clerkUser = await clerk.users.getUser(clerkId);

  const email = clerkUser.emailAddresses?.[0]?.emailAddress;
  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email;
  const phone = clerkUser.phoneNumbers?.[0]?.phoneNumber || null;
  const phoneVerifiedInClerk = clerkUser.phoneNumbers?.[0]?.verification?.status === 'verified';
  const profileImageUrl = clerkUser.imageUrl || null;
  const clerkRole = clerkUser.publicMetadata?.role;

  if (!email) {
    throw new ApiError(400, 'An email address is required to complete signup.', { code: 'EMAIL_REQUIRED' });
  }

  let existing = await prisma.user.findUnique({ where: { clerkId } });
  const isNewIdentity = !existing;
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
    name,
    email,
    ...(phoneToWrite !== undefined && { phone: phoneToWrite }),
    profileImageUrl,
    role: resolvedRole,
  };

  // Trust Clerk's own phone verification (native phone_code sign-up/sign-in,
  // or a phone added+verified via Clerk's frontend SDK post-signup) the same
  // way we already trust its email verification status — but only ever
  // upgrade false→true here, never regress an already-verified phone.
  if (existing?.phoneVerified !== true && phoneVerifiedInClerk) {
    writeData.phoneVerified = true;
    writeData.phoneVerifiedAt = new Date();
  }

  if (isNewIdentity && !existing) {
    writeData.emailVerified = clerkUser.emailAddresses?.[0]?.verification?.status === 'verified';
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
      user = await prisma.user.update({ where: { id: found.id }, data: writeData });
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
  return { user, onboardingComplete: user.phoneVerified === true };
}

async function googlePhoneOtp(currentUser, { phone }) {
  if (currentUser.phoneVerified) {
    throw new ApiError(400, 'Phone already verified.');
  }
  const dup = await prisma.user.findFirst({ where: { phone, NOT: { id: currentUser.id } } });
  if (dup) throw new ApiError(409, 'This number is already linked to another account.');

  return otpAuth.createAndSendOtp({ phone, purpose: 'GOOGLE_COMPLETE' });
}

async function googlePhoneVerify(currentUser, { phone, code }) {
  await otpAuth.verifyOtp({ phone, purpose: 'GOOGLE_COMPLETE', code });

  const dup = await prisma.user.findFirst({ where: { phone, NOT: { id: currentUser.id } } });
  if (dup) throw new ApiError(409, 'This number is already linked to another account.');

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
