const router = require('express').Router();
const ctrl = require('./locality.controller');
const { authenticate } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireRole');
const { searchLimiter } = require('../../middleware/rateLimiter');

// Public — property detail page fetches this (requires ?city=&locality=)
router.get('/insight',        ctrl.getLocality);
// Public — locality market-intelligence landing page (requires ?city=&locality=)
router.get('/page',           ctrl.getLocalityPage);
// Public — homepage city cards aggregate
router.get('/cities-summary', ctrl.getCitiesSummary);
// Public — every locality that has a page (optional ?city filter); must sit
// before /:id below, or "localities" would be read as an :id.
router.get('/localities',     ctrl.getLocalitiesList);
// Public — downloadable PDF report (requires ?city=&locality=); PDF generation is
// heavier than a plain JSON read, so it shares the tighter search-tier rate limit.
router.get('/report',         searchLimiter, ctrl.downloadReport);

// Admin-only management
router.get('/',        authenticate, requireAdmin, ctrl.listLocalities);
router.get('/:id',     authenticate, requireAdmin, ctrl.getLocalityById);
router.post('/',       authenticate, requireAdmin, ctrl.upsertLocality);
router.delete('/:id',  authenticate, requireAdmin, ctrl.deleteLocality);

module.exports = router;
