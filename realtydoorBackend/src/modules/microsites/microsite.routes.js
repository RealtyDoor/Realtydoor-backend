const router = require('express').Router();
const ctrl = require('./microsite.controller');
const { defaultLimiter } = require('../../middleware/rateLimiter');

// Public, no auth — the standalone property microsite page at /m/<slug>.
router.get('/:slug', defaultLimiter, ctrl.getBySlug);

module.exports = router;
