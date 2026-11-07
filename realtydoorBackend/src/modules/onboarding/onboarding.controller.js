const { z } = require('zod');
const { success, created } = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const { parsePagination, paginate } = require('../../utils/pagination');
const { createAuditLog } = require('../../lib/auditLog');
const prisma = require('../../lib/prisma');
const { deleteFile } = require('../../lib/fileUpload');
const f = require('../../lib/onboardingForm');
const service = require('./onboarding.service');

const phone = z.string().trim().min(8).max(20).regex(/^[0-9+()\-\s]+$/, 'Enter a valid phone number');
const optional = (schema) => schema.optional().or(z.literal('')).or(z.null());

const createSchema = z.object({
  propertyType: z.enum(f.ONBOARDING_TYPES),
  title: optional(z.string().trim().max(120)),
  contactName: z.string().trim().min(2).max(100),
  contactPhone: optional(phone),
  contactEmail: optional(z.string().trim().email().max(150)),
  contactRole: optional(z.enum(f.CONTACT_ROLES)),
  expiresInDays: z.number().int().min(1).max(f.MAX_EXPIRY_DAYS).optional(),
});

const updateSchema = z.object({
  propertyType: z.enum(f.ONBOARDING_TYPES).optional(),
  title: optional(z.string().trim().max(120)),
  contactName: z.string().trim().min(2).max(100).optional(),
  contactPhone: optional(phone),
  contactEmail: optional(z.string().trim().email().max(150)),
  contactRole: optional(z.enum(f.CONTACT_ROLES)),
  status: z.enum(f.STATUSES).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  convertedToType: optional(z.string().trim().max(40)),
  convertedToId: optional(z.string().trim().max(60)),
});

const convertSchema = z.object({ partnerId: z.string().regex(/^[a-f\d]{24}$/i, 'Choose a partner'), createProject: z.boolean().optional() });
const noteSchema = z.object({ text: z.string().trim().min(1).max(2000) });
const reopenSchema = z.object({ expiresInDays: z.number().int().min(1).max(f.MAX_EXPIRY_DAYS).optional() });

// Never cache anything that is reached through a private link.
const noStore = (res) => res.set('Cache-Control', 'private, no-store');

// ─── Sender ───────────────────────────────────────────────────────────────────

/** Runs before the file upload: a bad link must not be able to put files in the bucket. */
async function requireLink(req, res, next) {
  try {
    const { row } = await service.loadByToken(req.params.token, { needEditable: true });
    if (req.params.docKey) f.cleanDocKey(req.params.docKey);
    req.onboarding = row;
    next();
  } catch (err) { next(err); }
}

async function senderGet(req, res, next) {
  try { noStore(res); success(res, await service.senderGet(req.params.token)); } catch (err) { next(err); }
}
async function senderSave(req, res, next) {
  try { noStore(res); success(res, await service.senderSave(req.params.token, req.body), 'Saved'); } catch (err) { next(err); }
}
async function senderSubmit(req, res, next) {
  try { noStore(res); success(res, await service.senderSubmit(req.params.token, req.body), 'Thank you. We have your details.'); } catch (err) { next(err); }
}
async function senderUpload(req, res, next) {
  try {
    if (!req.file) throw new ApiError(400, 'No file received.');
    noStore(res);
    created(res, await service.attachDocument(req.onboarding, req.params.docKey, req.file, 'sender'), 'File added');
  } catch (err) { next(err); }
}
async function senderRemoveFile(req, res, next) {
  try { noStore(res); await service.removeDocument(req.onboarding, req.params.docId); success(res, null, 'File removed'); } catch (err) { next(err); }
}

// ─── Admin ────────────────────────────────────────────────────────────────────

async function list(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.adminList(req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}
async function get(req, res, next) { try { success(res, await service.adminGet(req.params.id)); } catch (err) { next(err); } }
async function create(req, res, next) {
  try { created(res, await service.adminCreate(req.user.id, createSchema.parse(req.body), req.ip), 'Link created'); } catch (err) { next(err); }
}
async function update(req, res, next) {
  try { success(res, await service.adminUpdate(req.user.id, req.params.id, updateSchema.parse(req.body), req.ip), 'Saved'); } catch (err) { next(err); }
}
async function addNote(req, res, next) {
  try { success(res, await service.adminAddNote(req.user.id, req.params.id, noteSchema.parse(req.body).text, req.ip), 'Note added'); } catch (err) { next(err); }
}
async function reopen(req, res, next) {
  try { success(res, await service.adminReopen(req.user.id, req.params.id, reopenSchema.parse(req.body || {}).expiresInDays, req.ip), 'New link created'); } catch (err) { next(err); }
}
async function revoke(req, res, next) {
  try { success(res, await service.adminRevoke(req.user.id, req.params.id, req.ip), 'Link switched off'); } catch (err) { next(err); }
}
// Pure check (no database) that runs before the file is read, so a bad document name cannot put anything in the bucket.
function validateDocKey(req, res, next) {
  try { f.cleanDocKey(req.params.docKey); next(); } catch (err) { next(err); }
}
async function findForAdmin(id) {
  const row = await prisma.onboardingRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Onboarding request not found');
  return row;
}
async function adminUpload(req, res, next) {
  try {
    if (!req.file) throw new ApiError(400, 'No file received.');
    let row;
    try { row = await findForAdmin(req.params.id); } catch (e) { if (req.file.s3Key) deleteFile(req.file.s3Key).catch(() => {}); throw e; }
    const doc = await service.attachDocument(row, req.params.docKey, req.file, 'admin');
    createAuditLog({ adminId: req.user.id, action: 'ONBOARDING_FILE_ADDED', targetType: 'OnboardingRequest', targetId: String(req.params.id), ipAddress: req.ip }).catch(() => {});
    created(res, doc, 'File added');
  } catch (err) { next(err); }
}
async function adminRemoveFile(req, res, next) {
  try {
    await service.removeDocument(await findForAdmin(req.params.id), req.params.docId);
    createAuditLog({ adminId: req.user.id, action: 'ONBOARDING_FILE_REMOVED', targetType: 'OnboardingRequest', targetId: String(req.params.id), ipAddress: req.ip }).catch(() => {});
    success(res, null, 'File removed');
  } catch (err) { next(err); }
}

async function listingPreview(req, res, next) { try { success(res, await service.listingPreview(req.params.id)); } catch (err) { next(err); } }
async function convert(req, res, next) {
  try { created(res, await service.convertToListing(req.user.id, req.params.id, convertSchema.parse(req.body), req.ip), 'Listing created and sent for review'); } catch (err) { next(err); }
}

module.exports = {
  listingPreview, convert,
  requireLink, senderGet, senderSave, senderSubmit, senderUpload, senderRemoveFile,
  list, get, create, update, addNote, reopen, revoke, validateDocKey, adminUpload, adminRemoveFile,
  createSchema, updateSchema, convertSchema,
};
