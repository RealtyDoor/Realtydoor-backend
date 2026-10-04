const { success } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./listings.partner.service');

async function myChangeRequests(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listMyChangeRequests(req.user.id, req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function withdrawChangeRequest(req, res, next) {
  try {
    const cr = await service.withdrawMyChangeRequest(req.params.id, req.user.id);
    success(res, cr, 'Change request withdrawn');
  } catch (err) { next(err); }
}

module.exports = { myChangeRequests, withdrawChangeRequest };
