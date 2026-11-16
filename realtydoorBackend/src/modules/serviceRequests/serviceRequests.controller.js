const prisma = require('../../lib/prisma');
const { created } = require('../../utils/ApiResponse');
const { z } = require('zod');
const { objectId } = require('../../utils/validators');
const ApiError = require('../../utils/ApiError');
const { notifyAdmins } = require('../../lib/notifications');
const { normalizePhone } = require('../../lib/phoneUtils');

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
    // Audit Nov 2026 (U3). Every id must be a service that exists, the phone is stored in the standard form (an unparseable one is
    // kept as typed), and admins are told, so a request does not sit unread.
    const ids = [...new Set(data.serviceIds)];
    const found = await prisma.service.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new ApiError(400, 'One of the services you chose does not exist', { code: 'SERVICE_NOT_FOUND' });
    data.serviceIds = ids;
    data.phone = normalizePhone(data.phone) || data.phone;
    const request = await prisma.serviceRequest.create({ data });
    await notifyAdmins({
      title: 'New service request',
      message: `${data.name} asked about ${ids.length} service${ids.length > 1 ? 's' : ''} (from ${data.source}).`,
      type: 'SERVICE_REQUEST_NEW',
    });
    created(res, { id: request.id }, 'We will get back to you shortly.');
  } catch (err) { next(err); }
}

module.exports = { submit };
