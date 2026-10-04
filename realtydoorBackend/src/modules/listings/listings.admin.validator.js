const { z } = require('zod');

// 4.9 — approving is allowed without a note, but overriding a conflict is not
// silent: force only takes effect together with a reason, so the edit log and
// audit trail always say why a later change was overwritten.
const approveChangeRequestSchema = z.object({
  note: z.string().max(500).optional(),
  force: z.boolean().optional(),
}).refine(
  (d) => !d.force || (d.note && d.note.trim().length >= 5),
  { message: 'A note of at least 5 characters is required when force is true, to record why a later change was overwritten', path: ['note'] }
);

const rejectChangeRequestSchema = z.object({
  // The partner is told the reason verbatim, so an empty rejection is useless
  // to them and is refused here rather than sent as a blank notification.
  note: z.string().min(5, 'A rejection reason of at least 5 characters is required').max(500),
});

module.exports = { approveChangeRequestSchema, rejectChangeRequestSchema };
