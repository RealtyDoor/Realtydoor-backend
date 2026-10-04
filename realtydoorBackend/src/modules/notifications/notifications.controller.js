const { success } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./notifications.service');
const { broadcastSchema } = require('./notifications.validator');
const { NOTIFICATION_CATEGORIES } = require('../../lib/notifications');
const ApiError = require('../../utils/ApiError');

async function getMyNotifications(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { category } = req.query;
    if (category && !NOTIFICATION_CATEGORIES.includes(category)) {
      throw new ApiError(400, `category must be one of: ${NOTIFICATION_CATEGORIES.join(', ')}`);
    }
    const { data, total } = await service.getMyNotifications(req.user.id, skip, limit, category);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function markRead(req, res, next) {
  try {
    await service.markRead(req.user.id, req.params.id);
    success(res, null, 'Marked as read');
  } catch (err) { next(err); }
}

async function markAllRead(req, res, next) {
  try {
    await service.markAllRead(req.user.id);
    success(res, null, 'All marked as read');
  } catch (err) { next(err); }
}

async function getUnreadCount(req, res, next) {
  try {
    const result = await service.getUnreadCount(req.user.id);
    success(res, result);
  } catch (err) { next(err); }
}

async function broadcast(req, res, next) {
  try {
    const data = broadcastSchema.parse(req.body);
    const result = await service.broadcast(data);
    success(res, result, 'Broadcast sent');
  } catch (err) { next(err); }
}

module.exports = { getMyNotifications, markRead, markAllRead, getUnreadCount, broadcast };
