const { z } = require('zod');
const f = require('../../lib/leadSales');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Not a valid id');

const updateSalesSchema = z.object({
  salesStage: z.enum(f.STAGES).optional(),
  temperature: z.enum(f.TEMPERATURES).nullable().optional(),
  ownerStaffId: objectId.nullable().optional(),
  nextFollowUpAt: z.string().datetime({ offset: true }).nullable().optional(),
  notQualifiedReason: z.string().trim().max(500).optional(),
});

const addNoteSchema = z.object({
  kind: z.enum(f.NOTE_KINDS).default('NOTE'),
  text: z.string().trim().min(1, 'Write something first').max(2000),
  nextFollowUpAt: z.string().datetime({ offset: true }).nullable().optional(),
});

module.exports = { updateSalesSchema, addNoteSchema };
