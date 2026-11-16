// Audit Nov 2026, phase 4 (partners and listings). One test or more per finding P1 to P20; see admin-nextjs/docs/AUDIT_2026-11.md.
// prisma is a mock that makes a jest.fn for any model.method the first time it is asked for, so each test sets only what it uses.
jest.mock('../../src/lib/prisma', () => {
  const models = {};
  return new Proxy({}, {
    get(_t, model) {
      if (typeof model !== 'string' || model === '__esModule' || model === 'then') return undefined;
      if (model.startsWith('$')) { models[model] = models[model] || jest.fn(); return models[model]; }
      models[model] = models[model] || new Proxy({}, { get(m, fn) { if (typeof fn !== 'string') return undefined; m[fn] = m[fn] || jest.fn(); return m[fn]; } });
      return models[model];
    },
  });
});
jest.mock('../../src/lib/notifications', () => ({
  notifyAdmins: jest.fn(), createNotification: jest.fn(), broadcastNotification: jest.fn(), markNotificationsRead: jest.fn(),
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn(), sendLeadAssignedNotice: jest.fn(), sendSiteVisitOtp: jest.fn(), sendTicketVendorDispatched: jest.fn() }));
jest.mock('../../src/lib/razorpay', () => ({
  createPayoutContact: jest.fn(), createPayoutFundAccount: jest.fn(), validateFundAccountOrWarn: jest.fn(), rawGet: jest.fn(),
}));
jest.mock('../../src/lib/kycVerification', () => ({ verifyPan: jest.fn(), verifyGstin: jest.fn(), verifyRera: jest.fn() }));
jest.mock('../../src/lib/cache', () => ({ withCache: jest.fn((k, t, fn) => fn()), cacheDel: jest.fn(), cacheDelPattern: jest.fn() }));

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/lib/prisma');
const notifications = require('../../src/lib/notifications');
const razorpay = require('../../src/lib/razorpay');
const { partnerPayoutBlocker, listingOwnerBlocker, LIVE_PARTNER } = require('../../src/lib/partnerStanding');
const src = (p) => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');

const GOOD = { id: 'p1', role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: false, deletedAt: null, payoutAccountStatus: 'ACTIVE', razorpayFundAccountId: 'fa_1' };

beforeEach(() => {
  jest.resetAllMocks();
  notifications.notifyAdmins.mockResolvedValue({});
  notifications.createNotification.mockResolvedValue({});
  require('../../src/lib/auditLog').createAuditLog.mockResolvedValue({});
  require('../../src/lib/cache').withCache.mockImplementation((k, t, fn) => fn());
  // the key lock (lib/keyLock): free
  prisma.counter.create.mockResolvedValue({});
  prisma.counter.deleteMany.mockResolvedValue({});
});

describe('P1, P2: one answer to "may this partner be paid?"', () => {
  test('a partner in good standing with an active account may be paid', () => {
    expect(partnerPayoutBlocker(GOOD)).toBeNull();
  });
  test.each([
    [{ isSuspended: true }, 'PARTNER_SUSPENDED'],
    [{ kycStatus: 'REJECTED' }, 'PARTNER_KYC_NOT_VERIFIED'],
    [{ kycStatus: 'DOCUMENTS_REQUESTED' }, 'PARTNER_KYC_NOT_VERIFIED'],
    [{ deletedAt: new Date() }, 'PARTNER_ACCOUNT_DELETED'],
    [{ razorpayFundAccountId: null }, 'PARTNER_PAYOUT_ACCOUNT_MISSING'],
    [{ payoutAccountStatus: 'SUSPENDED' }, 'PARTNER_PAYOUT_ACCOUNT_NOT_ACTIVE'],
    [{ payoutAccountStatus: 'NEEDS_CLARIFICATION' }, 'PARTNER_PAYOUT_ACCOUNT_NOT_ACTIVE'],
  ])('%p is refused with %s', (over, code) => {
    expect(partnerPayoutBlocker({ ...GOOD, ...over })).toMatchObject({ code });
  });
  test('a partner row that is gone is refused', () => {
    expect(partnerPayoutBlocker(null)).toMatchObject({ code: 'PARTNER_NOT_FOUND' });
  });
  test('every release path asks the shared check, and none compares the account status by hand', () => {
    for (const file of ['modules/escrow/escrow.service.js', 'modules/escrow/escrowPayout.service.js']) {
      const text = src(file);
      expect(text).toMatch(/partnerPayoutBlocker\(/);
      expect(text).not.toMatch(/payoutAccountStatus\s*[!=]==/);
    }
    expect((src('modules/escrow/escrow.service.js').match(/partnerPayoutBlocker\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('P1: a partner cannot lift a payout freeze or swap the bank account by registering again', () => {
  const partners = require('../../src/modules/partners/partners.service');
  const body = { legalName: 'Asha Rao', accountNumber: '123456789012', ifsc: 'HDFC0001234' };
  const partnerRow = (over = {}) => ({ id: 'p1', name: 'Asha', email: 'a@x.com', phone: '+919000000001', payoutAccountStatus: null, razorpayContactId: null, razorpayFundAccountId: null, panNumber: null, ...over });
  beforeEach(() => {
    razorpay.createPayoutContact.mockResolvedValue({ id: 'cont_1' });
    razorpay.createPayoutFundAccount.mockResolvedValue({ id: 'fa_new' });
    razorpay.validateFundAccountOrWarn.mockResolvedValue();
    prisma.user.update.mockImplementation(async ({ data }) => ({ ...data }));
  });

  test('a SUSPENDED account is refused before anything is sent to RazorpayX', async () => {
    prisma.user.findUnique.mockResolvedValue(partnerRow({ payoutAccountStatus: 'SUSPENDED', razorpayFundAccountId: 'fa_old' }));
    await expect(partners.createPayoutAccount('p1', body, 'VERIFIED')).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAYOUT_ACCOUNT_SUSPENDED' } });
    expect(razorpay.createPayoutFundAccount).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('new details after NEEDS_CLARIFICATION wait for an admin; they do not activate themselves', async () => {
    prisma.user.findUnique.mockResolvedValue(partnerRow({ payoutAccountStatus: 'NEEDS_CLARIFICATION', razorpayContactId: 'cont_1', razorpayFundAccountId: 'fa_old' }));
    await partners.createPayoutAccount('p1', body, 'VERIFIED');
    const data = prisma.user.update.mock.calls.map((c) => c[0].data).find((d) => d.razorpayFundAccountId === 'fa_new');
    expect(data.payoutAccountStatus).toBe('NEEDS_CLARIFICATION');
    expect(data.payoutValidatedAt).toBeNull();
    expect(notifications.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'Payout account resubmitted' }));
  });
  test('a first registration by a verified partner still becomes ACTIVE', async () => {
    prisma.user.findUnique.mockResolvedValue(partnerRow());
    await partners.createPayoutAccount('p1', body, 'VERIFIED');
    const data = prisma.user.update.mock.calls.map((c) => c[0].data).find((d) => d.razorpayFundAccountId === 'fa_new');
    expect(data.payoutAccountStatus).toBe('ACTIVE');
  });
  test('the PAN on file cannot be replaced through this route', async () => {
    prisma.user.findUnique.mockResolvedValue(partnerRow({ panNumber: 'ABCDE1234F' }));
    await expect(partners.createPayoutAccount('p1', { ...body, panNumber: 'ZZZZZ9999Z' }, 'VERIFIED')).rejects.toMatchObject({ data: { code: 'PAN_LOCKED' } });
    expect(razorpay.createPayoutContact).not.toHaveBeenCalled();
  });
  test('an admin cannot set ACTIVE for a partner without verified KYC, or one who is suspended (P17)', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'p1', payoutAccountStatus: 'NEEDS_CLARIFICATION', razorpayFundAccountId: 'fa_1', kycStatus: 'REJECTED', isSuspended: false });
    await expect(partners.setPayoutAccountStatus('p1', 'ACTIVE', null, 'adm', 'ip')).rejects.toMatchObject({ data: { code: 'PARTNER_KYC_NOT_VERIFIED' } });
    prisma.user.findFirst.mockResolvedValue({ id: 'p1', payoutAccountStatus: 'SUSPENDED', razorpayFundAccountId: 'fa_1', kycStatus: 'VERIFIED', isSuspended: true });
    await expect(partners.setPayoutAccountStatus('p1', 'ACTIVE', null, 'adm', 'ip')).rejects.toMatchObject({ data: { code: 'PARTNER_SUSPENDED' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('the payout account routes and the support ticket route have a limiter', () => {
    const routes = src('modules/partners/partners.routes.js');
    expect(routes).toMatch(/post\('\/payout-account',\s*payoutAccountLimiter/);
    expect(routes).toMatch(/post\('\/payout-account\/change-request',\s*payoutAccountLimiter/);
    expect(routes).toMatch(/post\('\/support-tickets',\s*supportTicketLimiter/);
  });
});

describe('P2: rejecting KYC freezes the payout account; listings follow the partner\'s standing', () => {
  const admin = require('../../src/modules/admin/admin.service');
  test('REJECT on a verified partner freezes an ACTIVE payout account and records what it was', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', role: 'PARTNER', kycStatus: 'VERIFIED', payoutAccountStatus: 'ACTIVE', email: 'a@x.com' });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({ id: 'p1', kycStatus: 'REJECTED' });
    await admin.verifyKyc('p1', 'REJECT', 'Document mismatch', 'adm', 'ip');
    expect(prisma.user.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'p1', payoutAccountStatus: 'ACTIVE' }, data: { payoutAccountStatus: 'SUSPENDED' } });
    const audit = require('../../src/lib/auditLog').createAuditLog.mock.calls[0][0];
    expect(audit.before).toMatchObject({ kycStatus: 'VERIFIED', payoutAccountStatus: 'ACTIVE' });
    expect(audit.after).toMatchObject({ kycStatus: 'REJECTED', payoutAccountStatus: 'SUSPENDED' });
  });
  test('KYC is for partners only, and a verified partner is not approved twice (P18)', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'USER' });
    await expect(admin.verifyKyc('u1', 'APPROVE', null, 'adm', 'ip')).rejects.toMatchObject({ data: { code: 'NOT_A_PARTNER' } });
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', role: 'PARTNER', kycStatus: 'VERIFIED' });
    await expect(admin.verifyKyc('p1', 'APPROVE', null, 'adm', 'ip')).rejects.toMatchObject({ data: { code: 'KYC_ALREADY_VERIFIED' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('who may own a public listing', () => {
    expect(listingOwnerBlocker({ role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: false })).toBeNull();
    expect(listingOwnerBlocker({ role: 'ADMIN', kycStatus: 'NOT_SUBMITTED', isSuspended: false })).toBeNull(); // Realtydoor's own listing
    expect(listingOwnerBlocker(null)).toMatchObject({ code: 'LISTING_OWNER_MISSING' });
    expect(listingOwnerBlocker({ role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: true })).toMatchObject({ code: 'LISTING_OWNER_SUSPENDED' });
    expect(listingOwnerBlocker({ role: 'PARTNER', kycStatus: 'REJECTED', isSuspended: false })).toMatchObject({ code: 'LISTING_OWNER_KYC' });
    expect(listingOwnerBlocker({ role: 'PARTNER', kycStatus: 'VERIFIED', deletedAt: new Date() })).toMatchObject({ code: 'LISTING_OWNER_DELETED' });
  });
  test('search, related listings, the homepage, the B2B feed and the locality page all carry the live-partner filter', async () => {
    const properties = require('../../src/modules/properties/properties.service');
    prisma.property.findMany.mockResolvedValue([]);
    prisma.property.count.mockResolvedValue(0);
    prisma.$transaction.mockResolvedValue([[], 0]);
    await properties.searchProperties({}, 0, 10, 1);
    expect(prisma.property.findMany.mock.calls[0][0].where.AND).toContainEqual(LIVE_PARTNER);
    prisma.property.findMany.mockClear();
    await properties.getFeaturedProperties();
    const featured = prisma.property.findMany.mock.calls[0][0].where;
    expect(featured.AND).toContainEqual(LIVE_PARTNER);
    expect(featured.isB2BOnly).toBe(false); // P16
    expect(src('modules/b2b/b2b.service.js')).toMatch(/partnerId: \{ not: partnerId \},[\s\S]{0,200}\.\.\.LIVE_PARTNER/);
    expect(src('modules/locality/locality.service.js')).toMatch(/liveWhere = \{[^}]*\.\.\.LIVE_PARTNER/);
  });
  test('the detail page is a 404 when the partner is suspended, and never leaks the fields used for the check', async () => {
    const properties = require('../../src/modules/properties/properties.service');
    prisma.property.findFirst.mockResolvedValue({ id: 'x', slug: 's', partnerId: 'p1', isB2BOnly: false });
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', name: 'Asha', role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: true });
    await expect(properties.getPropertyByIdOrSlug('s')).rejects.toMatchObject({ statusCode: 404 });
    expect(src('modules/properties/properties.service.js')).toMatch(/for \(const k of \['role', 'isSuspended', 'deletedAt'\]\) delete property\.partner\[k\]/);
  });
  test('a buyer cannot enquire on a listing whose partner is suspended', async () => {
    const leads = require('../../src/modules/leads/leads.service');
    prisma.property.findUnique.mockResolvedValue({ id: 'prop1', title: 'Villa', publishStatus: 'APPROVED', partnerId: 'p1' });
    prisma.user.findUnique.mockResolvedValue({ role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: true });
    await expect(leads.submitLead({ propertyId: 'prop1' }, { id: 'b1' })).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });
});

describe('P3: a file added to a live listing waits for review', () => {
  const properties = require('../../src/modules/properties/properties.service');
  const live = (over = {}) => ({ id: 'x', partnerId: 'p1', publishStatus: 'APPROVED', images: ['a.jpg'], videos: [], documents: [], ...over });

  test('a new photo on an APPROVED listing opens a change request and leaves the listing alone', async () => {
    prisma.property.findUnique.mockResolvedValue(live());
    prisma.propertyChangeRequest.findFirst.mockResolvedValue(null);
    prisma.propertyChangeRequest.create.mockResolvedValue({ id: 'cr1' });
    const out = await properties.addImages('x', 'p1', ['b.jpg']);
    expect(prisma.property.update).not.toHaveBeenCalled();
    expect(prisma.propertyChangeRequest.create.mock.calls[0][0].data).toMatchObject({
      propertyId: 'x', partnerId: 'p1', fieldCount: 1,
      changes: { images: { before: JSON.stringify(['a.jpg']), after: JSON.stringify(['a.jpg', 'b.jpg']) } },
    });
    expect(out.pendingReview).toBe(true);
    expect(out.images).toEqual(['a.jpg']);
  });
  test('it joins a pending edit instead of replacing it', async () => {
    prisma.property.findUnique.mockResolvedValue(live());
    prisma.propertyChangeRequest.findFirst.mockResolvedValue({ id: 'cr1', changes: { title: { before: '"Old"', after: '"New"' } } });
    prisma.propertyChangeRequest.updateMany.mockResolvedValue({ count: 1 });
    await properties.addImages('x', 'p1', ['b.jpg']);
    const call = prisma.propertyChangeRequest.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'cr1', status: 'PENDING' });
    expect(Object.keys(call.data.changes)).toEqual(['title', 'images']);
    expect(call.data.fieldCount).toBe(2);
    expect(prisma.propertyChangeRequest.create).not.toHaveBeenCalled();
  });
  test('documents and videos go the same way', async () => {
    prisma.property.findUnique.mockResolvedValue(live());
    prisma.propertyChangeRequest.findFirst.mockResolvedValue(null);
    prisma.propertyChangeRequest.create.mockResolvedValue({});
    await properties.addVideos('x', 'p1', ['v.mp4']);
    await properties.addDocuments('x', 'p1', [{ originalname: 'ec.pdf', path: 'https://b/ec.pdf' }]);
    expect(prisma.property.update).not.toHaveBeenCalled();
    expect(Object.keys(prisma.propertyChangeRequest.create.mock.calls[0][0].data.changes)).toEqual(['videos']);
    expect(Object.keys(prisma.propertyChangeRequest.create.mock.calls[1][0].data.changes)).toEqual(['documents']);
  });
  test('a listing that is not live still takes the file directly', async () => {
    prisma.property.findUnique.mockResolvedValue(live({ publishStatus: 'PENDING_APPROVAL' }));
    prisma.property.update.mockResolvedValue({});
    await properties.addImages('x', 'p1', ['b.jpg']);
    expect(prisma.property.update.mock.calls[0][0].data).toEqual({ images: { push: ['b.jpg'] } });
    expect(prisma.propertyChangeRequest.create).not.toHaveBeenCalled();
  });
  test('there is a ceiling on the total, counting files already waiting', async () => {
    prisma.property.findUnique.mockResolvedValue(live({ publishStatus: 'PENDING_APPROVAL', images: Array.from({ length: 29 }, (_, i) => `${i}.jpg`) }));
    await expect(properties.addImages('x', 'p1', ['a.jpg', 'b.jpg'])).rejects.toMatchObject({ data: { code: 'LISTING_MEDIA_LIMIT' } });
    expect(prisma.property.update).not.toHaveBeenCalled();
  });
  test('someone else\'s listing is still refused', async () => {
    prisma.property.findUnique.mockResolvedValue(live());
    await expect(properties.addImages('x', 'other', ['b.jpg'])).rejects.toMatchObject({ statusCode: 403 });
  });
  test('a later text edit keeps the photos that are still waiting', async () => {
    prisma.property.findUnique.mockResolvedValue(live({ title: 'Old' }));
    prisma.propertyChangeRequest.findFirst.mockResolvedValue({ id: 'cr1', changes: { images: { before: JSON.stringify(['a.jpg']), after: JSON.stringify(['a.jpg', 'b.jpg']) } } });
    prisma.$transaction.mockResolvedValue([{}, { id: 'cr2' }]);
    prisma.propertyChangeRequest.create.mockImplementation((args) => args);
    await properties.updateProperty('x', 'p1', { title: 'New' });
    const created = prisma.propertyChangeRequest.create.mock.calls[0][0].data;
    expect(JSON.parse(created.changes.images.after)).toEqual(['a.jpg', 'b.jpg']);
    expect(created.changes.title).toEqual({ before: '"Old"', after: '"New"' });
  });
});

describe('P4: commission terms are frozen once money has moved, and every payee must be payable', () => {
  const commission = require('../../src/modules/commission/commission.service');
  const lead = (over = {}) => ({
    id: 'l1', assignedPartnerId: 'p1', commissionLockedAt: null, commissionVersion: 1, feePct: 2, dealPriceAtLock: 10_000_000, city: 'Bengaluru',
    propertyId: 'prop1', commissionStatus: 'PENDING', escrowTransactions: [], property: { price: 10_000_000, city: 'Bengaluru', partnerId: 'owner', projectId: null }, ...over,
  });
  const terms = { feePct: 2, lines: [{ payeeRole: 'CLOSING_AGENT', pct: 50 }] };

  test.each([
    [{ escrowTransactions: [{ status: 'RELEASED' }] }],
    [{ escrowTransactions: [{ status: 'HELD_PAYOUT_FAILED' }] }],
    [{ commissionStatus: 'INVOICED' }],
    [{ commissionStatus: 'COLLECTED' }],
  ])('refused when %p', async (over) => {
    prisma.lead.findUnique.mockResolvedValue(lead(over));
    await expect(commission.setLeadTerms('l1', terms, 'adm', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'DEAL_RATE_FROZEN' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  test.each([
    [[], 'does not exist'],
    [[{ id: 'p1', name: 'Asha', role: 'USER', kycStatus: 'VERIFIED', isSuspended: false }], 'is not a partner'],
    [[{ id: 'p1', name: 'Asha', role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: true }], 'is suspended'],
    [[{ id: 'p1', name: 'Asha', role: 'PARTNER', kycStatus: 'REJECTED', isSuspended: false }], 'has no verified KYC'],
  ])('a payee who %#) cannot be put on a line', async (users, why) => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    prisma.user.findMany.mockResolvedValue(users);
    await expect(commission.setLeadTerms('l1', terms, 'adm', 'ip')).rejects.toMatchObject({ statusCode: 400, data: { code: 'PAYEE_NOT_ELIGIBLE' }, message: expect.stringContaining(why) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  test('the deal price has a ceiling', () => {
    const { setLeadTermsSchema } = require('../../src/modules/commission/commission.validator');
    const lines = [{ payeeRole: 'CLOSING_AGENT', pct: 50 }];
    expect(setLeadTermsSchema.safeParse({ feePct: 2, dealPrice: 1e12, lines }).success).toBe(false);
    expect(setLeadTermsSchema.safeParse({ feePct: 2, dealPrice: 5e7, lines }).success).toBe(true);
  });
  test('an override that has already ended is refused (P19)', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'p1' });
    await expect(commission.createOverride({ partnerId: 'p1', scope: 'ALL', partnerSharePct: 60, validUntil: '2020-01-01T00:00:00.000Z' }, 'adm', 'ip'))
      .rejects.toMatchObject({ data: { code: 'OVERRIDE_ALREADY_ENDED' } });
    expect(prisma.partnerCommissionOverride.create).not.toHaveBeenCalled();
  });
  test('editing the fee of a rate card clears the stored partner and platform rates so they are derived again (P19)', async () => {
    prisma.rateCard.findUnique.mockResolvedValue({ id: 'rc1', version: 3, feePct: 2, lines: [] });
    prisma.rateCard.update.mockResolvedValue({ id: 'rc1', version: 4, feePct: 3 });
    await commission.updateRateCard('rc1', { feePct: 3 }, 'adm', 'ip');
    expect(prisma.rateCard.update.mock.calls[0][0].data).toMatchObject({ feePct: 3, partnerRatePct: null, platformFeePct: null, version: 4 });
  });
});

describe('P5: what an approval refuses', () => {
  const admin = require('../../src/modules/admin/admin.service');
  const listing = { id: 'x', partnerId: 'p1', title: 'Villa', city: 'Bengaluru', locality: 'Indiranagar', images: ['a.jpg'], publishStatus: 'PENDING_APPROVAL' };

  test.each([
    [{ role: 'PARTNER', kycStatus: 'REJECTED', isSuspended: false }, 'LISTING_OWNER_KYC'],
    [{ role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: true }, 'LISTING_OWNER_SUSPENDED'],
    [null, 'LISTING_OWNER_MISSING'],
  ])('a listing whose owner is %p', async (owner, code) => {
    prisma.property.findUnique.mockResolvedValue({ ...listing });
    prisma.user.findUnique.mockResolvedValue(owner);
    await expect(admin.approveProperty('x', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code } });
    expect(prisma.property.update).not.toHaveBeenCalled();
  });
  test('a listing the property owner has complained about', async () => {
    prisma.property.findUnique.mockResolvedValue({ ...listing });
    prisma.user.findUnique.mockResolvedValue({ role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: false });
    prisma.listingConflict.findFirst.mockResolvedValue({ id: 'c1', type: 'OWNER_REPORTED_UNAUTHORIZED' });
    await expect(admin.approveProperty('x', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'LISTING_OWNER_COMPLAINT_OPEN', conflictId: 'c1' } });
    expect(prisma.listingConflict.findFirst.mock.calls[0][0].where).toMatchObject({ propertyId: 'x', status: 'OPEN', type: { in: ['OWNER_DENIED_MANDATE', 'OWNER_REPORTED_UNAUTHORIZED'] } });
    expect(prisma.property.update).not.toHaveBeenCalled();
  });
  test('a project with no units, or a builder who is not in good standing', async () => {
    const projects = require('../../src/modules/projects/project.admin.service');
    prisma.project.findUnique.mockResolvedValue({ id: 'pr1', builderId: 'b1', title: 'Towers', _count: { units: 0 } });
    await expect(projects.approveProject('pr1', 'adm', 'ip')).rejects.toMatchObject({ data: { code: 'PROJECT_NO_UNITS' } });
    prisma.project.findUnique.mockResolvedValue({ id: 'pr1', builderId: 'b1', title: 'Towers', _count: { units: 4 } });
    prisma.user.findUnique.mockResolvedValue({ role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: true });
    await expect(projects.approveProject('pr1', 'adm', 'ip')).rejects.toMatchObject({ data: { code: 'LISTING_OWNER_SUSPENDED' } });
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});

describe('P6: approving a change request', () => {
  const listings = require('../../src/modules/listings/listings.admin.service');
  const cr = (over = {}, prop = {}) => ({
    id: 'cr1', status: 'PENDING', partnerId: 'p1', changes: { title: { before: '"Old title here"', after: '"New title here"' } },
    property: { id: 'x', title: 'Old title here', city: 'Bengaluru', locality: 'Indiranagar', publishStatus: 'APPROVED', ...prop }, ...over,
  });
  const args = { adminId: 'adm', adminName: 'Admin', note: null, force: false };

  test('refused when the listing is no longer live', async () => {
    prisma.propertyChangeRequest.findUnique.mockResolvedValue(cr({}, { publishStatus: 'REJECTED' }));
    await expect(listings.approveChangeRequest('cr1', args, 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'LISTING_NOT_LIVE' } });
    expect(prisma.propertyChangeRequest.updateMany).not.toHaveBeenCalled();
  });
  test('a stored value that no longer passes the listing rules is refused', async () => {
    prisma.propertyChangeRequest.findUnique.mockResolvedValue(cr({ changes: { latitude: { before: 'null', after: '999' } } }));
    await expect(listings.approveChangeRequest('cr1', args, 'ip')).rejects.toMatchObject({ statusCode: 400, data: { code: 'CHANGE_REQUEST_INVALID' } });
    expect(prisma.propertyChangeRequest.updateMany).not.toHaveBeenCalled();
  });
  test('a second approval at the same moment applies nothing', async () => {
    prisma.propertyChangeRequest.findUnique.mockResolvedValue(cr());
    prisma.propertyChangeRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(listings.approveChangeRequest('cr1', args, 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'CHANGE_REQUEST_ALREADY_DECIDED' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  test('if the write fails the request goes back to PENDING', async () => {
    prisma.propertyChangeRequest.findUnique.mockResolvedValue(cr());
    prisma.propertyChangeRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockRejectedValue(new Error('db down'));
    await expect(listings.approveChangeRequest('cr1', args, 'ip')).rejects.toThrow('db down');
    expect(prisma.propertyChangeRequest.updateMany.mock.calls[1][0]).toMatchObject({ where: { id: 'cr1', status: 'APPROVED' }, data: { status: 'PENDING' } });
  });
  test('the city is stored in its canonical spelling', async () => {
    prisma.propertyChangeRequest.findUnique.mockResolvedValue(cr({ changes: { city: { before: '"Bengaluru"', after: '"Bangalore"' } } }));
    prisma.propertyChangeRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.property.update.mockImplementation((a) => a);
    prisma.propertyEditLog.create.mockImplementation((a) => a);
    prisma.$transaction.mockImplementation(async (ops) => [{ id: 'x', city: ops[0].data.city, locality: 'Indiranagar' }]);
    prisma.microsite.findUnique.mockResolvedValue(null);
    prisma.property.findUnique.mockResolvedValue(null);
    const out = await listings.approveChangeRequest('cr1', { ...args, force: true }, 'ip');
    expect(out.property.city).toBe(require('../../src/lib/cityAlias').canonicalizeCity('Bangalore'));
  });
  test('a withdrawal that loses the race to an approval is refused', async () => {
    const partner = require('../../src/modules/listings/listings.partner.service');
    prisma.propertyChangeRequest.findUnique.mockResolvedValue({ id: 'cr1', partnerId: 'p1', status: 'PENDING' });
    prisma.propertyChangeRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(partner.withdrawMyChangeRequest('cr1', 'p1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('P7: profile changes after KYC', () => {
  const partners = require('../../src/modules/partners/partners.service');
  const { updateProfileSchema } = require('../../src/modules/partners/partners.validator');
  const current = (over = {}) => ({ panNumber: 'ABCDE1234F', gstin: '29ABCDE1234F1Z5', reraNumber: 'R1', name: 'Asha', companyName: 'Asha Homes', partnerSubType: 'AGENT', kycStatus: 'VERIFIED', ...over });
  beforeEach(() => {
    prisma.user.update.mockImplementation(async ({ data }) => ({ name: 'Asha', ...data }));
    prisma.user.findUnique.mockResolvedValue(current());
  });

  test('a GSTIN must look like one; empty clears it; the partner type must be a real one', () => {
    expect(updateProfileSchema.safeParse({ gstin: 'hello' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ gstin: '29abcde1234f1z5' }).data.gstin).toBe('29ABCDE1234F1Z5');
    expect(updateProfileSchema.safeParse({ gstin: '' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ partnerSubType: 'WIZARD' }).success).toBe(false);
  });
  test('a verified partner cannot change their partner type', async () => {
    await expect(partners.updateProfile('p1', { partnerSubType: 'BUILDER' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'PARTNER_TYPE_LOCKED' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('a new GSTIN loses the old "verified" result and the admins are told', async () => {
    await partners.updateProfile('p1', { gstin: '27ABCDE1234F1Z5' });
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ gstin: '27ABCDE1234F1Z5', gstinVerificationStatus: null, gstinVerifiedName: null, gstinVerifiedAt: null });
    expect(notifications.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'Verified partner changed their details', linkUrl: '/admin/users/p1' }));
  });
  test('sending the same values back changes nothing and tells nobody', async () => {
    await partners.updateProfile('p1', { gstin: '29ABCDE1234F1Z5', name: 'Asha', partnerSubType: 'AGENT' });
    expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('gstinVerificationStatus');
    expect(notifications.notifyAdmins).not.toHaveBeenCalled();
  });
  test('before KYC is verified the partner type can still be chosen', async () => {
    prisma.user.findUnique.mockResolvedValue(current({ kycStatus: 'NOT_SUBMITTED' }));
    await partners.updateProfile('p1', { partnerSubType: 'BUILDER' });
    expect(prisma.user.update).toHaveBeenCalled();
    expect(notifications.notifyAdmins).not.toHaveBeenCalled();
  });
});

describe('P8: route gates', () => {
  test('both doors to "book a visit" have the booking limiter', () => {
    expect(src('modules/partners/partners.routes.js')).toMatch(/post\('\/leads\/:id\/schedule-visit',\s*requireKyc,\s*visitBookingLimiter/);
  });
  test('the checklist routes need KYC, and posting a review has a limiter', () => {
    const routes = src('modules/properties/properties.routes.js');
    expect(routes).toMatch(/post\('\/:id\/checklist-documents', authenticate, requirePartner, requireKyc/);
    expect(routes).toMatch(/get\('\/:id\/checklist', authenticate, requirePartner, requireKyc/);
    expect(src('modules/reviews/reviews.routes.js')).toMatch(/post\('\/', authenticate, reviewLimiter/);
  });
});

describe('P9: a sold unit', () => {
  const units = require('../../src/modules/projects/projectUnit.service');
  beforeEach(() => { prisma.project.findUnique.mockResolvedValue({ builderId: 'b1' }); });

  test('its price cannot be changed by the builder; other details can', async () => {
    prisma.projectUnit.findFirst.mockResolvedValue({ id: 'u1', status: 'SOLD', price: 9_000_000 });
    await expect(units.updateUnit('pr1', 'u1', 'b1', { price: 5_000_000 })).rejects.toMatchObject({ statusCode: 409, data: { code: 'UNIT_SOLD_PRICE_LOCKED' } });
    prisma.projectUnit.update.mockResolvedValue({});
    await units.updateUnit('pr1', 'u1', 'b1', { price: 9_000_000, floorNumber: 4 });
    expect(prisma.projectUnit.update.mock.calls[0][0].data).toEqual({ price: 9_000_000, floorNumber: 4 });
  });
  test('it stays sold once a brokerage invoice exists', async () => {
    prisma.projectUnit.findFirst.mockResolvedValue({ id: 'u1', status: 'SOLD', unitNumber: 'A-101' });
    prisma.builderInvoice.findUnique.mockResolvedValue({ id: 'inv1' });
    await expect(units.setUnitStatus('pr1', 'u1', 'b1', 'AVAILABLE')).rejects.toMatchObject({ statusCode: 409, data: { code: 'UNIT_INVOICED' } });
    expect(prisma.projectUnit.updateMany).not.toHaveBeenCalled();
  });
  test('before the invoice it can be reopened, and the admins are told', async () => {
    prisma.projectUnit.findFirst.mockResolvedValue({ id: 'u1', status: 'SOLD', unitNumber: 'A-101' });
    prisma.builderInvoice.findUnique.mockResolvedValue(null);
    prisma.projectUnit.updateMany.mockResolvedValue({ count: 1 });
    prisma.projectUnit.findUnique.mockResolvedValue({ id: 'u1', status: 'AVAILABLE' });
    await units.setUnitStatus('pr1', 'u1', 'b1', 'AVAILABLE');
    expect(prisma.projectUnit.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'u1', status: 'SOLD' }, data: { status: 'AVAILABLE' } });
    expect(notifications.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sold unit reopened by the builder' }));
  });
  test('marking a unit sold tells nobody and is a single conditional write', async () => {
    prisma.projectUnit.findFirst.mockResolvedValue({ id: 'u1', status: 'AVAILABLE', unitNumber: 'A-101' });
    prisma.projectUnit.updateMany.mockResolvedValue({ count: 1 });
    await units.setUnitStatus('pr1', 'u1', 'b1', 'SOLD');
    expect(notifications.notifyAdmins).not.toHaveBeenCalled();
    expect(prisma.builderInvoice.findUnique).not.toHaveBeenCalled();
  });
});

describe('P10: one at a time', () => {
  test('a second payout change request while one is being made is told so, and makes no row', async () => {
    const partners = require('../../src/modules/partners/partners.service');
    prisma.user.findUnique.mockResolvedValue({ id: 'p1', razorpayFundAccountId: 'fa_1' });
    prisma.payoutAccountChange.findFirst.mockResolvedValue({ id: 'ch1', status: 'PENDING' });
    await expect(partners.requestPayoutAccountChange('p1', { legalName: 'A', accountNumber: '123456789', ifsc: 'HDFC0001234' })).rejects.toMatchObject({ data: { code: 'CHANGE_ALREADY_PENDING' } });
    expect(prisma.payoutAccountChange.create).not.toHaveBeenCalled();
    expect(prisma.counter.create.mock.calls[0][0].data.id).toBe('lock:payout-change:p1');
  });
  test('a conversion already running refuses a second click', async () => {
    const onboarding = require('../../src/modules/onboarding/onboarding.service');
    const busy = Object.assign(new Error('dup'), { code: 'P2002' });
    prisma.counter.create.mockRejectedValue(busy);
    prisma.counter.findUnique.mockResolvedValue({ id: 'lock:onboarding-convert:r1', seq: Math.floor(Date.now() / 1000) });
    await expect(onboarding.convertToListing('adm', 'r1', { partnerId: 'p1' }, 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'CONVERT_IN_PROGRESS' } });
    expect(prisma.onboardingRequest.findUnique).not.toHaveBeenCalled();
  });
  test('a suspended partner cannot be given a converted listing (P20)', async () => {
    const onboarding = require('../../src/modules/onboarding/onboarding.service');
    prisma.onboardingRequest.findUnique.mockResolvedValue({ id: 'r1', status: 'READY', convertedToId: null, propertyType: 'FLAT', data: {}, documents: [] });
    prisma.user.findFirst.mockResolvedValue({ id: 'p1', name: 'Asha', isSuspended: true });
    await expect(onboarding.convertToListing('adm', 'r1', { partnerId: 'p1' }, 'ip')).rejects.toMatchObject({ data: { code: 'PARTNER_SUSPENDED' } });
  });
  test('builder invoices are collected and disputed with a conditional write', async () => {
    const invoices = require('../../src/modules/projects/builderInvoice.service');
    prisma.builderInvoice.findUnique.mockResolvedValue({ id: 'i1', status: 'INVOICED', amount: 1000, builderId: 'b1' });
    prisma.builderInvoice.updateMany.mockResolvedValue({ count: 0 });
    await expect(invoices.collectInvoice('i1', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 409 });
    await expect(invoices.disputeInvoice('i1', 'wrong amount', 'adm', 'ip')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.builderInvoice.updateMany.mock.calls[0][0].where).toEqual({ id: 'i1', status: 'INVOICED' });
  });
});

describe('P11: advisor referrals', () => {
  const { createReferralSchema } = require('../../src/modules/referrals/referral.validator');
  const referrals = require('../../src/modules/referrals/referral.service');
  test('the phone is stored the way a lead stores it', () => {
    expect(createReferralSchema.parse({ buyerName: 'Ravi', buyerPhone: '98450 12345' }).buyerPhone).toBe('+919845012345');
    expect(createReferralSchema.parse({ buyerName: 'Ravi', buyerPhone: '+91 98450-12345' }).buyerPhone).toBe('+919845012345');
    expect(createReferralSchema.safeParse({ buyerName: 'Ravi', buyerPhone: '12345' }).success).toBe(false);
  });
  test('only a referral made before the lead counts', async () => {
    prisma.advisorReferral.findFirst.mockResolvedValue(null);
    const leadCreatedAt = new Date('2026-11-01T10:00:00Z');
    await referrals.getActiveReferralForPhone('+919845012345', leadCreatedAt);
    expect(prisma.advisorReferral.findFirst.mock.calls[0][0].where).toEqual({ buyerPhone: '+919845012345', status: 'ACTIVE', createdAt: { lte: leadCreatedAt } });
    expect(src('modules/commission/commission.service.js')).toMatch(/getActiveReferralForPhone\(lead\.buyerPhone, lead\.createdAt\)/);
  });
});

describe('P12: notifications link to a page, never to a private file', () => {
  test.each(['modules/commission/commission.service.js', 'modules/projects/builderInvoice.service.js'])('%s', (file) => {
    expect(src(file)).not.toMatch(/linkUrl:\s*(url|lead\.invoiceUrl)/);
  });
});

describe('P13: who may review a listing', () => {
  const reviews = require('../../src/modules/reviews/reviews.service');
  const input = { propertyId: 'x', rating: 5, title: 'Great', body: 'Lovely place' };
  beforeEach(() => { prisma.property.findFirst.mockResolvedValue({ id: 'x', partnerId: 'p1' }); });

  test('not the listing\'s own partner', async () => {
    await expect(reviews.postReview('p1', input)).rejects.toMatchObject({ statusCode: 403, data: { code: 'REVIEW_OWN_LISTING' } });
  });
  test('not another partner or staff', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'PARTNER' });
    await expect(reviews.postReview('p2', input)).rejects.toMatchObject({ data: { code: 'REVIEW_BUYERS_ONLY' } });
  });
  test('not a buyer who never enquired', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(reviews.postReview('b1', input)).rejects.toMatchObject({ data: { code: 'REVIEW_NEEDS_ENQUIRY' } });
    expect(prisma.propertyReview.create).not.toHaveBeenCalled();
  });
  test('a buyer who enquired can', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1' });
    prisma.propertyReview.findUnique.mockResolvedValue(null);
    prisma.propertyReview.create.mockResolvedValue({ id: 'r1' });
    await expect(reviews.postReview('b1', input)).resolves.toEqual({ id: 'r1' });
  });
});

describe('P14, P15: listing input limits and the way back from a rejection', () => {
  const { createPropertySchema } = require('../../src/modules/properties/properties.validator');
  const properties = require('../../src/modules/properties/properties.service');
  test('coordinates, lists and the description are bounded', () => {
    const shape = createPropertySchema.shape;
    expect(shape.latitude.safeParse(91).success).toBe(false);
    expect(shape.longitude.safeParse(-181).success).toBe(false);
    expect(shape.latitude.safeParse(12.97).success).toBe(true);
    expect(shape.description.safeParse('x'.repeat(10001)).success).toBe(false);
    expect(shape.amenities.safeParse(Array.from({ length: 101 }, () => 'Gym')).success).toBe(false);
    expect(shape.bankApprovals.safeParse(Array.from({ length: 41 }, () => 'SBI')).success).toBe(false);
  });
  test('editing a REJECTED listing sends it back to review', async () => {
    prisma.property.findUnique.mockResolvedValue({ id: 'x', partnerId: 'p1', publishStatus: 'REJECTED', images: [], videos: [] });
    prisma.property.update.mockImplementation(async ({ data }) => data);
    const out = await properties.updateProperty('x', 'p1', { title: 'A better title' });
    expect(prisma.property.update.mock.calls[0][0].data).toMatchObject({ title: 'A better title', publishStatus: 'PENDING_APPROVAL' });
    expect(out.message).toMatch(/resubmitted/);
  });
  test('an ARCHIVED listing cannot be edited by the partner', async () => {
    prisma.property.findUnique.mockResolvedValue({ id: 'x', partnerId: 'p1', publishStatus: 'ARCHIVED', images: [], videos: [] });
    await expect(properties.updateProperty('x', 'p1', { title: 'New title' })).rejects.toMatchObject({ data: { code: 'LISTING_ARCHIVED' } });
    expect(prisma.property.update).not.toHaveBeenCalled();
  });
});

describe('P19, P20: small leaks and loose ends', () => {
  test('a partner reading their own listing does not get the staff-only fields', async () => {
    const partners = require('../../src/modules/partners/partners.service');
    prisma.property.findFirst.mockResolvedValue({ id: 'x', title: 'Villa', adminEditNote: 'check the owner', changesRequestedByAdminId: 'adm1' });
    const out = await partners.getListing('p1', 'x');
    expect(out).toEqual({ id: 'x', title: 'Villa' });
  });
  test('an admin reply goes into the email as text', () => {
    expect(src('modules/partners/partnerTicket.admin.service.js')).toMatch(/escapeHtml\(adminReply\)/);
  });
  test('the link from an onboarding request to its listing cannot be typed in', async () => {
    const onboarding = require('../../src/modules/onboarding/onboarding.service');
    prisma.onboardingRequest.findUnique.mockResolvedValue({ id: 'r1', status: 'READY', adminNotes: [], documents: [], data: {} });
    await expect(onboarding.adminUpdate('adm', 'r1', { convertedToId: '64b000000000000000000001' }, 'ip')).rejects.toMatchObject({ data: { code: 'CONVERTED_LINK_READ_ONLY' } });
    expect(prisma.onboardingRequest.update).not.toHaveBeenCalled();
  });
});
