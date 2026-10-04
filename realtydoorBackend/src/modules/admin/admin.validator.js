const { z } = require('zod');
const { objectId, roleEnum } = require('../../utils/validators');
const { phoneField } = require('../../lib/phoneUtils');
const { ADMIN_PERMISSION_SCOPES, ADMIN_STAFF_ROLES } = require('../../utils/adminPermissions');

// 6.4a — admin logs a lead that came in off-platform. Either propertyId (a
// live listing) or propertyInterest (free text, when the property isn't
// listed) must be present; refined below rather than made mutually exclusive,
// since an admin may legitimately have both a listing and extra context.
const createLeadSchema = z.object({
  buyerName:        z.string().min(2).max(100),
  buyerPhone:       phoneField,
  buyerEmail:       z.string().email().optional(),
  source:           z.enum(['PHONE', 'WALK_IN', 'REFERRAL', 'EMAIL', 'OTHER']),
  propertyId:       objectId.optional(),
  propertyInterest: z.string().max(300).optional(),
  budget:           z.string().max(100).optional(),
  note:             z.string().max(1000).optional(),
  partnerId:        objectId.optional(),
  // docs-backend-gaps-handoff.md #4 — admin is attesting consent on behalf of
  // a buyer who never interacted with the platform directly, same as the
  // partner self-sourced path. Must be the literal boolean true, not merely
  // truthy — a checkbox that was left unchecked.
  consent: z.literal(true, { errorMap: () => ({ message: 'Buyer consent is required to log this lead' }) }),
}).refine((d) => d.propertyId || d.propertyInterest, {
  message: 'Provide either propertyId (a live listing) or propertyInterest (free text)',
  path: ['propertyId'],
});

const confirmLeadSchema = z.object({
  partnerId: objectId.optional(),
});

const rejectLeadSchema = z.object({
  reason: z.string().min(5, 'Please provide a meaningful reason (min 5 characters)').max(500),
});

const assignLeadSchema = z.object({
  partnerId: objectId,
});

const rejectPropertySchema = z.object({
  note: z.string().min(5, 'Rejection note must be at least 5 characters').max(500),
});

const verifyKycSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT'], {
    errorMap: () => ({ message: 'action must be APPROVE or REJECT' }),
  }),
  note: z.string().min(5).max(500).optional(),
}).refine(
  (data) => data.action === 'APPROVE' || !!data.note,
  { message: 'Rejection note is required when rejecting KYC', path: ['note'] }
);

const updateLoanStatusSchema = z.object({
  status: z.enum([
    'DOCUMENTS_PENDING', 'DOCUMENTS_SUBMITTED', 'DOCUMENTS_VERIFIED',
    'SENT_TO_BANK', 'AWAITING_SANCTION', 'SANCTIONED', 'DISBURSED', 'REJECTED',
  ], { errorMap: () => ({ message: 'Invalid loan status' }) }),
  adminNote: z.string().max(1000).optional(),
  interestRatePct:   z.number().positive().max(100).optional(),
  tenureMonths:      z.number().int().positive().optional(),
  emiPaise:          z.number().int().positive().optional(),
  sanctionLetterUrl: z.string().url().optional(),
});

const changeUserRoleSchema = z.object({
  role: roleEnum,
});

// 4.14 — the visibility choice on the approve modal. All optional, so an
// approve with no body keeps the previous behaviour: public and searchable,
// not featured.
const approvePropertySchema = z.object({
  visibility: z.object({
    searchable:       z.boolean().optional(),
    homepageFeatured: z.boolean().optional(),
  }).optional(),
}).optional().default({});

// 4.15 — the checklist of fixes. At least one item, because a change request
// with nothing in it tells the partner nothing.
const requestPropertyChangesSchema = z.object({
  items: z.array(z.string().min(3, 'Each item must be at least 3 characters').max(300))
    .min(1, 'At least one requested change is required')
    .max(20, 'At most 20 requested changes'),
  note: z.string().max(1000).optional(),
});

// R9 — the checklist of specific documents admin wants. dueInDays is
// optional and purely informational, not enforced server-side.
const requestKycDocumentsSchema = z.object({
  items: z.array(z.string().min(3, 'Each item must be at least 3 characters').max(300))
    .min(1, 'At least one requested document is required')
    .max(20, 'At most 20 requested documents'),
  note: z.string().max(1000).optional(),
  dueInDays: z.number().int().positive().max(90).optional(),
});

const editPropertySchema = z.object({
  title:         z.string().min(5).max(200).optional(),
  description:   z.string().max(5000).optional(),
  price:         z.number().positive().optional(),
  bhk:           z.number().int().min(1).optional(),
  city:          z.string().optional(),
  locality:      z.string().optional(),
  pincode:       z.string().optional(),
  area:          z.number().positive().optional(),
  publishStatus: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED']).optional(),
  rejectionNote: z.string().max(500).optional(),
}).passthrough().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' }
);

const updateTicketSchema = z.object({
  status:      z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(),
  vendorName:  z.string().min(2).max(100).optional(),
  vendorPhone: z.string().min(5).max(20).optional(),
}).refine(
  (d) => d.status !== undefined || d.vendorName !== undefined || d.vendorPhone !== undefined,
  { message: 'At least one of status, vendorName, or vendorPhone must be provided' },
);

// 7.2 — a real vendor dispatch, distinct from updateTicketSchema's free-text
// quick edit above.
const dispatchTicketSchema = z.object({
  vendorId: z.string().min(1),
  scheduledSlot: z.string().datetime().optional(),
  tenantContactName: z.string().min(2).max(100).optional(),
  tenantContactPhone: z.string().min(5).max(20).optional(),
  quotedChargeAmount: z.number().min(0).optional(),
});

// 7.5
const resolveTicketSchema = z.object({
  resolutionUrls: z.array(z.string().url()).max(10).optional(),
  visitCharge: z.number().min(0).optional(),
  partsCharge: z.number().min(0).optional(),
  note: z.string().max(1000).optional(),
});

// 7.8
const linkTicketToDealSchema = z.object({
  leadId: z.string().min(1),
});

const SERVICE_CATEGORIES = ['MAINTENANCE', 'CONSTRUCTION', 'LEGAL', 'LOAN', 'VALUATION'];

const createServiceSchema = z.object({
  name:        z.string().min(2).max(100),
  shortDesc:   z.string().min(5).max(200),
  description: z.string().min(10).max(5000),
  price:       z.number().positive(),
  category:    z.enum(SERVICE_CATEGORIES),
  features:    z.array(z.string().min(1)).min(1).max(20),
  isActive:    z.boolean().default(true),
  sortOrder:   z.number().int().min(0).default(0),
  imageUrl:    z.string().url().optional(),
});

const updateServiceSchema = z.object({
  name:        z.string().min(2).max(100).optional(),
  shortDesc:   z.string().min(5).max(200).optional(),
  description: z.string().min(10).max(5000).optional(),
  price:       z.number().positive().optional(),
  category:    z.enum(SERVICE_CATEGORIES).optional(),
  features:    z.array(z.string().min(1)).min(1).max(20).optional(),
  isActive:    z.boolean().optional(),
  sortOrder:   z.number().int().min(0).optional(),
  imageUrl:    z.string().url().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' },
);

const verifyDocumentSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT'], {
    errorMap: () => ({ message: 'action must be APPROVE or REJECT' }),
  }),
  note: z.string().min(5).max(500).optional(),
}).refine(
  (d) => d.action === 'APPROVE' || !!d.note,
  { message: 'Rejection note is required when rejecting a document', path: ['note'] },
);

const createTeamMemberSchema = z.object({
  name:      z.string().min(2).max(100),
  title:     z.string().min(2).max(100),
  email:     z.string().email().optional(),
  phone:     z.string().optional(),
  avatarUrl: z.string().url().optional(),
  isActive:  z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

const updateTeamMemberSchema = z.object({
  name:      z.string().min(2).max(100).optional(),
  title:     z.string().min(2).max(100).optional(),
  email:     z.string().email().optional(),
  phone:     z.string().optional(),
  avatarUrl: z.string().url().optional(),
  isActive:  z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
}).refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided' },
);

const createVendorSchema = z.object({
  name:     z.string().min(2).max(100),
  phone:    z.string().min(5).max(20),
  email:    z.string().email().optional(),
  category: z.enum(['PLUMBING', 'ELECTRICAL', 'PAINTING', 'GENERAL', 'CARPENTRY', 'OTHER']),
  city:     z.string().max(100).optional(),
  notes:    z.string().max(500).optional(),
  // 7.1 — the vendor's base location, for the directory's distance column.
  latitude:  z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

const updateVendorSchema = z.object({
  name:     z.string().min(2).max(100).optional(),
  phone:    z.string().min(5).max(20).optional(),
  email:    z.string().email().optional(),
  category: z.enum(['PLUMBING', 'ELECTRICAL', 'PAINTING', 'GENERAL', 'CARPENTRY', 'OTHER']).optional(),
  city:     z.string().max(100).optional(),
  notes:    z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  latitude:  z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided' },
);

// 16.x
const createStaffMemberSchema = z.object({
  staffRole: z.enum(ADMIN_STAFF_ROLES),
  permissions: z.array(z.enum(ADMIN_PERMISSION_SCOPES)).optional(),
});

const updateStaffPermissionsSchema = z.object({
  staffRole: z.enum(ADMIN_STAFF_ROLES).nullable().optional(),
  permissions: z.array(z.enum(ADMIN_PERMISSION_SCOPES)).optional(),
}).refine(
  (d) => d.staffRole !== undefined || d.permissions !== undefined,
  { message: 'At least one of staffRole or permissions must be provided' },
);

// 7.1 — a vendor's recurring weekly availability window.
const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const addVendorAvailabilitySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_HHMM, 'startTime must be HH:mm, 24-hour'),
  endTime:   z.string().regex(TIME_HHMM, 'endTime must be HH:mm, 24-hour'),
}).refine((d) => d.startTime < d.endTime, { message: 'endTime must be after startTime', path: ['endTime'] });

const adminResolveDisputeSchema = z.object({
  status:    z.enum(['UNDER_REVIEW', 'RESOLVED', 'CLOSED']).optional(),
  adminNote: z.string().min(5).max(1000).optional(),
}).refine(
  (d) => d.status !== undefined || d.adminNote !== undefined,
  { message: 'At least one of status or adminNote must be provided' },
);

const moderateReviewSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT'], {
    errorMap: () => ({ message: 'action must be APPROVE or REJECT' }),
  }),
});

const updateVideoTourSchema = z.object({
  assignedTo:  objectId.optional(),
  videoUrl:    z.string().url().optional(),
  scheduledAt: z.string().datetime().optional(),
  adminNote:   z.string().max(500).optional(),
  status:      z.enum(['PENDING', 'ASSIGNED', 'COMPLETED']).optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: 'At least one field must be provided' },
);

module.exports = {
  assignLeadSchema,
  createLeadSchema,
  confirmLeadSchema,
  rejectLeadSchema,
  rejectPropertySchema,
  verifyKycSchema,
  updateLoanStatusSchema,
  changeUserRoleSchema,
  editPropertySchema,
  approvePropertySchema,
  requestPropertyChangesSchema,
  requestKycDocumentsSchema,
  updateTicketSchema,
  dispatchTicketSchema,
  resolveTicketSchema,
  linkTicketToDealSchema,
  addVendorAvailabilitySchema,
  createStaffMemberSchema,
  updateStaffPermissionsSchema,
  createServiceSchema,
  updateServiceSchema,
  createTeamMemberSchema,
  updateTeamMemberSchema,
  verifyDocumentSchema,
  updateVideoTourSchema,
  createVendorSchema,
  updateVendorSchema,
  adminResolveDisputeSchema,
  moderateReviewSchema,
};
