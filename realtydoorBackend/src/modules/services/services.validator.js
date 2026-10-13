const { z } = require('zod');
const { objectId } = require('../../utils/validators');

// BE-7 — serviceId was previously read unvalidated (services.controller.js),
// so a missing/malformed one reached Prisma directly and 500'd instead of a
// clean 400.
const createOrderSchema = z.object({
  serviceId: objectId,
});

module.exports = { createOrderSchema };
