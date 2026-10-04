const ApiError = require('../utils/ApiError');

// 16.x — a finer-grained gate than requireAdmin, for routes the staff
// directory's permission matrix actually restricts. Applied selectively
// (escrow release, commission lock/collect, KYC verify) rather than
// retrofitted onto every admin route in the app — most routes stay on the
// existing requireAdmin check unchanged.
function requirePermission(scope) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'Not authenticated'));
    if (req.user.role !== 'ADMIN') return next(new ApiError(403, 'Insufficient permissions'));
    // staffRole unset means this admin predates the staff directory (or was
    // deliberately left unscoped) — keeps full access. Once a staffRole is
    // assigned, adminPermissions is the real gate; SUPER_ADMIN bypasses it.
    if (req.user.staffRole == null) return next();
    if (req.user.staffRole === 'SUPER_ADMIN') return next();
    if ((req.user.adminPermissions || []).includes(scope)) return next();
    return next(new ApiError(403, `Missing the ${scope} permission`));
  };
}

module.exports = { requirePermission };
