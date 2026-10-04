const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./wati.service');
const {
  createTemplateSchema, updateTemplateSchema, syncStatusSchema, testSendSchema,
} = require('./wati.validator');

async function listTemplates(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listTemplates(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getTemplate(req, res, next) {
  try {
    success(res, await service.getTemplateById(req.params.id));
  } catch (err) { next(err); }
}

async function createTemplate(req, res, next) {
  try {
    const data = createTemplateSchema.parse(req.body);
    const tpl = await service.createTemplate(data, req.user.id, req.ip);
    created(res, tpl, 'Template created');
  } catch (err) { next(err); }
}

async function updateTemplate(req, res, next) {
  try {
    const data = updateTemplateSchema.parse(req.body);
    const tpl = await service.updateTemplate(req.params.id, data, req.user.id, req.ip);
    success(res, tpl, 'Template updated');
  } catch (err) { next(err); }
}

async function deleteTemplate(req, res, next) {
  try {
    const result = await service.deleteTemplate(req.params.id, req.user.id, req.ip);
    success(res, result, 'Template deleted');
  } catch (err) { next(err); }
}

async function submitTemplate(req, res, next) {
  try {
    const tpl = await service.submitTemplate(req.params.id, req.user.id, req.ip);
    success(res, tpl, 'Submitted for Meta review');
  } catch (err) { next(err); }
}

async function syncStatus(req, res, next) {
  try {
    const { status } = syncStatusSchema.parse(req.body);
    const tpl = await service.syncTemplateStatus(req.params.id, status, req.user.id, req.ip);
    success(res, tpl, `Status set to ${status}`);
  } catch (err) { next(err); }
}

async function testSend(req, res, next) {
  try {
    const { phone, variables } = testSendSchema.parse(req.body);
    const result = await service.testSend(req.params.id, phone, variables, req.user.id, req.ip);
    success(res, result, 'Test message sent');
  } catch (err) { next(err); }
}

async function listMessages(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.listMessages(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getStats(req, res, next) {
  try {
    success(res, await service.getWatiStats());
  } catch (err) { next(err); }
}

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  submitTemplate, syncStatus, testSend, listMessages, getStats,
};
