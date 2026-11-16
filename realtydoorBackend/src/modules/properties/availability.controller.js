const { z } = require('zod');
const { success } = require('../../utils/ApiResponse');
const service = require('./availability.service');

const availabilitySchema = z.object({
  availability: z.enum(['AVAILABLE', 'ON_HOLD', 'SOLD', 'RENTED']),
  note: z.string().trim().max(300).optional(),
});

async function set(req, res, next) {
  try {
    const { availability, note } = availabilitySchema.parse(req.body);
    const r = await service.setAvailability(req.params.id, availability, { note, actor: { id: req.user.id, role: req.user.role }, ip: req.ip });
    success(res, r, r.changed ? `Listing marked ${availability.replace('_', ' ').toLowerCase()}` : 'No change');
  } catch (err) { next(err); }
}

module.exports = { set, availabilitySchema };
