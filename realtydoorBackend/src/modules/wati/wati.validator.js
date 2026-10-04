const { z } = require('zod');
const { phoneField } = require('../../lib/phoneUtils');

const TEMPLATE_STATUSES = ['APPROVED', 'PENDING_META', 'REJECTED', 'DRAFT'];
const META_CATEGORIES   = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
const RECIPIENTS        = ['BUYER', 'PARTNER', 'ADMIN'];

// `name` must match the template registered with Meta exactly — lib/wati.js
// passes it straight through as template_name. Restricted to WhatsApp's own
// allowed shape (lowercase, digits, underscores) so a typo fails here rather
// than as an opaque WATI error at send time.
const createTemplateSchema = z.object({
  name:         z.string().min(2).max(80).regex(/^[a-z0-9_]+$/, 'name must be lowercase letters, digits and underscores only'),
  displayName:  z.string().min(2).max(120),
  eventTrigger: z.string().max(60).optional(),
  recipient:    z.enum(RECIPIENTS).optional(),
  metaCategory: z.enum(META_CATEGORIES).optional(),
  language:     z.string().min(2).max(10).default('en'),
  body:         z.string().min(1).max(2000),
  variables:    z.array(z.string().min(1).max(40)).max(20).default([]),
  status:       z.enum(TEMPLATE_STATUSES).default('DRAFT'),
});

// `name` is omitted deliberately: renaming would silently decouple the row
// from the Meta template every past send used, and from its message-log
// history. Delete and recreate instead.
const updateTemplateSchema = createTemplateSchema
  .omit({ name: true, status: true })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

const syncStatusSchema = z.object({
  status: z.enum(TEMPLATE_STATUSES),
});

const testSendSchema = z.object({
  phone:     phoneField,
  // Keyed by variable name, matching WatiTemplate.variables. Values are
  // coerced to strings at send time.
  variables: z.record(z.union([z.string(), z.number()])).default({}),
});

module.exports = {
  createTemplateSchema, updateTemplateSchema, syncStatusSchema, testSendSchema,
  TEMPLATE_STATUSES, META_CATEGORIES, RECIPIENTS,
};
