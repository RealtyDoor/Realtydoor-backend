const router = require('express').Router();
const ctrl = require('./properties.controller');
const reviewsRouter = require('../reviews/reviews.routes');
const { authenticate } = require('../../middleware/auth');
const { requirePartner } = require('../../middleware/requireRole');
const { requireKyc } = require('../../middleware/requireKyc');
const { propertyImageUploader, propertyVideoUploader, propertyDocUploader } = require('../../lib/fileUpload');
const checklistCtrl = require('../listings/checklist.controller');
const { searchLimiter, defaultLimiter } = require('../../middleware/rateLimiter');

// Public
router.get('/', searchLimiter, ctrl.search);
router.get('/featured', ctrl.getFeatured);
router.get('/:slug', ctrl.getBySlug);

// R27 — public (the real owner may have no RealtyDoor account at all).
// Above the slug-only GET for the same reason as construction-updates below:
// a further path segment, so it can't be captured by `/:slug`.
router.post('/:id/report-unauthorized', defaultLimiter, ctrl.reportUnauthorizedListing);

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
// 4.1 — structured OWNER-persona checklist documents (sale deed, encumbrance
// certificate, khata, society NOC), distinct from the free-form uploads
// above (brochures, floor plans). One file per documentType; a re-upload
// replaces the previous attempt.
router.post('/:id/checklist-documents', authenticate, requirePartner, propertyDocUploader.single('document'), checklistCtrl.uploadChecklistDocument);
router.get('/:id/checklist', authenticate, requirePartner, checklistCtrl.getMyChecklist);

module.exports = router;
