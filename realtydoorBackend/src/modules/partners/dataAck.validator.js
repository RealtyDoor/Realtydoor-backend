const { z } = require('zod');
const { objectId } = require('../../utils/validators');

const recordAckSchema = z.object({
  type: z.enum(['LEAD_DATA_HANDLING', 'POST_OTP_RESTRICTED_USE']),
  version: z.string().min(1).max(50),
  leadId: objectId.optional(),
});

module.exports = { recordAckSchema };
