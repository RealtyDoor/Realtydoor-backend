const crypto = require('crypto');
const logger = require('../lib/logger');

const isDev = process.env.NODE_ENV !== 'production';

// ─── Redaction config ─────────────────────────────────────────────────────────

const REDACTED_REQ_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-clerk-auth-token',
  'x-api-key',
  'x-razorpay-signature',
]);

const REDACTED_RES_HEADERS = new Set([
  'set-cookie',
]);

// Sensitive keys anywhere in request body or response body
const REDACTED_KEYS = new Set([
  'password',
  'hashedPassword',
  'otp',
  'code',            // signup/login/Google-complete OTP codes
  'codeHash',
  'siteVisitOTP',
  'token',
  'signInToken',
  'secret',
  'razorpayPaymentId',
  'razorpayOrderId',
  'razorpayKeySecret',
  'key',
  'razorpayKey',
  'accessToken',
  'refreshToken',
  'kycDocumentUrls',  // don't leak Cloudinary signed URLs in logs
]);

// Max characters of response/request body to log before truncating
const BODY_LOG_LIMIT = isDev ? 4000 : 1500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeHeaders(headers, redactSet) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = redactSet.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

// Keys stripped entirely from logged bodies (verbose dev-only fields)
const STRIP_BODY_KEYS = new Set(['stack']);

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_BODY_KEYS.has(k)) continue;
    out[k] = REDACTED_KEYS.has(k)
      ? '[REDACTED]'
      : v && typeof v === 'object'
        ? sanitizeObject(v)
        : v;
  }
  return out;
}

function truncateBody(body) {
  if (!body) return undefined;
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  if (str.length <= BODY_LOG_LIMIT) return body;
  return {
    _truncated: true,
    _originalSize: str.length,
    _preview: str.slice(0, BODY_LOG_LIMIT) + '…',
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

function requestLogger(req, res, next) {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startAt = process.hrtime.bigint();

  // ── Log incoming request ──────────────────────────────────────────────────
  logger.info('→ Incoming request', {
    requestId,
    method:    req.method,
    url:       req.originalUrl,
    ip:        req.ip || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || null,
    ...(isDev ? {} : { headers: sanitizeHeaders(req.headers, REDACTED_REQ_HEADERS) }),
    query:     Object.keys(req.query).length ? req.query : undefined,
    body:      req.method !== 'GET'
                 ? truncateBody(sanitizeObject(req.body))
                 : undefined,
  });

  // ── Intercept res.json to capture response body ───────────────────────────
  const originalJson = res.json.bind(res);
  res.json = function (payload) {
    res._logPayload = payload;  // stash before writing
    return originalJson(payload);
  };

  // ── Log outgoing response on finish ───────────────────────────────────────
  res.on('finish', () => {
    const durationMs = parseFloat(
      (Number(process.hrtime.bigint() - startAt) / 1_000_000).toFixed(2)
    );

    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info';

    const body = res._logPayload
      ? truncateBody(sanitizeObject(res._logPayload))
      : undefined;

    logger[level]('← Response sent', {
      requestId,
      userId:        req.user?.id   || null,
      role:          req.user?.role || null,
      method:        req.method,
      url:           req.originalUrl,
      statusCode:    res.statusCode,
      durationMs,
      ...(isDev ? {} : { contentLength: res.getHeader('content-length') || null }),
      ...(isDev ? {} : { headers: sanitizeHeaders(res.getHeaders(), REDACTED_RES_HEADERS) }),
      body,
    });
  });

  next();
}

module.exports = { requestLogger };
