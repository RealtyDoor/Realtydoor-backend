const { z } = require('zod');
const { phoneField } = require('../../lib/phoneUtils');

const CONTACT_STATUSES = ['NEW', 'REPLIED', 'RESOLVED', 'SPAM'];
const CONTACT_SOURCES  = ['CONTACT_FORM', 'PARTNER_SUPPORT', 'USER_SUPPORT', 'PRESS', 'OUTBOUND'];

const replySchema = z.object({
  body:    z.string().min(1).max(5000),
  // Defaults to "Re: <original subject>" in the service when omitted.
  subject: z.string().min(1).max(200).optional(),
  // Opt-in: WhatsApp needs an approved template and costs money, so it is
  // never sent implicitly alongside the email.
  alsoWhatsapp: z.boolean().optional().default(false),
});

const setStatusSchema = z.object({
  status: z.enum(CONTACT_STATUSES),
});

const templateSchema = z.object({
  name:     z.string().min(2).max(80),
  subject:  z.string().min(1).max(200),
  body:     z.string().min(1).max(5000),
  isActive: z.boolean().optional().default(true),
});

const updateTemplateSchema = templateSchema.partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided' },
);

const composeSchema = z.object({
  name:    z.string().min(2).max(100),
  email:   z.string().email().optional(),
  phone:   phoneField.optional(),
  subject: z.string().min(3).max(200),
  body:    z.string().min(1).max(5000),
  alsoWhatsapp: z.boolean().optional().default(false),
}).refine((d) => d.email || d.phone, {
  message: 'Provide an email or a phone to send to',
  path: ['email'],
});

module.exports = {
  replySchema, setStatusSchema, templateSchema, updateTemplateSchema, composeSchema,
  CONTACT_STATUSES, CONTACT_SOURCES,
};
