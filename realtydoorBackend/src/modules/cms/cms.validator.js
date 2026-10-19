const { z } = require('zod');

// TESTIMONIAL and NRI_GUIDE are in the Prisma ContentBlock type list and in the admin CMS tabs, but were missing here, so
// creating them in admin and the public testimonials fetch (/blog?type=TESTIMONIAL) were both rejected with a 400.
const CONTENT_TYPES = ['BLOG_POST', 'FAQ', 'BANNER', 'ANNOUNCEMENT', 'PAGE', 'TESTIMONIAL', 'NRI_GUIDE'];

const createContentSchema = z.object({
  slug:        z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers and hyphens only'),
  type:        z.enum(CONTENT_TYPES, { errorMap: () => ({ message: `type must be one of: ${CONTENT_TYPES.join(', ')}` }) }),
  title:       z.string().min(2).max(200),
  body:        z.string().min(1).optional(),
  metaTitle:   z.string().max(200).optional(),
  metaDesc:    z.string().max(500).optional(),
  isPublished: z.boolean().optional().default(false),
  publishedAt: z.string().datetime().optional(),
}).passthrough();

const updateContentSchema = createContentSchema.partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided' }
);

module.exports = { createContentSchema, updateContentSchema, CONTENT_TYPES };
