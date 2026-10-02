const ApiError = require('../utils/ApiError');
const { ROLES } = require('../utils/validators');

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'Not authenticated'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'Insufficient permissions'));
    }
    next();
  };
}

const requireAdmin = requireRole('ADMIN');
const requirePartner = requireRole('PARTNER', 'ADMIN');
const requireUser = requireRole(...ROLES); // any authenticated role

module.exports = { requireRole, requireAdmin, requirePartner, requireUser };
