const router = require('express').Router();
const ctrl = require('./auth.controller');
const { authenticate } = require('../../middleware/auth');
const { authLimiter } = require('../../middleware/rateLimiter');

// POST /api/auth/sync  — call on every login from the frontend
// Verifies JWT, fetches full Clerk profile, upserts DB, returns profile
router.post('/sync', authLimiter, ctrl.syncUser);

// GET /api/auth/me  — returns the full profile for the currently logged-in user
router.get('/me', authenticate, ctrl.getMe);

// POST /api/auth/set-role  — self-service role upgrade (USER → PARTNER only)
router.post('/set-role', authenticate, ctrl.setRole);

module.exports = router;
