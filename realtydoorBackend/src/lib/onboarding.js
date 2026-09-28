'use strict';

// Single source of truth for the USER phone-onboarding flag — verified phone,
// or still inside the pre-migration grace window (phoneVerifyDeadline, B9
// backfill). Used by middleware/auth.js (every authenticated request) and
// auth.service.js's /sync so the two never disagree for a user in the grace
// window. Role is deliberately not considered here — PARTNER/ADMIN accounts
// are exempted at the gate (middleware/requireOnboarded.js), not by this flag.
function computeOnboardingComplete(user) {
  return user.phoneVerified === true
    || (!!user.phoneVerifyDeadline && new Date() < new Date(user.phoneVerifyDeadline));
}

module.exports = { computeOnboardingComplete };
