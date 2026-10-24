// Mass assignment: a signed-in buyer or partner adds fields the form never offers ("role": "ADMIN", "kycStatus": "VERIFIED",
// "publishStatus": "APPROVED", ...) hoping they are copied into the database row. Every self-service request schema must drop them.
const users = require('../../src/modules/users/users.validator');
const partners = require('../../src/modules/partners/partners.validator');
const properties = require('../../src/modules/properties/properties.validator');
const leads = require('../../src/modules/leads/leads.validator');
const escrow = require('../../src/modules/escrow/escrow.validator');

const OID = '64b000000000000000000001';
const FORBIDDEN = {
  role: 'ADMIN', staffRole: 'SUPER_ADMIN', adminPermissions: ['FINANCE'], isSuspended: false, kycStatus: 'VERIFIED', clerkId: 'clerk_x',
  deletedAt: null, phoneVerified: true, phoneVerifiedAt: '2026-01-01', emailVerified: true, refCode: 'RD-U-1', id: OID, _id: OID,
  razorpayFundAccountId: 'fa_x', payoutAccountStatus: 'ACTIVE', publishStatus: 'APPROVED', isVerified: true, partnerId: OID,
  assignedPartnerId: OID, buyerId: OID, status: 'CLOSED', escrowStatus: 'RELEASED', commissionStatus: 'COLLECTED', commissionLockedAt: '2026-01-01',
  feePct: 0, partnerRatePct: 99, dealPriceAtLock: 1, allocationLetterVerifiedAt: '2026-01-01', buyerFeedbackStatus: 'VERIFIED_CLOSED',
  siteVisitOTP: '000000', isOtpVerified: true, otpAttempts: 0, otpLockedUntil: null, kycVerifiedAt: '2026-01-01', tdsRatePct: 0,
  walletBalance: 1e9, 'role.$set': 'ADMIN',
};
const DANGEROUS = Object.keys(FORBIDDEN);

// A body that is valid for the schema plus every forbidden field.
const cases = [
  ['users update profile', users.updateProfileSchema, { name: 'A B' }],
  ['users raise ticket', users.raiseTicketSchema, { subject: 'Leaky tap', description: 'It leaks a lot' }],
  ['users rate lead', users.rateLeadSchema, { rating: 5 }],
  ['users toggle favourite', users.toggleFavoriteSchema, { propertyId: OID }],
  ['users raise dispute', users.raiseDisputeSchema, { type: 'LEAD', referenceId: OID, reason: 'NOT_AS_DESCRIBED', description: 'This is a description' }],
  ['partner update profile', partners.updateProfileSchema, { name: 'Partner' }],
  ['partner update settings', partners.updateSettingsSchema, { notifNewLead: true }],
  ['partner update bank account', partners.updateBankAccountSchema, { bankName: 'HDFC', bankAccountNo: '123456789', bankIfsc: 'HDFC0001234', bankHolderName: 'A B' }],
  ['partner update billing', partners.updateBillingSchema, { billingLegalName: 'Abc Ltd' }],
  ['partner support ticket', partners.createSupportTicketSchema, { subject: 'Help me', description: 'I need some help here' }],
  ['escrow create order', escrow.createOrderSchema, { leadId: OID, amount: 50000 }],
  ['lead submit', leads.submitLeadSchema, { propertyId: OID }],
];

describe.each(cases)('%s', (_name, schema, valid) => {
  test('the plain body is understood by the schema (so the test below is meaningful)', () => {
    const r = schema.safeParse(valid);
    expect(r.success).toBe(true);
  });
  test('privileged fields sent along are not in the parsed result', () => {
    const r = schema.safeParse({ ...valid, ...FORBIDDEN });
    const out = r.success ? r.data : {};
    const leaked = DANGEROUS.filter((k) => k in out && !(k in valid));
    expect(leaked).toEqual([]);
  });
});

test('create property: a partner cannot create a listing that is already approved or verified', () => {
  const r = properties.createPropertySchema.safeParse({ title: 'x'.repeat(10), ...FORBIDDEN });
  const out = r.success ? r.data : {};
  for (const k of ['publishStatus', 'isVerified', 'partnerId', 'status', 'refCode', 'id']) expect(out).not.toHaveProperty(k);
});

test('partner add lead: the partner cannot choose the status, the assigned partner or the buyer account of a lead they add', () => {
  const r = leads.partnerAddLeadSchema.safeParse({ buyerName: 'B', buyerPhone: '+919000000001', ...FORBIDDEN });
  const out = r.success ? r.data : {};
  for (const k of ['status', 'assignedPartnerId', 'buyerId', 'addedByPartnerId', 'commissionStatus', 'allocationLetterVerifiedAt']) expect(out).not.toHaveProperty(k);
});
