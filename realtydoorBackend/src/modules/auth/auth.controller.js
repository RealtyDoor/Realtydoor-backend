const prisma = require('../../lib/prisma');
const { setUserRole } = require('../../lib/clerkAdmin');
const ApiError = require('../../utils/ApiError');
const { success, created } = require('../../utils/ApiResponse');
const logger = require('../../lib/logger');
const authService = require('./auth.service');
const {
  signupOtpSchema,
  signupVerifySchema,
  loginOtpSchema,
  loginVerifySchema,
  googlePhoneOtpSchema,
  googlePhoneVerifySchema,
} = require('./auth.validator');

// POST /api/auth/sync
// Called by the frontend after every login (phone-OTP or Google).
// Verifies the token, upserts the DB record, and reports onboarding status.
async function syncUser(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new ApiError(401, 'No token provided');

    const { user, onboardingComplete } = await authService.syncUser(token);
    success(res, { ...userProfile(user), onboardingComplete });
  } catch (err) {
    next(err instanceof ApiError ? err : new ApiError(401, 'Sync failed: ' + err.message));
  }
}

// GET /api/auth/me
async function getMe(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        subscriptions: {
          orderBy: { startDate: 'desc' },
          take: 1,
          select: { paymentStatus: true, endDate: true, service: { select: { name: true } } },
        },
        notifications: { where: { isRead: false }, select: { id: true } },
      },
    });
    if (!user) throw new ApiError(404, 'User not found');

    const unreadCount = user.notifications.length;
    const raw = user.subscriptions[0] || null;
    const activeSub = raw
      ? { plan: raw.service.name, paymentStatus: raw.paymentStatus, expiresAt: raw.endDate }
      : null;

    success(res, {
      ...userProfile(user),
      onboardingComplete: req.user.onboardingComplete,
      unreadNotifications: unreadCount,
      activeSubscription: activeSub,
    });
  } catch (err) { next(err); }
}

// GET /api/auth/onboarding-status — cheap re-check without a full /sync round-trip.
async function getOnboardingStatus(req, res, next) {
  try {
    success(res, {
      onboardingComplete: !!req.user.onboardingComplete,
      phoneVerified: !!req.user.phoneVerified,
      role: req.user.role,
    });
  } catch (err) { next(err); }
}

function userProfile(u) {
  return {
    id:              u.id,
    clerkId:         u.clerkId,
    name:            u.name,
    email:           u.email,
    phone:           u.phone,
    phoneVerified:   u.phoneVerified,
    emailVerified:   u.emailVerified,
    role:            u.role,
    isNRI:           u.isNRI,
    profileImageUrl: u.profileImageUrl,
    // Partner-specific
    partnerSubType:  u.partnerSubType  || null,
    companyName:     u.companyName     || null,
    bio:             u.bio             || null,
    websiteUrl:      u.websiteUrl      || null,
    // KYC
    kycStatus:       u.kycStatus,
    kycVerifiedAt:   u.kycVerifiedAt   || null,
    kycRejectionNote:u.kycRejectionNote|| null,
    createdAt:       u.createdAt,
    updatedAt:       u.updatedAt,
  };
}

// POST /api/auth/set-role
async function setRole(req, res, next) {
  try {
    const { role } = req.body;
    if (role !== 'PARTNER') throw new ApiError(400, 'Only PARTNER role can be self-assigned');
    if (req.user.role !== 'USER') return success(res, { role: req.user.role }); // idempotent

    await setUserRole(req.user.clerkId, 'PARTNER').catch((err) =>
      logger.warn('[setRole] setUserRole failed', { clerkId: req.user.clerkId, error: err.message })
    );
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { role: 'PARTNER' } });
    logger.info('[setRole] upgraded to PARTNER', { userId: req.user.id });
    success(res, { role: user.role });
  } catch (err) {
    next(err instanceof ApiError ? err : new ApiError(500, err.message));
  }
}

// ─── B3: signup / login by phone OTP ──────────────────────────────────────────

async function signupOtp(req, res, next) {
  try {
    const data = signupOtpSchema.parse(req.body);
    const result = await authService.signupOtp(data);
    success(res, result, 'OTP sent via WhatsApp');
  } catch (err) { next(err); }
}

async function signupVerify(req, res, next) {
  try {
    const data = signupVerifySchema.parse(req.body);
    const { user, signInToken } = await authService.signupVerify(data);
    created(res, { signInToken, user: userProfile(user) }, 'Account created');
  } catch (err) { next(err); }
}

async function loginOtp(req, res, next) {
  try {
    const data = loginOtpSchema.parse(req.body);
    const result = await authService.loginOtp(data);
    success(res, result, 'OTP sent via WhatsApp');
  } catch (err) { next(err); }
}

async function loginVerify(req, res, next) {
  try {
    const data = loginVerifySchema.parse(req.body);
    const { user, signInToken } = await authService.loginVerify(data);
    success(res, { signInToken, user: userProfile(user) }, 'Login successful');
  } catch (err) { next(err); }
}

// ─── B5: Google onboarding — phone completion ────────────────────────────────

async function googlePhoneOtp(req, res, next) {
  try {
    const data = googlePhoneOtpSchema.parse(req.body);
    const result = await authService.googlePhoneOtp(req.user, data);
    success(res, result, 'OTP sent via WhatsApp');
  } catch (err) { next(err); }
}

async function googlePhoneVerify(req, res, next) {
  try {
    const data = googlePhoneVerifySchema.parse(req.body);
    const user = await authService.googlePhoneVerify(req.user, data);
    success(res, { ...userProfile(user), onboardingComplete: true }, 'Phone verified');
  } catch (err) { next(err); }
}

module.exports = {
  syncUser, getMe, setRole, getOnboardingStatus,
  signupOtp, signupVerify, loginOtp, loginVerify,
  googlePhoneOtp, googlePhoneVerify,
};
