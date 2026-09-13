const prisma = require('../../lib/prisma');
const { created } = require('../../utils/ApiResponse');
const { z } = require('zod');

const nriLeadSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z.string().min(8).max(20),
  area: z.string().min(1).max(200),
  homeType: z.string().min(1).max(100),
  bedrooms: z.string().min(1).max(50),
  timeline: z.string().min(1).max(100),
  budget: z.string().min(1).max(100),
});

async function submit(req, res, next) {
  try {
    const data = nriLeadSchema.parse(req.body);
    const lead = await prisma.nriLead.create({ data });
    created(res, { id: lead.id }, 'We will get back to you shortly.');
  } catch (err) { next(err); }
}

module.exports = { submit };
