const { ZodError } = require('zod');
const ApiError = require('../utils/ApiError');
const logger = require('../lib/logger');

// BE-16 — only ~14% of this codebase's ~490 `new ApiError(...)` call sites
// pass an explicit `{ code }`; rewriting every one by hand to pick a
// meaningful, non-colliding code isn't warranted (most are a single,
// unambiguous failure mode with no FE branching need) and isn't what the
// audit asks for either — it explicitly frames this as "a safety net only;
// specific codes are expected wherever the FE must branch." This map is
// that safety net: an ApiError with no code gets one derived from its
// status, so every 4xx/5xx response carries SOME stable data.code without
// touching the ~360 call sites that don't need a bespoke one. A call site
// that DOES need the FE to branch on it still sets its own explicit code,
// which always wins (this never overwrites one that's already present).
const STATUS_DEFAULT_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  502: 'UPSTREAM_ERROR',
  // L3 fix — an explicit `new ApiError(500, ...)` with no code previously
  // fell through to the generic `HTTP_500` fallback below, a DIFFERENT
  // code than a non-ApiError exception gets (INTERNAL_ERROR, a few lines
  // down) — two codes for what's the same thing from the FE's perspective
  // ("something broke server-side"). Both now resolve to INTERNAL_ERROR.
  500: 'INTERNAL_ERROR',
};

// B128 — a malformed ObjectId (e.g. GET /api/escrow/all) reaches Prisma and
// comes back as a driver error, not an ApiError, so it surfaced as a 500 on
// every route that doesn't carry validateObjectId. Prisma reports it as
// P2023 ("Malformed ObjectID ...") or as a validation error with the same
// text; either is a bad client id, i.e. a 400.
function isMalformedObjectIdError(err) {
  if (!err) return false;
  if (err.code === 'P2023') return true;
  return /Malformed ObjectID|Invalid `?ObjectId|Inconsistent column data: Malformed/i.test(String(err.message || ''));
}

function notFound(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: err.errors[0]?.message || 'Validation error',
      data: { code: 'VALIDATION_ERROR' },
      errors: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  // The body parser's own failures are the client's mistake, not a server fault: a body that is not valid JSON (400) or is
  // bigger than the limit (413). Without this they surfaced as a 500 and filled the error log with stack traces.
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'The request body is not valid JSON', data: { code: 'INVALID_JSON' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'The request body is too large', data: { code: 'BODY_TOO_LARGE' } });
  }

  if (isMalformedObjectIdError(err)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid id',
      data: { code: 'INVALID_ID' },
    });
  }

  const statusCode = err instanceof ApiError ? err.statusCode : 500;
  const message = err instanceof ApiError ? err.message : 'Internal Server Error';
  const data = err instanceof ApiError
    ? (err.data?.code ? err.data : { ...err.data, code: STATUS_DEFAULT_CODES[statusCode] || `HTTP_${statusCode}` })
    : { code: 'INTERNAL_ERROR' };

  if (statusCode >= 500) {
    logger.error('Unhandled error', {
      requestId: req.requestId,
      userId: req.user?.id || null,
      method: req.method,
      url: req.originalUrl,
      statusCode,
      error: err.message,
      stack: err.stack,
    });
  }

  res.status(statusCode).json({
    success: false,
    message,
    data,
    // The stack (file paths, the failing query) goes to the log, never to the client, whatever NODE_ENV is: the test site is public
    // and runs in development mode. A developer can switch it on explicitly on their own machine with EXPOSE_ERROR_STACK=true.
    ...(process.env.EXPOSE_ERROR_STACK === 'true' && process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
}

module.exports = { notFound, errorHandler, isMalformedObjectIdError };
