const { z } = require('zod');

const createProjectSchema = z.object({
  title: z.string().min(5).max(200),
  description: z.string().min(20),
  address: z.string().min(5),
  locality: z.string().min(2),
  city: z.string().min(2),
  state: z.string().min(2),
  pincode: z.string().regex(/^\d{6}$/),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  reraProjectNumber: z.string().max(100).optional(),
  approvedPlanUrl: z.string().url().optional(),
  commencementCertificateUrl: z.string().url().optional(),
  landTitleDocUrl: z.string().url().optional(),
  designatedAccountBankName: z.string().max(100).optional(),
  designatedAccountNumber: z.string().max(30).optional(),
  designatedAccountIfsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code').optional(),
});

const updateProjectSchema = createProjectSchema.partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'At least one field must be provided' },
);

const unitSchema = z.object({
  unitNumber: z.string().min(1).max(50),
  unitType: z.enum(['FLAT', 'INDEPENDENT_HOUSE', 'VILLA', 'PLOT', 'COMMERCIAL_OFFICE', 'RETAIL_SHOP']).optional(),
  bhk: z.number().int().min(1).max(10).optional(),
  carpetArea: z.number().positive().optional(),
  builtUpArea: z.number().positive().optional(),
  price: z.number().positive().optional(),
  floorNumber: z.number().int().optional(),
});

const bulkAddUnitsSchema = z.object({
  units: z.array(unitSchema).min(1).max(500),
});

const setUnitStatusSchema = z.object({
  status: z.enum(['AVAILABLE', 'BOOKED', 'SOLD', 'ON_HOLD']),
});

const rejectProjectSchema = z.object({
  note: z.string().min(5).max(500),
});

const requestProjectChangesSchema = z.object({
  items: z.array(z.string().min(3).max(300)).min(1).max(20),
  note: z.string().max(1000).optional(),
});

const setApprovalItemSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
});

// R28
const setBrokerageSchema = z.object({
  brokeragePct: z.number().min(0).max(100),
});

module.exports = {
  createProjectSchema, updateProjectSchema, unitSchema, bulkAddUnitsSchema, setUnitStatusSchema,
  rejectProjectSchema, requestProjectChangesSchema, setApprovalItemSchema, setBrokerageSchema,
};
