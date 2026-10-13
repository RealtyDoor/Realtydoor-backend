const ApiError = require('../utils/ApiError');

// Partners must have kycStatus: VERIFIED to access protected partner routes
function requireKyc(req, res, next) {
  if (req.user?.role === 'ADMIN') return next();
  if (req.user?.kycStatus !== 'VERIFIED') {
    // BE-16/BE-21 — coded so the FE can distinguish this from a bare
    // wrong-role 403 (requireRole/requirePermission) — the bank-account
    // page specifically depends on this to show its "finish after KYC"
    // guidance rather than a generic access-denied message.
    return next(new ApiError(403, 'KYC verification required to access this resource', { code: 'KYC_REQUIRED' }));
  }
  next();
}

module.exports = { requireKyc };
