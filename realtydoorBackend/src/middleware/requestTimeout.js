'use strict';

// A read that has not answered after REQUEST_TIMEOUT_MS (default 30 s) gets a clean 503 "try again" with Retry-After, instead of hanging
// until the load balancer or the browser gives up (a stuck database call held one request for 108 s in the 7 Nov 2026 load test).
//
// Only READS (GET and HEAD) are cut. A write can still finish on the server after the timeout, so telling the user "failed" would be a
// lie about a payment, refund or assignment that went through; for writes the database socket timeout (socketTimeoutMS on the connection
// string) is the safe limit. Exports, reports and PDFs are slow on purpose and are left alone. Webhooks are mounted before this and are
// never under it.
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const SLOW_ON_PURPOSE = /\/(export|report|pdf|download)(\/|$)/i;

function resolveTimeoutMs(env = process.env) {
  const n = Number(env.REQUEST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REQUEST_TIMEOUT_MS;
}

function requestTimeout(ms = resolveTimeoutMs()) {
  return function requestTimeoutMiddleware(req, res, next) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || SLOW_ON_PURPOSE.test(req.originalUrl.split('?')[0])) return next();
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      res.set('Retry-After', '5');
      res.status(503).json({
        success: false,
        message: 'The server is taking too long to answer. Please try again in a moment.',
        data: { code: 'REQUEST_TIMEOUT' },
      });
    }, ms);
    timer.unref();
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

module.exports = { requestTimeout, resolveTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS };
