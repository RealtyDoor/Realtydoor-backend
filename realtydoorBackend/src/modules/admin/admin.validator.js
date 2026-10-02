const { z } = require('zod');
const { objectId, roleEnum } = require('../../utils/validators');

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
});

const updateVendorSchema = z.object({
  name:     z.string().min(2).max(100).optional(),
  phone:    z.string().min(5).max(20).optional(),
  email:    z.string().email().optional(),
  category: z.enum(['PLUMBING', 'ELECTRICAL', 'PAINTING', 'GENERAL', 'CARPENTRY', 'OTHER']).optional(),
  city:     z.string().max(100).optional(),
  notes:    z.string().max(500).optional(),
  isActive: z.boolean().optional(),
}).refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided' },
);

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
  rejectPropertySchema,
  verifyKycSchema,
  updateLoanStatusSchema,
  changeUserRoleSchema,
  editPropertySchema,
  updateTicketSchema,
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
