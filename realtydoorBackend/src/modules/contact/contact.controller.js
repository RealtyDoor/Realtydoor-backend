const prisma = require('../../lib/prisma');
const { created } = require('../../utils/ApiResponse');
const { z } = require('zod');

const contactSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  subject: z.string().min(3).max(200),
  message: z.string().min(10).max(1000),
});

async function submit(req, res, next) {
  try {
    const data = contactSchema.parse(req.body);
    const msg = await prisma.contactMessage.create({
      data: { ...data, userId: req.user?.id || null, role: req.user?.role || null },
    });
    created(res, { id: msg.id }, 'Message received. We will get back to you shortly.');
  } catch (err) { next(err); }
}

module.exports = { submit };
