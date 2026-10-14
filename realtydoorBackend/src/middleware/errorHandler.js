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
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  });
}

module.exports = { notFound, errorHandler };
