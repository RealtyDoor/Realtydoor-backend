const ApiError = require('../utils/ApiError');

// Express parses ?status[not]=CLOSED into { status: { not: 'CLOSED' } }. Several list endpoints pass query values straight into a
// database filter, so a nested value would let the caller choose the filter operator (or crash a string method with a 500). No
// endpoint takes a nested query value, so refuse them in one place. Repeated plain values (?tag=a&tag=b) stay allowed.
const isPlainValue = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function rejectNestedQuery(req, res, next) {
  for (const value of Object.values(req.query || {})) {
    const ok = isPlainValue(value) || (Array.isArray(value) && value.every(isPlainValue));
    if (!ok) return next(new ApiError(400, 'The query string has a value in a shape this API does not accept', { code: 'INVALID_QUERY' }));
  }
  next();
}

module.exports = { rejectNestedQuery };
