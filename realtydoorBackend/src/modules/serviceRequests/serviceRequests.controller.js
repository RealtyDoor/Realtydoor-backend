const prisma = require('../../lib/prisma');
const { created } = require('../../utils/ApiResponse');
const { z } = require('zod');
const { objectId } = require('../../utils/validators');

const serviceRequestSchema = z.object({
  name:       z.string().min(2).max(100),
  phone:      z.string().min(8).max(20),
  email:      z.string().email().optional(),
  serviceIds: z.array(objectId).min(1, 'At least one service is required'),
  note:       z.string().max(1000).optional(),
  source:     z.string().min(1).max(100),
});

async function submit(req, res, next) {
  try {
    const data = serviceRequestSchema.parse(req.body);
    const request = await prisma.serviceRequest.create({ data });
    created(res, { id: request.id }, 'We will get back to you shortly.');
  } catch (err) { next(err); }
}

module.exports = { submit };
