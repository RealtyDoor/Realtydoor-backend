const router = require('express').Router();
const ctrl = require('./b2b.controller');
const { authenticate } = require('../../middleware/auth');
const { requirePartner } = require('../../middleware/requireRole');
const { requireKyc } = require('../../middleware/requireKyc');
const { perUserLimiter } = require('../../middleware/rateLimiter');
const { validateObjectId } = require('../../middleware/validateObjectId');

// B5.9-B5.11 — the network is for verified partners only. requireKyc is the
// gate: hidden inventory must not be visible to an unvetted account.
router.use(authenticate, requirePartner, requireKyc, perUserLimiter);

router.get('/',             ctrl.getFeed);
router.get('/counts',       ctrl.getFeedCounts);
router.get('/connections',  ctrl.getMyConnections);
router.post('/:propertyId/interest', validateObjectId('propertyId'), ctrl.expressInterest);

module.exports = router;
