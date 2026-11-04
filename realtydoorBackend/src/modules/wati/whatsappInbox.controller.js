const { success } = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const service = require('./whatsappInbox.service');

const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

const conversations = wrap(async (req, res) => success(res, await service.listConversations({ search: req.query.search, limit: Number(req.query.limit) || 40 })));
const thread = wrap(async (req, res) => {
  if (!/^\d{8,15}$/.test(String(req.params.phone || ''))) throw new ApiError(400, 'Invalid phone');
  success(res, await service.getThread(req.params.phone, Number(req.query.limit) || 300));
});
const message = wrap(async (req, res) => {
  const m = await service.getMessageDetail(req.params.id);
  if (!m) throw new ApiError(404, 'Message not found');
  success(res, m);
});

const logDetail = wrap(async (req, res) => {
  const d = await service.getLogDetail(req.params.id);
  if (!d) throw new ApiError(404, 'Message not found');
  success(res, d);
});

module.exports = { conversations, thread, message, logDetail };
