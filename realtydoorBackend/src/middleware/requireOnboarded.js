const ApiError = require('../utils/ApiError');

// Only USER accounts go through phone-first onboarding (signup/login-by-phone).
// PARTNER/ADMIN accounts have their own KYC gate and aren't blocked here.
function requireOnboarded(req, res, next) {
  if (req.user?.role !== 'USER') return next();
  if (req.user?.onboardingComplete) return next();
  return next(new ApiError(403, 'Please verify your phone number to continue', { code: 'ONBOARDING_INCOMPLETE' }));
}

module.exports = { requireOnboarded };
