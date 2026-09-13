const { success } = require('../../utils/ApiResponse');
const service = require('./faq.service');

async function getAll(req, res, next) {
  try {
    const data = await service.getAll();
    success(res, data);
  } catch (err) { next(err); }
}

async function getBySlug(req, res, next) {
  try {
    const data = await service.getBySlug(req.params.slug);
    success(res, data);
  } catch (err) { next(err); }
}

module.exports = { getAll, getBySlug };
