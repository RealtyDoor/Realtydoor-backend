const { success, created } = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const service = require('./checklist.service');
const {
  uploadChecklistDocumentSchema, rejectChecklistDocumentSchema,
  requestOwnerConfirmationSchema, recordOwnerConfirmationSchema,
} = require('./checklist.validator');

async function getChecklist(req, res, next) {
  try {
    success(res, await service.getChecklist(req.params.id));
  } catch (err) { next(err); }
}

// Partner-facing: scoped to their own listing. A separate function rather
// than a flag on the admin one, so the ownership check can never be left out
// by a future admin-route refactor that forgets to pass it.
async function getMyChecklist(req, res, next) {
  try {
    success(res, await service.getChecklist(req.params.id, req.user.id));
  } catch (err) { next(err); }
}

async function uploadChecklistDocument(req, res, next) {
  try {
    const { documentType } = uploadChecklistDocumentSchema.parse(req.body);
    const file = req.file;
    if (!file) throw new ApiError(400, 'No document file provided');
    const doc = await service.uploadChecklistDocument(req.params.id, req.user.id, { documentType, file });
    created(res, doc, 'Document uploaded');
  } catch (err) { next(err); }
}

async function verifyChecklistDocument(req, res, next) {
  try {
    const doc = await service.verifyChecklistDocument(req.params.docId, req.user.id, req.ip);
    success(res, doc, 'Document verified');
  } catch (err) { next(err); }
}

async function rejectChecklistDocument(req, res, next) {
  try {
    const { note } = rejectChecklistDocumentSchema.parse(req.body);
    const doc = await service.rejectChecklistDocument(req.params.docId, note, req.user.id, req.ip);
    success(res, doc, 'Document rejected');
  } catch (err) { next(err); }
}

// 4.2 — admin-recorded owner confirmation (no WATI automation this phase).
async function requestOwnerConfirmation(req, res, next) {
  try {
    const { requestedVia } = requestOwnerConfirmationSchema.parse(req.body);
    const confirmation = await service.requestOwnerConfirmation(
      req.params.id, req.params.mandateId, { requestedVia }, req.user.id,
    );
    created(res, confirmation, 'Owner confirmation requested');
  } catch (err) { next(err); }
}

async function recordOwnerConfirmation(req, res, next) {
  try {
    const { status, note } = recordOwnerConfirmationSchema.parse(req.body);
    const confirmation = await service.recordOwnerConfirmationResponse(
      req.params.confirmationId, { status, note }, req.user.id, req.ip,
    );
    success(res, confirmation, `Owner confirmation recorded as ${status}`);
  } catch (err) { next(err); }
}

module.exports = {
  getChecklist, getMyChecklist, uploadChecklistDocument, verifyChecklistDocument, rejectChecklistDocument,
  requestOwnerConfirmation, recordOwnerConfirmation,
};
