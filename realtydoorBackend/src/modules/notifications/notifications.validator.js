const { z } = require('zod');
const { roleEnum } = require('../../utils/validators');

const broadcastSchema = z.object({
  roles: z.array(roleEnum).optional(),
  title: z.string().min(1, 'title is required').max(200),
  message: z.string().min(1, 'message is required').max(1000),
  type: z.string().min(1).max(50).default('ANNOUNCEMENT'),
});

module.exports = { broadcastSchema };
