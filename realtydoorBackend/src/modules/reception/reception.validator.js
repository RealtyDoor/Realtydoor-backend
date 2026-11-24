const { z } = require('zod');
const { objectId } = require('../../utils/validators');
const { phoneField } = require('../../lib/phoneUtils');

// Multipart form fields arrive as strings; "true"/"on" from a checkbox count as yes.
const yes = z.preprocess((v) => v === true || v === 'true' || v === 'on', z.literal(true, { error: 'The buyer must agree to the photo' }));
const blankToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const searchSchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(60),
});

const recordVisitSchema = z.object({
  leadId:        z.preprocess(blankToUndefined, objectId.optional()),
  code:          z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{6}$/, 'The visit code has 6 digits').optional()),
  // A walk-in: the buyer has no booking. Name and phone are required then.
  walkIn:        z.preprocess((v) => v === true || v === 'true', z.boolean()).default(false),
  buyerName:     z.preprocess(blankToUndefined, z.string().trim().min(2).max(100).optional()),
  buyerPhone:    z.preprocess(blankToUndefined, phoneField.optional()),
  interest:      z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
  hostedByType:  z.enum(['ASSIGNED_PARTNER', 'OTHER_PERSON']),
  hostedByName:  z.preprocess(blankToUndefined, z.string().trim().min(2).max(100).optional()),
  hostedByPhone: z.preprocess(blankToUndefined, phoneField.optional()),
  note:          z.preprocess(blankToUndefined, z.string().trim().max(500).optional()),
  visitedAt:     z.preprocess(blankToUndefined, z.coerce.date().optional()),
  photoConsent:  yes,
}).superRefine((d, ctx) => {
  if (d.walkIn) {
    if (!d.buyerName) ctx.addIssue({ code: 'custom', path: ['buyerName'], message: "Enter the buyer's name" });
    if (!d.buyerPhone) ctx.addIssue({ code: 'custom', path: ['buyerPhone'], message: "Enter the buyer's phone" });
    if (d.code) ctx.addIssue({ code: 'custom', path: ['code'], message: 'A walk-in has no visit code' });
  } else if (!d.leadId) {
    ctx.addIssue({ code: 'custom', path: ['leadId'], message: 'Choose the buyer first' });
  }
  if (d.hostedByType === 'OTHER_PERSON' && !d.hostedByName) {
    ctx.addIssue({ code: 'custom', path: ['hostedByName'], message: 'Enter who hosted the visit' });
  }
});

const myVisitsSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const adminListSchema = z.object({
  from:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  staffId:  objectId.optional(),
  partnerId: objectId.optional(),
  verified: z.enum(['yes', 'no']).optional(),
  leadId:   objectId.optional(),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(50).default(50),
});

module.exports = { searchSchema, recordVisitSchema, myVisitsSchema, adminListSchema };
