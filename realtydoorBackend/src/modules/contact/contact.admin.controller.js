const { success, created } = require('../../utils/ApiResponse');
const service = require('./contact.admin.service');
const {
  replySchema, setStatusSchema, templateSchema, updateTemplateSchema, composeSchema,
} = require('./contact.admin.validator');

async function getThread(req, res, next) {
  try {
    success(res, await service.getMessageThread(req.params.id));
  } catch (err) { next(err); }
}

async function reply(req, res, next) {
  try {
    const data = replySchema.parse(req.body);
    const result = await service.replyToMessage(req.params.id, data, req.user.id, req.ip);
    created(res, result, result.failures.length
      ? `Reply sent over ${result.channels.join(', ')}; some channels failed`
      : `Reply sent over ${result.channels.join(', ')}`);
  } catch (err) { next(err); }
}

async function setStatus(req, res, next) {
  try {
    const { status } = setStatusSchema.parse(req.body);
    const msg = await service.setStatus(req.params.id, status, req.user.id, req.ip);
    success(res, msg, `Marked ${status}`);
  } catch (err) { next(err); }
}

async function listTemplates(req, res, next) {
  try {
    success(res, await service.listTemplates());
  } catch (err) { next(err); }
}

async function createTemplate(req, res, next) {
  try {
    created(res, await service.createTemplate(templateSchema.parse(req.body)), 'Template created');
  } catch (err) { next(err); }
}

async function updateTemplate(req, res, next) {
  try {
    success(res, await service.updateTemplate(req.params.id, updateTemplateSchema.parse(req.body)), 'Template updated');
  } catch (err) { next(err); }
}

async function deleteTemplate(req, res, next) {
  try {
    success(res, await service.deleteTemplate(req.params.id), 'Template deleted');
  } catch (err) { next(err); }
}

async function compose(req, res, next) {
  try {
    const data = composeSchema.parse(req.body);
    const result = await service.compose(data, req.user.id, req.ip);
    created(res, result, `Message sent over ${result.channels.join(', ')}`);
  } catch (err) { next(err); }
}

module.exports = {
  getThread, reply, setStatus,
  listTemplates, createTemplate, updateTemplate, deleteTemplate, compose,
};
