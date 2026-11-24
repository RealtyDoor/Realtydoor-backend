// Reception desk (23 Nov 2026). Only admins holding RECEPTION (or full admins) get in; a receptionist account is also locked out of every
// other route in the app (lib/staffLockdown.js). The admin list of all entries is GET /admin/reception-visits (admin.routes.js).
const router = require('express').Router();
const ctrl = require('./reception.controller');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/requirePermission');
const { visitPhotoUploader } = require('../../lib/fileUpload');
const { receptionVisitLimiter, userUploadLimiter } = require('../../middleware/rateLimiter');

router.use(authenticate, requirePermission('RECEPTION'));

router.get('/leads/search', ctrl.search);
// Failed entries are capped (receptionVisitLimiter); code guessing is stopped by the per-lead 3-try lock. Up to 3 photos, private under visits/.
router.post('/visits', userUploadLimiter, receptionVisitLimiter, visitPhotoUploader.fields([{ name: 'photos', maxCount: 3 }]), ctrl.recordVisit);
router.get('/visits', ctrl.myVisits);

module.exports = router;
