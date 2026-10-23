const ApiError = require('../utils/ApiError');

// A NUL character (%00) is never legitimate text, and the database driver answers it with a crash (HTTP 500 plus a query
// dump in the logs). Refuse it up front, in the query string, the route parameters and a JSON or form body, with a clear 400.
function hasNul(value, depth = 0) {
  if (value == null || depth > 6) return false;
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some((v) => hasNul(v, depth + 1));
  if (typeof value === 'object') return Object.entries(value).some(([k, v]) => k.includes('\u0000') || hasNul(v, depth + 1));
  return false;
}

function rejectNullBytes(req, res, next) {
  if (hasNul(req.query) || hasNul(req.params) || hasNul(req.body) || String(req.originalUrl).includes('%00')) {
    return next(new ApiError(400, 'The request contains an invalid character', { code: 'INVALID_CHARACTER' }));
  }
  next();
}

module.exports = { rejectNullBytes, hasNul };
