const router = require('express').Router();
const ctrl = require('./auth.controller');
const { authenticate } = require('../../middleware/auth');
const { authLimiter, otpSendLimiter, otpVerifyLimiter } = require('../../middleware/rateLimiter');

// POST /api/auth/sync  — call on every login from the frontend
// Verifies JWT, fetches full Clerk profile, upserts DB, returns profile
router.post('/sync', authLimiter, ctrl.syncUser);

// GET /api/auth/me  — returns the full profile for the currently logged-in user
router.get('/me', authenticate, ctrl.getMe);

// GET /api/auth/onboarding-status — cheap onboarding re-check
router.get('/onboarding-status', authenticate, ctrl.getOnboardingStatus);

// POST /api/auth/set-role  — self-service role upgrade (USER → PARTNER only)
router.post('/set-role', authenticate, ctrl.setRole);

// Phone-OTP signup
router.post('/signup/otp',    otpSendLimiter,   ctrl.signupOtp);
router.post('/signup/verify', otpVerifyLimiter, ctrl.signupVerify);

// Phone-OTP login
router.post('/login/otp',     otpSendLimiter,   ctrl.loginOtp);
router.post('/login/verify',  otpVerifyLimiter, ctrl.loginVerify);

// Google onboarding — phone completion step
router.post('/google/phone/otp',    authenticate, otpSendLimiter,   ctrl.googlePhoneOtp);
router.post('/google/phone/verify', authenticate, otpVerifyLimiter, ctrl.googlePhoneVerify);

module.exports = router;
