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
  // PII — every request/response body routinely carries these (contact
  // messages, leads, user profiles), and this logger ran unredacted until
  // now: real names/emails/phones/addresses were landing in plain log output.
  'email',
  'phone',
  'name',
  'address',
  'buyerEmail',
  'buyerPhone',
  'buyerName',
  // Tax and bank identifiers (partner KYC, payout accounts, tax invoices). Logs are read by developers through CloudWatch.
  'pan',
  'panNumber',
  'gstin',
  'accountNumber',
  'bankAccountNo',
  'bankHolderName',
  'bankIfsc',
  'ifsc',
  'beneficiaryName',
  'upi',
  'upiId',
  'vpa',
]);

// Free text typed by a person (contact, NRI and reply forms): hidden in what is sent TO us. Not hidden in responses, where `message`
// is the standard status text ("Invalid token") that makes an error line useful.
const REDACTED_REQUEST_ONLY_KEYS = new Set(['message', 'body']);

// Query-string parameters whose values are hidden (searches by phone or email show up here). Also every key in REDACTED_KEYS.
const REDACTED_QUERY_KEYS = new Set(['search', 'q', 'query']);

// Max characters of response/request body to log before truncating
// Dev used to log up to 4000 chars of every request AND response body, which
// (with the sanitize + stringify pass on each) made the dev server sluggish and
// the console unreadable. Dev now keeps previews short and logs response bodies
// only for errors.
const BODY_LOG_LIMIT = isDev ? 300 : 1500;

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

function sanitizeObject(obj, extraKeys) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitizeObject(v, extraKeys));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_BODY_KEYS.has(k)) continue;
    out[k] = REDACTED_KEYS.has(k) || (extraKeys && extraKeys.has(k))
      ? '[REDACTED]'
      : v && typeof v === 'object'
        ? sanitizeObject(v, extraKeys)
        : v;
  }
  return out;
}

const isHiddenQueryKey = (k) => REDACTED_KEYS.has(k) || REDACTED_QUERY_KEYS.has(k);

// "/api/admin/users?search=9845012345&page=2" -> "/api/admin/users?search=%5BREDACTED%5D&page=2"
function redactUrl(url) {
  if (typeof url !== 'string') return url;
  const i = url.indexOf('?');
  if (i < 0) return url;
  try {
    const params = new URLSearchParams(url.slice(i + 1));
    for (const key of new Set(params.keys())) if (isHiddenQueryKey(key)) params.set(key, '[REDACTED]');
    return `${url.slice(0, i)}?${params.toString()}`;
  } catch {
    return url.slice(0, i);
  }
}

function redactQuery(query) {
  const out = {};
  for (const [k, v] of Object.entries(query || {})) out[k] = isHiddenQueryKey(k) ? '[REDACTED]' : v;
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
    url:       redactUrl(req.originalUrl),
    ip:        req.ip || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || null,
    ...(isDev ? {} : { headers: sanitizeHeaders(req.headers, REDACTED_REQ_HEADERS) }),
    query:     Object.keys(req.query).length ? redactQuery(req.query) : undefined,
    body:      req.method !== 'GET'
                 ? truncateBody(sanitizeObject(req.body, REDACTED_REQUEST_ONLY_KEYS))
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

    // Only error responses are logged with their body, in every environment: a successful response carries profiles, KYC and bank
    // data, and logging all of it filled the logs (and the CloudWatch free allowance) with personal data.
    const body = res._logPayload && res.statusCode >= 400
      ? truncateBody(sanitizeObject(res._logPayload))
      : undefined;

    logger[level]('← Response sent', {
      requestId,
      userId:        req.user?.id   || null,
      role:          req.user?.role || null,
      method:        req.method,
      url:           redactUrl(req.originalUrl),
      statusCode:    res.statusCode,
      durationMs,
      ...(isDev ? {} : { contentLength: res.getHeader('content-length') || null }),
      ...(isDev ? {} : { headers: sanitizeHeaders(res.getHeaders(), REDACTED_RES_HEADERS) }),
      body,
    });
  });

  next();
}

module.exports = { requestLogger, sanitizeObject, redactUrl };
