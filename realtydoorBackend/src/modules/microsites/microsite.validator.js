const { z } = require('zod');
const { objectId } = require('../../utils/validators');

// Single constant so it's easy to extend (spec: add www/app/mail/static
// later if subdomains are ever launched — not done now, path-based only).
const RESERVED_SLUGS = ['admin', 'api', 'new', 'edit', 'search', 'properties', 'partners', 'user'];

// Lowercase BEFORE validating — "Villa-X" and "villa-x" must be the same
// slug, not "Villa-X" rejected for having uppercase letters. `.pipe()` runs
// the length/pattern/reserved-word checks against the already-lowercased
// value, not the original input.
const slugSchema = z.string()
  .trim()
  .transform((s) => s.toLowerCase())
  .pipe(
    z.string()
      .min(3, 'Slug must be 3-60 characters')
      .max(60, 'Slug must be 3-60 characters')
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, digits and single hyphens only (e.g. whitefield-3bhk-villa)')
      .refine((s) => !RESERVED_SLUGS.includes(s), { error: (issue) => `"${issue.input}" is a reserved word and can't be used as a slug` })
  );

const createMicrositeSchema = z.object({
  propertyId: objectId,
  slug: slugSchema,
});

const updateMicrositeSchema = z.object({
  slug: slugSchema.optional(),
  enabled: z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field (slug or enabled) must be provided' });

module.exports = { createMicrositeSchema, updateMicrositeSchema, slugSchema, RESERVED_SLUGS };
