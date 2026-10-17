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

// Admin user-list filter — User.prisma has no `status` column (only
// isSuspended/phoneVerified/deletedAt), so this is a derived value, not a
// DB enum. Single source of truth for both the query validator
// (admin.validator.js) and the derivation itself (admin.service.js's
// getAllUsers), same reasoning as ROLES above. deletedAt is deliberately
// not a selectable status here — getAllUsers always excludes soft-deleted
// rows outright (deletedAt: { isSet: false }), so a "DELETED" tab would
// never show anything through this endpoint.
const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'PHONE_UNVERIFIED'];
const userStatusEnum = z.enum(USER_STATUSES, { errorMap: () => ({ message: `status must be one of: ${USER_STATUSES.join(', ')}` }) });

module.exports = { indianPhone, objectId, paginationSchema, ROLES, roleEnum, USER_STATUSES, userStatusEnum };
