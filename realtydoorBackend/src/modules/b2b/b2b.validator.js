const { z } = require('zod');

const expressInterestSchema = z.object({
  message: z.string().max(1000).optional(),
});

const updateConnectionSchema = z.object({
  status: z.enum(['INTERESTED', 'CONNECTED', 'CLOSED']),
});

module.exports = { expressInterestSchema, updateConnectionSchema };
