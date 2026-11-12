// Audit Nov 2026, phase 3 (leads and visits). One test or more per finding L1 to L12; see admin-nextjs/docs/AUDIT_2026-11.md.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  user: { findMany: jest.fn(), findFirst: jest.fn() },
  escrowTransaction: { count: jest.fn() },
  leadIntakeEvent: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
  leadNote: { create: jest.fn().mockResolvedValue({}) },
}));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue(), createNotification: jest.fn().mockResolvedValue(), broadcastNotification: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/wati', () => ({ sendSiteVisitOtp: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/accountDeletion', () => ({ assertLeadNotPaused: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(2), getConfigBool: jest.fn(), getConfig: jest.fn() }));

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/lib/prisma');
const { sendSiteVisitOtp } = require('../../src/lib/wati');
const leads = require('../../src/modules/leads/leads.service');
const src = (p) => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');

const HOUR = 3600e3;
const lead = (over = {}) => ({
  id: 'l1', refCode: 'RD-L-1', assignedPartnerId: 'p1', buyerId: 'b1', buyerName: 'Buyer', buyerPhone: '+919000000001', status: 'SITE_VISIT_SCHEDULED',
  siteVisitOTP: '123456', otpAttempts: 0, otpLockedUntil: null, otpExpiresAt: new Date(Date.now() + HOUR), siteVisitScheduledAt: new Date(Date.now() - HOUR), ...over,
});
beforeEach(() => {
  jest.clearAllMocks();
  prisma.lead.update.mockImplementation(async ({ data }) => ({ ...lead(), ...data }));
  prisma.user.findMany.mockResolvedValue([]);
});

describe('L1: the feedback and follow-up jobs find leads whose date was never set', () => {
  const { dueWhere, notYet } = require('../../src/jobs/whatsappFeedback');
  test('"not yet" matches both a null and a missing field (MongoDB treats them differently)', () => {
    expect(notYet('whatsappSentAt')).toEqual({ OR: [{ whatsappSentAt: null }, { whatsappSentAt: { isSet: false } }] });
  });
  test('feedback: verified 24 hours to 7 days ago, not dropped, not sent, not "do not contact"', () => {
    const now = Date.now();
    const w = dueWhere(now);
    expect(w).not.toHaveProperty('whatsappSentAt'); // the old plain null test, which matched nothing
    expect(w.otpVerifiedAt.lte.getTime()).toBe(now - 24 * HOUR);
    expect(w.otpVerifiedAt.gte.getTime()).toBe(now - 7 * 24 * HOUR); // an old backlog is not messaged months late
    expect(w.status).toEqual({ not: 'DROPPED' });
    expect(w.AND).toEqual([notYet('whatsappSentAt'), notYet('doNotContactAt')]);
  });
  test('the still-deciding follow-up uses the same rule and skips "do not contact"', () => {
    const w = require('../../src/jobs/stillDecidingFollowup').dueWhere(Date.now());
    expect(JSON.stringify(w)).toContain('"doNotContactAt":{"isSet":false}');
    expect(JSON.stringify(w)).not.toMatch(/"(followUpSentAt|stillDecidingFollowupSentAt)":null[,}](?!.*isSet)/);
  });
  test('a buyer reply is matched to a lead whose reply date was never set', () => {
    expect(src('modules/webhooks/wati.handler.js')).toMatch(/feedbackReceivedAt: null \}, \{ feedbackReceivedAt: \{ isSet: false \} \}/);
  });
});

describe('L2 and L5: what a partner and a buyer are sent', () => {
  const { Prisma } = require('@prisma/client');
  const columns = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Lead').fields.filter((f) => f.kind !== 'object').map((f) => f.name);
  test('every Lead column is listed as visible or hidden for the partner, so a new column cannot leak by default', () => {
    const listed = new Set([...leads.PARTNER_VISIBLE_LEAD_FIELDS, ...leads.PARTNER_HIDDEN_LEAD_FIELDS]);
    expect(columns.filter((c) => !listed.has(c))).toEqual([]);
    expect(leads.PARTNER_VISIBLE_LEAD_FIELDS.filter((c) => leads.PARTNER_HIDDEN_LEAD_FIELDS.includes(c))).toEqual([]);
  });
  test('and for the buyer', () => {
    const listed = new Set([...leads.BUYER_VISIBLE_LEAD_FIELDS, ...leads.BUYER_HIDDEN_LEAD_FIELDS]);
    expect(columns.filter((c) => !listed.has(c))).toEqual([]);
    expect(leads.BUYER_VISIBLE_LEAD_FIELDS.filter((c) => leads.BUYER_HIDDEN_LEAD_FIELDS.includes(c))).toEqual([]);
  });
  test('the partner never gets the visit code, the raw form answers or the commission working', () => {
    const out = leads.sanitizeLeadForPartner({ ...lead(), intakeAnswers: { secret: 'x' }, isOtpVerified: true });
    expect(out.siteVisitOTP).toBeUndefined();
    expect(out.intakeAnswers).toBeUndefined();
    for (const f of leads.PARTNER_HIDDEN_LEAD_FIELDS) expect(out).not.toHaveProperty(f);
  });
  test('the partner lead page reads the listing through the public field list', () => {
    expect(src('modules/leads/leads.service.js')).toMatch(/PUBLIC_PROPERTY_FIELDS\.map\(\(f\) => \[f, true\]\)/);
  });
});

describe('L3: "do not contact" stops every message to the buyer', () => {
  test.each([
    ['booking a visit', () => leads.scheduleVisit('l1', 'p1', new Date())],
    ['resending the code', () => leads.resendOtp('l1', 'p1')],
  ])('%s is refused and nothing is sent', async (_n, run) => {
    prisma.lead.findFirst.mockResolvedValue(lead({ doNotContactAt: new Date() }));
    await expect(run()).rejects.toMatchObject({ statusCode: 409, data: { code: 'DO_NOT_CONTACT' } });
    expect(sendSiteVisitOtp).not.toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('the mark belongs to the number: a new lead for it carries the mark', async () => {
    const { doNotContactSince } = require('../../src/lib/doNotContact');
    const since = new Date('2026-11-01');
    prisma.lead.findFirst.mockResolvedValue({ doNotContactAt: since });
    expect(await doNotContactSince('+919000000001')).toBe(since);
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ buyerPhone: '+919000000001', doNotContactAt: { not: null } });
    prisma.lead.findFirst.mockResolvedValue(null);
    expect(await doNotContactSince('+919000000002')).toBeNull();
    expect(await doNotContactSince(null)).toBeNull();
    for (const f of ['modules/admin/admin.service.js', 'modules/leads/leads.service.js', 'modules/leadIntake/leadIntake.service.js']) {
      expect(src(f)).toMatch(/doNotContactSince\(/);
      expect(src(f)).toMatch(/dncSince && \{ doNotContactAt: dncSince \}/);
    }
  });
  test('the visit reminder and the admin "send a new code" button respect it too', () => {
    expect(src('jobs/visitReminder.js')).toMatch(/doNotContactAt/);
    expect(src('modules/admin/admin.service.js')).toMatch(/overrideLeadOtp[\s\S]{0,700}DO_NOT_CONTACT[\s\S]{0,300}SITE_VISIT_SCHEDULED/);
  });
});

describe('L4: visit actions only on a lead in the right state, and no flood of codes', () => {
  test.each(['UNASSIGNED', 'AWAITING_ADMIN', 'SITE_VISIT_DONE', 'CLOSED', 'DROPPED'])('a %s lead cannot be booked', async (status) => {
    prisma.lead.findFirst.mockResolvedValue(lead({ status }));
    await expect(leads.scheduleVisit('l1', 'p1', new Date())).rejects.toMatchObject({ statusCode: 400, data: { code: 'LEAD_NOT_OPEN' } });
    expect(sendSiteVisitOtp).not.toHaveBeenCalled();
  });
  test.each(['ASSIGNED', 'SITE_VISIT_DONE', 'CLOSED', 'DROPPED'])('a %s lead cannot be sent a new code or verified', async (status) => {
    prisma.lead.findFirst.mockResolvedValue(lead({ status }));
    await expect(leads.resendOtp('l1', 'p1')).rejects.toMatchObject({ data: { code: 'LEAD_NOT_OPEN' } });
    await expect(leads.verifyOtp('l1', 'p1', '123456', '1.1.1.1')).rejects.toMatchObject({ data: { code: 'LEAD_NOT_OPEN' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('re-booking does not open a locked visit: three wrong codes stay three wrong codes', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpAttempts: 3, otpLockedUntil: new Date(Date.now() + HOUR) }));
    await expect(leads.scheduleVisit('l1', 'p1', new Date())).rejects.toMatchObject({ statusCode: 429, data: { code: 'LEAD_OTP_LOCKED' } });
    expect(sendSiteVisitOtp).not.toHaveBeenCalled();
  });
  test('re-booking keeps the wrong-guess count', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpAttempts: 2 }));
    await leads.scheduleVisit('l1', 'p1', new Date(Date.now() + HOUR));
    const data = prisma.lead.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('otpAttempts');
    expect(data).not.toHaveProperty('otpLockedUntil');
  });
  test.each([
    ['book', () => leads.scheduleVisit('l1', 'p1', new Date())],
    ['resend', () => leads.resendOtp('l1', 'p1')],
  ])('%s: a second code within a minute is refused', async (_n, run) => {
    prisma.lead.findFirst.mockResolvedValue(lead({ otpGeneratedAt: new Date(Date.now() - 20e3) }));
    await expect(run()).rejects.toMatchObject({ statusCode: 429, data: { code: 'OTP_JUST_SENT' } });
    expect(sendSiteVisitOtp).not.toHaveBeenCalled();
  });
  test('booking has its own per-partner limit, separate from the 5 an hour for codes', () => {
    expect(src('modules/leads/leads.routes.js')).toMatch(/schedule-visit', authenticate, requirePartner, requireKyc, visitBookingLimiter/);
    expect(src('middleware/rateLimiter.js')).toMatch(/visitBookingLimiter/);
  });
});

describe('L6: a suspended or deleted partner is not given leads', () => {
  test('every place that picks a partner for a lead filters them out', () => {
    const text = src('modules/admin/admin.service.js');
    expect(text.match(/role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: \{ not: true \}, deletedAt: \{ isSet: false \}/g)).toHaveLength(3); // create, confirm, assign
    expect(text).toMatch(/deletedAt: \{ isSet: false \}, isSuspended: \{ not: true \}/); // the ranked list
    expect(text).toMatch(/id: rule\.targetPartnerId, role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: \{ not: true \}/); // a routing rule's partner
  });
});

describe('L7: proof on a deal', () => {
  const file = 'https://x/letter.pdf';
  test('nothing can be uploaded to a dropped lead', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ status: 'DROPPED' }));
    await expect(leads.uploadDocs('l1', 'p1', {}, { allocationLetter: file })).rejects.toMatchObject({ statusCode: 400, data: { code: 'LEAD_NOT_OPEN' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('a verified allocation letter cannot be swapped for another', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ status: 'SITE_VISIT_DONE', allocationLetterVerifiedAt: new Date() }));
    await expect(leads.uploadDocs('l1', 'p1', {}, { allocationLetter: file })).rejects.toMatchObject({ statusCode: 409, data: { code: 'LETTER_ALREADY_VERIFIED' } });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('a partner can confirm a no-show only on their own lead; admin only after the slot has passed', async () => {
    expect(src('modules/leads/leads.service.js')).toMatch(/async function partnerConfirmNoShow[\s\S]{0,400}assignedPartnerId: partnerId/);
    prisma.lead.findUnique.mockResolvedValue(lead({ siteVisitScheduledAt: new Date(Date.now() + HOUR), isOtpVerified: false }));
    await expect(leads.adminConfirmNoShow('l1', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});

describe('L8: lead intake', () => {
  const intake = require('../../src/modules/leadIntake/leadIntake.service');
  test('keys sent inside the form body are never stored', () => {
    expect(intake.withoutSecrets({ name: 'A', google_key: 'abc', secret: 'def' })).toEqual({ name: 'A', google_key: '[removed]', secret: '[removed]' });
    expect(intake.withoutSecrets(null)).toBeNull();
  });
  test('a retry of a lead that failed part-way is taken up, once, and not answered "already received"', () => {
    const text = src('modules/leadIntake/leadIntake.service.js');
    expect(text).toMatch(/prior\?\.status === 'ERROR' && !prior\.leadId/);
    expect(text).toMatch(/updateMany\(\{ where: \{ id: prior\.id, status: 'ERROR' \}, data: \{ status: 'RECEIVED'/);
    expect(text).toMatch(/if \(retry\.count !== 1\) return \{ status: 'DUPLICATE'/);
  });
});

describe('L11 and L12: jobs and the NRI form', () => {
  test('every capped query in the lead hygiene job is ordered, so a full batch never skips the same leads', () => {
    const text = src('jobs/leadHygiene.js');
    const capped = text.match(/take: (500|200)/g).length;
    expect(capped).toBe(10);
    expect(text.match(/orderBy: \{ (createdAt|siteVisitScheduledAt): 'asc' \},[^\n]*\n?\s*take: (500|200)/g)).toHaveLength(capped);
  });
  test('the NRI form stores the phone in the standard form', () => {
    expect(src('modules/nriLeads/nriLeads.controller.js')).toMatch(/data\.phone = normalizePhone\(data\.phone\) \|\| data\.phone/);
  });
});
