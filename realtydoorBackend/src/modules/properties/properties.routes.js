const router = require('express').Router();
const ctrl = require('./properties.controller');
const reviewsRouter = require('../reviews/reviews.routes');
const { authenticate } = require('../../middleware/auth');
const { requirePartner } = require('../../middleware/requireRole');
const { requireKyc } = require('../../middleware/requireKyc');
const { propertyImageUploader, propertyVideoUploader, propertyDocUploader } = require('../../lib/fileUpload');
const { searchLimiter } = require('../../middleware/rateLimiter');

// Public
router.get('/', searchLimiter, ctrl.search);
router.get('/featured', ctrl.getFeatured);
router.get('/:slug', ctrl.getBySlug);

// Reviews (public GET, authenticated POST)
router.use('/:propertyId/reviews', reviewsRouter);

// Public — construction timeline
router.get('/:id/construction-updates', ctrl.getConstructionUpdates);

// Partner (KYC required)
router.get('/:id/edit-logs', authenticate, requirePartner, requireKyc, ctrl.getEditLogs);
router.post('/:id/construction-updates', authenticate, requirePartner, requireKyc, ctrl.addConstructionUpdate);
router.post('/', authenticate, requirePartner, requireKyc, ctrl.create);
router.patch('/:id', authenticate, requirePartner, requireKyc, ctrl.update);
router.post('/:id/images', authenticate, requirePartner, propertyImageUploader.array('images', 10), ctrl.uploadImages);
router.post('/:id/videos', authenticate, requirePartner, propertyVideoUploader.array('videos', 5), ctrl.uploadVideos);
router.post('/:id/documents', authenticate, requirePartner, propertyDocUploader.array('documents', 10), ctrl.uploadDocuments);

module.exports = router;
