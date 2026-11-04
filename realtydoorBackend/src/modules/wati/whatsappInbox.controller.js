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

const importer = require('./watiImport.service');
const importFromWati = wrap(async (req, res) => {
  const b = req.body || {};
  const out = await importer.importSlice({
    since: b.since ? String(b.since) : undefined,
    startPage: Math.max(1, Number(b.startPage) || 1),
    pages: Math.min(Math.max(Number(b.pages) || 2, 1), 5),
    dryRun: b.dryRun === true,
  });
  success(res, out);
});

// A chat becomes a lead on purpose, with one click, using the buyer's first message. Old chats are never turned into leads by themselves.
const makeLead = wrap(async (req, res) => {
  if (!/^\d{8,15}$/.test(String(req.params.phone || ''))) throw new ApiError(400, 'Invalid phone');
  success(res, await service.createLeadFromChat(req.params.phone), 'Lead created');
});

module.exports = { conversations, thread, message, logDetail, importFromWati, makeLead };
