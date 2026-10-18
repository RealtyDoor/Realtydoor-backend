const { z } = require('zod');

// Mirrors prisma/schema/_base.prisma's SupportTicketStatus enum — the single
// source of truth for the status loop in listPartnerTickets' statusCounts
// (same pattern as contact.admin.validator.js's CONTACT_STATUSES).
const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'ANSWERED', 'RESOLVED', 'CLOSED'];

// Mirrors partners.validator.js's createSupportTicketSchema category list —
// not re-exported from there to avoid coupling the admin module's query
// validation to the partner-facing create schema's shape.
const TICKET_CATEGORIES = ['LEAD', 'ESCROW', 'LISTING', 'PAYMENT', 'GENERAL'];

const listPartnerTicketsQuerySchema = z.object({
  status:   z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  search:   z.string().trim().min(1).max(100).optional(),
});

const updatePartnerTicketSchema = z.object({
  status:     z.enum(TICKET_STATUSES).optional(),
  adminReply: z.string().min(1).max(5000).optional(),
}).refine((d) => d.status !== undefined || d.adminReply !== undefined, {
  message: 'At least one of status or adminReply is required',
});

module.exports = { listPartnerTicketsQuerySchema, updatePartnerTicketSchema, TICKET_STATUSES, TICKET_CATEGORIES };
