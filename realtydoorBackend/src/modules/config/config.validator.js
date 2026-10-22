const { z } = require('zod');

const upsertConfigSchema = z.object({
  value:       z.string().min(1).max(5000),
  description: z.string().max(500).optional(),
  isPublic:    z.boolean().optional(),
  // Required by the service for money settings (rates, fees, TDS, refunds).
  reason:      z.string().min(5).max(500).optional(),
});

module.exports = { upsertConfigSchema };
