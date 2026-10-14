const { z } = require('zod');
const { objectId } = require('../../utils/validators');

// BE-7 — serviceId was previously read unvalidated (services.controller.js),
// so a missing/malformed one reached Prisma directly and 500'd instead of a
// clean 400.
const createOrderSchema = z.object({
  serviceId: objectId,
});

// L4 fix — mirrors prisma/schema/service.prisma's category comment
// (MAINTENANCE | CONSTRUCTION | LEGAL | LOAN | VALUATION). Previously
// unvalidated: a typo'd ?category silently returned an empty list instead
// of a clear error.
const SERVICE_CATEGORIES = ['MAINTENANCE', 'CONSTRUCTION', 'LEGAL', 'LOAN', 'VALUATION'];

module.exports = { createOrderSchema, SERVICE_CATEGORIES };
