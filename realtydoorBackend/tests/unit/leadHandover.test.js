// Wave 2 of lead hygiene: a partner who can no longer work their leads, moving a lead that is already in progress, and drop reason codes.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  user: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue({}), markNotificationsRead: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn(), notifyAdmins: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/lib/email', () => new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/lib/wati', () => ({ notifyUser: jest.fn(), sendLeadAssignedNotice: jest.fn().mockResolvedValue(undefined), sendSiteVisitOtp: jest.fn(), sendTicketVendorDispatched: jest.fn() }));
jest.mock('../../src/modules/partners/dataAck.service', () => ({ checkLeadDataHandlingGate: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/lib/accountDeletion', () => ({ assertLeadNotPaused: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/modules/money/moneyConfig', () => ({ getMoneySettings: jest.fn().mockResolvedValue({ partnerLeadWindowDays: 60 }) }));

const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const { notifyAdmins } = require('../../src/lib/notifications');
const { returnPartnerLeadsToPool } = require('../../src/lib/partnerHandover');
const admin = require('../../src/modules/admin/admin.service');
const leadsSvc = require('../../src/modules/leads/leads.service');
const { requestDropSchema } = require('../../src/modules/leads/leads.validator');
const { rejectLeadSchema, assignLeadSchema } = require('../../src/modules/admin/admin.validator');

const L = (over = {}) => ({ id: 'l1', refCode: 'RD-L-000001', status: 'ASSIGNED', assignedPartnerId: 'P1', isOtpVerified: false, siteVisitScheduledAt: null, escrowTransactions: [], ...over });

describe('returnPartnerLeadsToPool: a partner who can no longer work their leads', () => {
  beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockResolvedValue({}); });

  test('open, untouched leads go back to the pool; a booked visit is cancelled', async () => {
    prisma.lead.findMany.mockResolvedValue([L(), L({ id: 'l2', refCode: 'RD-L-000002', status: 'SITE_VISIT_SCHEDULED', siteVisitScheduledAt: new Date() })]);
    const out = await returnPartnerLeadsToPool('P1', 'admin1', '1.1.1.1', 'suspended');
    expect(out).toEqual({ moved: 2, stuck: [] });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ assignedPartnerId: null, status: 'UNASSIGNED', assignedAt: null });
    expect(prisma.lead.update.mock.calls[0][0].data.siteVisitScheduledAt).toBeUndefined();
    expect(prisma.lead.update.mock.calls[1][0].data).toMatchObject({ status: 'UNASSIGNED', siteVisitScheduledAt: null, siteVisitOTP: null, otpAttempts: 0 });
    expect(createAuditLog).toHaveBeenCalledTimes(2);
  });

  test('a lead with a token held or a verified visit stays with the partner and is listed for an admin', async () => {
    prisma.lead.findMany.mockResolvedValue([
      L({ id: 'a', refCode: 'RD-L-A', escrowTransactions: [{ status: 'HELD' }] }),
      L({ id: 'b', refCode: 'RD-L-B', isOtpVerified: true, status: 'SITE_VISIT_DONE' }),
      L({ id: 'c', refCode: 'RD-L-C' }),
    ]);
    const out = await returnPartnerLeadsToPool('P1', 'admin1', '1.1.1.1', 'suspended');
    expect(out).toEqual({ moved: 1, stuck: ['RD-L-A', 'RD-L-B'] });
    expect(prisma.lead.update).toHaveBeenCalledTimes(1);
    expect(prisma.lead.update.mock.calls[0][0].where).toEqual({ id: 'c' });
    expect(notifyAdmins.mock.calls[0][0].message).toContain('RD-L-A, RD-L-B');
  });

  test('asks only for this partner\'s open leads, and tells nobody when there are none', async () => {
    prisma.lead.findMany.mockResolvedValue([]);
    expect(await returnPartnerLeadsToPool('P1', 'admin1', 'ip', 'suspended')).toEqual({ moved: 0, stuck: [] });
    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({ assignedPartnerId: 'P1', status: { notIn: ['CLOSED', 'DROPPED'] } });
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  test('a system run (account deletion) is recorded as the system, not an admin', async () => {
    prisma.lead.findMany.mockResolvedValue([L()]);
    await returnPartnerLeadsToPool('P1', null, null, 'account deleted');
    expect(createAuditLog.mock.calls[0][0]).toMatchObject({ adminId: null, actorRole: 'SYSTEM', action: 'LEAD_RETURNED_TO_POOL' });
  });
});

describe('suspending a user', () => {
  beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockResolvedValue({}); });
  test('a partner\'s leads are handed back and the result says how many', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'P1', role: 'PARTNER', isSuspended: false });
    prisma.user.update.mockResolvedValue({ id: 'P1', role: 'PARTNER', isSuspended: true });
    prisma.lead.findMany.mockResolvedValue([L(), L({ id: 'x', refCode: 'RD-L-X', escrowTransactions: [{ status: 'FROZEN' }] })]);
    const out = await admin.suspendUser('P1', true, 'fraud check', 'admin1', '1.1.1.1');
    expect(out).toMatchObject({ isSuspended: true, leadsReturned: 1, leadsNeedingDecision: ['RD-L-X'] });
  });
  test('a buyer, a reinstated partner and nothing else is touched', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'U1', role: 'USER', isSuspended: false });
    prisma.user.update.mockResolvedValue({ id: 'U1', isSuspended: true });
    expect((await admin.suspendUser('U1', true, 'x', 'admin1', 'ip')).leadsReturned).toBeUndefined();
    prisma.user.findUnique.mockResolvedValue({ id: 'P1', role: 'PARTNER', isSuspended: true });
    prisma.user.update.mockResolvedValue({ id: 'P1', isSuspended: false });
    await admin.suspendUser('P1', false, null, 'admin1', 'ip');
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });
});

describe('assignLead: moving a lead that is already with a partner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue({ id: 'P2', name: 'Meera', email: 'm@x.in' });
    prisma.lead.update.mockImplementation(async ({ data }) => ({ id: 'l1', ...data }));
  });
  const withLead = (over) => prisma.lead.findUnique.mockResolvedValue({ ...L(), buyerName: 'Asha', buyerId: null, property: { title: 'Villa', partnerId: 'X' }, ...over });

  test('a plain reassign of an untouched lead still works, and is audited', async () => {
    withLead({});
    await expect(admin.assignLead('l1', 'P2', 'admin1', 'ip')).resolves.toMatchObject({ assignedPartnerId: 'P2', status: 'ASSIGNED' });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEAD_REASSIGNED' }));
  });
  test('refused while a token is held or after the buyer has met the partner', async () => {
    withLead({ escrowTransactions: [{ status: 'HELD' }] });
    await expect(admin.assignLead('l1', 'P2', 'admin1', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'REASSIGN_BLOCKED_MONEY' } });
    withLead({ isOtpVerified: true });
    await expect(admin.assignLead('l1', 'P2', 'admin1', 'ip')).rejects.toMatchObject({ data: { code: 'REASSIGN_BLOCKED_VISIT_DONE' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('a booked visit needs a reason, then it is cancelled and the OTP cleared', async () => {
    withLead({ status: 'SITE_VISIT_SCHEDULED', siteVisitScheduledAt: new Date(), siteVisitOTP: '1234' });
    await expect(admin.assignLead('l1', 'P2', 'admin1', 'ip')).rejects.toMatchObject({ data: { code: 'REASSIGN_REASON_REQUIRED' } });
    await admin.assignLead('l1', 'P2', 'admin1', 'ip', 'Partner stopped answering');
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ assignedPartnerId: 'P2', siteVisitScheduledAt: null, siteVisitOTP: null, otpAttempts: 0 });
    expect(createAuditLog.mock.calls.find(([a]) => a.action === 'LEAD_REASSIGNED')[0].after).toMatchObject({ visitCancelled: true, reason: 'Partner stopped answering' });
  });
  test('assigning a lead nobody holds is not a reassignment and is never blocked', async () => {
    withLead({ assignedPartnerId: null, status: 'UNASSIGNED' });
    await expect(admin.assignLead('l1', 'P2', 'admin1', 'ip')).resolves.toBeTruthy();
  });
});

describe('drop reason codes', () => {
  test('the codes are accepted, an unknown one is not, and the plain reason is still required', () => {
    expect(requestDropSchema.parse({ reason: 'Number is wrong', reasonCode: 'INVALID_NUMBER' }).reasonCode).toBe('INVALID_NUMBER');
    expect(requestDropSchema.parse({ reason: 'Number is wrong' }).reasonCode).toBeUndefined();
    expect(() => requestDropSchema.parse({ reason: 'Number is wrong', reasonCode: 'BORED' })).toThrow();
    expect(() => requestDropSchema.parse({ reasonCode: 'OTHER' })).toThrow();
    expect(rejectLeadSchema.parse({ reason: 'Looks fake', reasonCode: 'DUPLICATE' }).reasonCode).toBe('DUPLICATE');
    expect(assignLeadSchema.parse({ partnerId: '64b000000000000000000001', reason: ' because ' }).reason).toBe('because');
  });
  test('a partner\'s drop request keeps its code until the admin approves, and then it is on the dropped lead', async () => {
    prisma.lead.findFirst = jest.fn().mockResolvedValue({ id: 'l1', status: 'ASSIGNED', assignedPartnerId: 'P1', dropRequestedByPartner: false, refCode: 'RD-L-1' });
    prisma.user.findMany.mockResolvedValue([]);
    await leadsSvc.requestDrop('l1', 'P1', 'Wrong number given', 'INVALID_NUMBER');
    expect(prisma.lead.update.mock.calls.at(-1)[0].data).toMatchObject({ dropRequestReasonCode: 'INVALID_NUMBER', dropRequestNote: 'Wrong number given' });
    await leadsSvc.requestDrop('l1', 'P1', 'Not interested now');
    expect(prisma.lead.update.mock.calls.at(-1)[0].data.dropRequestReasonCode).toBe('OTHER');
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', status: 'ASSIGNED', dropRequestedByPartner: true, dropRequestNote: 'Wrong number given', dropRequestReasonCode: 'INVALID_NUMBER', assignedPartnerId: 'P1' });
    await leadsSvc.adminApproveDrop('l1', 'admin1', 'ip');
    expect(prisma.lead.update.mock.calls.at(-1)[0].data).toMatchObject({ status: 'DROPPED', droppedReasonCode: 'INVALID_NUMBER', droppedReason: 'Wrong number given' });
  });
  test('an admin rejecting a partner-added lead records a code, defaulting to OTHER', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', status: 'AWAITING_ADMIN', addedByPartnerId: 'P1', refCode: 'RD-L-1', buyerName: 'A' });
    await admin.rejectLead('l1', 'Looks fake', 'admin1', 'ip', 'INVALID_NUMBER');
    expect(prisma.lead.update.mock.calls.at(-1)[0].data.droppedReasonCode).toBe('INVALID_NUMBER');
    await admin.rejectLead('l1', 'Looks fake', 'admin1', 'ip');
    expect(prisma.lead.update.mock.calls.at(-1)[0].data.droppedReasonCode).toBe('OTHER');
  });
});
