const { z } = require('zod');

const uploadChecklistDocumentSchema = z.object({
  documentType: z.enum(['SALE_DEED', 'ENCUMBRANCE_CERTIFICATE', 'KHATA', 'SOCIETY_NOC']),
});

const rejectChecklistDocumentSchema = z.object({
  // Shown to the partner verbatim as the reason to fix and re-upload.
  note: z.string().min(5, 'A rejection reason of at least 5 characters is required').max(500),
});

// 4.2 is admin-recorded, not WhatsApp-automated this phase — requestedVia is
// free text describing however contact was actually made, not a channel this
// backend drives, so it is optional and unconstrained in form.
const requestOwnerConfirmationSchema = z.object({
  requestedVia: z.string().max(200).optional(),
});

const recordOwnerConfirmationSchema = z.object({
  status: z.enum(['CONFIRMED', 'DENIED']),
  // The next person reading this needs to know how contact was actually made
  // and what the owner said, not just a yes/no.
  note: z.string().min(5, 'A note of at least 5 characters is required').max(1000),
});

module.exports = {
  uploadChecklistDocumentSchema, rejectChecklistDocumentSchema,
  requestOwnerConfirmationSchema, recordOwnerConfirmationSchema,
};
