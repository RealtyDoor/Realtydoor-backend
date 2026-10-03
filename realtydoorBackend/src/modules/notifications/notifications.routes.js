const router = require('express').Router();
const ctrl = require('./notifications.controller');
const { authenticate } = require('../../middleware/auth');
const { requireUser } = require('../../middleware/requireRole');
const { perUserLimiter } = require('../../middleware/rateLimiter');

router.use(authenticate, requireUser, perUserLimiter);

router.get('/', ctrl.getMyNotifications);
router.get('/unread-count', ctrl.getUnreadCount);
router.patch('/:id/read', ctrl.markRead);
router.patch('/read-all', ctrl.markAllRead);

module.exports = router;
