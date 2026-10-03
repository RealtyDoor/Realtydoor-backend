const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');
const { defaultLimiter } = require('./middleware/rateLimiter');

const app = express();

// Deployed behind a reverse proxy/load balancer (Render, Railway, Nginx, ALB, …),
// which sets X-Forwarded-For. Without this, express-rate-limit throws on every
// request (it refuses to guess client IPs when trust proxy is unset), and req.ip
// would resolve to the proxy instead of the real client. Adjust the hop count if
// there's more than one proxy in front of this app (e.g. Cloudflare + ALB → 2).
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());
const ALLOWED_ORIGINS = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Postman / curl / mobile
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(compression());

// ── Webhook routes MUST be mounted before express.json() ─────────────────────
// Razorpay sends a raw body that must be intact for HMAC signature verification.
// express.json() consumes the stream — if it runs first, the raw body is gone
// and verifyWebhookSignature() will always reject.
const webhookRoutes = require('./modules/webhooks/webhooks.routes');
app.use('/api/webhooks', webhookRoutes);

// ── Body parsers (all other routes) ───────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Centralised request/response logger ───────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(requestLogger);
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── API routes ────────────────────────────────────────────────────────────────
// Global baseline rate limit — route-specific limiters (auth, OTP, upload,
// search) stack tighter caps on top of this for the endpoints that need it.
const routes = require('./routes');
app.use('/api', defaultLimiter, routes);

// ── 404 + global error handler ────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
