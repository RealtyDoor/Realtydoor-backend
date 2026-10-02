const { z } = require('zod');

const indianPhone = z
  .string()
  .regex(/^\+91[6-9]\d{9}$/, 'Must be a valid Indian mobile number (+91XXXXXXXXXX)');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

// Single source of truth for the three user roles — mirrors prisma/schema
// _base.prisma's `enum Role`. Previously duplicated as separate hardcoded
// ['USER', 'PARTNER', 'ADMIN'] literals in admin.service.js, admin.validator.js,
// and notifications.validator.js, which could silently drift apart if a role
// were ever added, renamed, or removed in only one of them.
const ROLES = ['USER', 'PARTNER', 'ADMIN'];
const roleEnum = z.enum(ROLES, { errorMap: () => ({ message: `role must be one of: ${ROLES.join(', ')}` }) });

module.exports = { indianPhone, objectId, paginationSchema, ROLES, roleEnum };
