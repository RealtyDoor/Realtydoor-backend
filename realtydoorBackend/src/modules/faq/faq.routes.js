const router = require('express').Router();
const ctrl = require('./faq.controller');

// Public — all published FAQ content blocks, `content` parsed to JSON
router.get('/',      ctrl.getAll);
// Public — single FAQ content block by slug, `content` parsed to JSON
router.get('/:slug', ctrl.getBySlug);

module.exports = router;
