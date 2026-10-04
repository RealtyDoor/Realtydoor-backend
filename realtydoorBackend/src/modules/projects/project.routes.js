const router = require('express').Router();
const ctrl = require('./project.controller');

// Public — approved projects only (gated inside project.service.js).
router.get('/', ctrl.search);
router.get('/:slug', ctrl.getBySlug);

module.exports = router;
