const { success } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./partnerTicket.admin.service');
const { listPartnerTicketsQuerySchema, updatePartnerTicketSchema } = require('./partnerTicket.admin.validator');

async function listPartnerTickets(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filters = listPartnerTicketsQuerySchema.parse(req.query);
    const { data, total, statusCounts } = await service.listPartnerTickets(filters, skip, limit);
    success(res, { ...paginate(data, total, page, limit), statusCounts });
  } catch (err) { next(err); }
}

async function getPartnerTicketById(req, res, next) {
  try {
    success(res, await service.getPartnerTicketById(req.params.id));
  } catch (err) { next(err); }
}

async function updatePartnerTicket(req, res, next) {
  try {
    const data = updatePartnerTicketSchema.parse(req.body);
    success(res, await service.updatePartnerTicket(req.params.id, data, req.user.id, req.ip));
  } catch (err) { next(err); }
}

module.exports = { listPartnerTickets, getPartnerTicketById, updatePartnerTicket };
