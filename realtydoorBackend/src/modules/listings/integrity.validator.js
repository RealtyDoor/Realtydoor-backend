const { z } = require('zod');
const { objectId, indianPhone } = require('../../utils/validators');

// Format only, not a checksum: PAN is AAAAA9999A. Validated so a typo cannot
// quietly defeat the agent/owner PAN comparison in 4.4 by never matching.
const panNumber = z.string()
  .transform((s) => s.replace(/\s+/g, '').toUpperCase())
  .refine((s) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s), 'PAN must be in the format AAAAA9999A');

const createMandateSchema = z.object({
  // Defaults to the listing's own partner when omitted.
  partnerId:  objectId.optional(),
  ownerName:  z.string().min(2).max(120),
  ownerPhone: indianPhone,
  ownerEmail: z.string().email().optional(),
  ownerPan:   panNumber.optional(),
  startDate:  z.string().datetime({ message: 'startDate must be an ISO datetime' }),
  expiryDate: z.string().datetime({ message: 'expiryDate must be an ISO datetime' }),
  documentUrl: z.string().url().optional(),
  note:       z.string().max(500).optional(),
}).refine(
  (d) => new Date(d.expiryDate) > new Date(d.startDate),
  { message: 'expiryDate must be after startDate', path: ['expiryDate'] }
);

const revokeMandateSchema = z.object({
  // The partner is told this verbatim, so it has to say something.
  reason: z.string().min(5, 'A revocation reason of at least 5 characters is required').max(500),
});

const resolveConflictSchema = z.object({
  status: z.enum(['RESOLVED', 'DISMISSED']),
  // Dismissing means declaring the detector wrong, and resolving means
  // declaring action was taken elsewhere. Either way the next person needs to
  // know which, and why, so a note is mandatory in both cases.
  resolution: z.string().min(5, 'A resolution note of at least 5 characters is required').max(1000),
});

module.exports = { createMandateSchema, revokeMandateSchema, resolveConflictSchema };
