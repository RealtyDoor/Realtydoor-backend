const ApiError = require('../utils/ApiError');

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

// A malformed :id route param previously reached Prisma directly and came
// back as a generic 500 (a cast/validation error from the driver), not a
// clean 4xx. Apply before any route whose :id (or other named param) is
// used in a Prisma lookup.
function validateObjectId(paramName = 'id') {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!OBJECT_ID_RE.test(value)) {
      return next(new ApiError(400, `Invalid ${paramName}`));
    }
    next();
  };
}

module.exports = { validateObjectId };
