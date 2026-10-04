const { z } = require('zod');

const createBuilderInvoiceSchema = z.object({
  unitId: z.string().min(1),
});

const disputeBuilderInvoiceSchema = z.object({
  reason: z.string().min(5).max(500),
});

const listBuilderInvoicesSchema = z.object({
  builderId: z.string().optional(),
  projectId: z.string().optional(),
  status: z.enum(['PENDING', 'INVOICED', 'COLLECTED', 'DISPUTED']).optional(),
});

module.exports = { createBuilderInvoiceSchema, disputeBuilderInvoiceSchema, listBuilderInvoicesSchema };
