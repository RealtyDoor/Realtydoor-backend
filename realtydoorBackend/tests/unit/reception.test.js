// Reception desk (23 Nov 2026): recording site visits.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
  receptionVisit: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  leadNote: { create: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/modules/leads/leads.service', () => ({ completeVisitWithCode: jest.fn() }));
jest.mock('../../src/modules/admin/admin.service', () => ({ createLead: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const { notifyAdmins } = require('../../src/lib/notifications');
const leads = require('../../src/modules/leads/leads.service');
const admin = require('../../src/modules/admin/admin.service');
const svc = require('../../src/modules/reception/reception.service');
const { recordVisitSchema } = require('../../src/modules/reception/reception.validator');

const ID = '6afca91c6717f382bd10fc4c';
const staff = { id: '6afca91c6717f382bd10aaaa', name: 'Asha Reception', role: 'ADMIN', staffRole: 'RECEPTION', adminPermissions: ['RECEPTION'] };
const lead = (over = {}) => ({
  id: ID, refCode: 'RD-L-000200', buyerName: 'Ravi', buyerPhone: '+919876543210', status: 'SITE_VISIT_SCHEDULED',
  siteVisitScheduledAt: new Date(), otpLockedUntil: null, assignedPartnerId: 'p1', propertyInterest: null, doNotContactAt: null,
  property: { title: 'Vrunda City' }, assignedPartner: { name: 'Anil', companyName: 'Anil Realty' }, ...over,
});
const base = { leadId: ID, hostedByType: 'ASSIGNED_PARTNER', photoConsent: true };
const PHOTO = ['https://bucket/visits/a.jpg'];

beforeEach(() => {
  jest.clearAllMocks();
  prisma.receptionVisit.create.mockImplementation(({ data }) => Promise.resolve({ id: 'rv1', ...data }));
  prisma.leadNote.create.mockResolvedValue({});
});

describe('search', () => {
  test('returns masked cards only: last 4 digits, never the phone or the code', async () => {
    prisma.lead.findMany.mockResolvedValue([lead({ siteVisitOTP: '123456' })]);
    const [card] = await svc.searchLeads('Ravi');
    expect(card).toMatchObject({ buyerName: 'Ravi', phoneHint: '•••• 3210', broker: 'Anil Realty', property: 'Vrunda City' });
    expect(JSON.stringify(card)).not.toContain('9876543210');
    expect(card).not.toHaveProperty('siteVisitOTP');
    expect(prisma.lead.findMany.mock.calls[0][0].select).not.toHaveProperty('siteVisitOTP');
  });
  test('only booked visits, and a do-not-contact buyer is left out', async () => {
    prisma.lead.findMany.mockResolvedValue([lead(), lead({ id: 'x', doNotContactAt: new Date() })]);
    expect(await svc.searchLeads('3210')).toHaveLength(1);
    const where = prisma.lead.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('SITE_VISIT_SCHEDULED');
    expect(where.OR).toEqual(expect.arrayContaining([{ buyerPhone: { endsWith: '3210' } }]));
  });
});

describe('recording a visit', () => {
  test('a photo is required', async () => {
    await expect(svc.recordVisit(staff, base, [], '1.2.3.4')).rejects.toMatchObject({ statusCode: 400, data: { code: 'PHOTO_REQUIRED' } });
  });

  test('with the right code: the visit is completed through the broker path and recorded as verified', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    const r = await svc.recordVisit(staff, { ...base, code: '123456' }, PHOTO, '1.2.3.4');
    expect(leads.completeVisitWithCode).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), '123456', expect.objectContaining({ ip: '1.2.3.4', actor: { adminId: staff.id, role: 'ADMIN' } }));
    expect(r.codeVerified).toBe(true);
    expect(prisma.receptionVisit.create.mock.calls[0][0].data).toMatchObject({ codeVerified: true, recordedByStaffId: staff.id, recordedByName: 'Asha Reception', hostedByName: 'Anil Realty', photoUrls: PHOTO });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'VISIT_RECEPTION_LOGGED', adminId: staff.id, targetId: ID }));
    expect(notifyAdmins).not.toHaveBeenCalled(); // assigned broker + verified: nothing for admins to check
  });

  test('a wrong code (or a locked lead) saves nothing', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    leads.completeVisitWithCode.mockRejectedValueOnce(Object.assign(new Error('Incorrect OTP'), { statusCode: 400 }));
    await expect(svc.recordVisit(staff, { ...base, code: '000000' }, PHOTO)).rejects.toThrow('Incorrect OTP');
    expect(prisma.receptionVisit.create).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  test('without a code: kept as unverified, the lead is not touched, admins are told', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    const r = await svc.recordVisit(staff, base, PHOTO);
    expect(leads.completeVisitWithCode).not.toHaveBeenCalled();
    expect(r.codeVerified).toBe(false);
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('without the code') }));
  });

  test('hosted by someone else: their name and phone are kept and admins are told', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead());
    await svc.recordVisit(staff, { ...base, code: '123456', hostedByType: 'OTHER_PERSON', hostedByName: 'Suresh', hostedByPhone: '+919000000001' }, PHOTO);
    expect(prisma.receptionVisit.create.mock.calls[0][0].data).toMatchObject({ hostedByType: 'OTHER_PERSON', hostedByName: 'Suresh', hostedByPhone: '+919000000001' });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('not the assigned broker') }));
  });

  test('"assigned broker" is refused when nobody is assigned', async () => {
    prisma.lead.findUnique.mockResolvedValue(lead({ assignedPartnerId: null, assignedPartner: null }));
    await expect(svc.recordVisit(staff, base, PHOTO)).rejects.toMatchObject({ data: { code: 'NO_ASSIGNED_BROKER' } });
  });

  test('walk-in with no open lead: a WALK_IN lead is created, the entry is unverified', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    admin.createLead.mockResolvedValue({ id: 'new1' });
    prisma.lead.findUnique.mockResolvedValue(lead({ id: 'new1', status: 'UNASSIGNED', assignedPartnerId: null, assignedPartner: null }));
    const r = await svc.recordVisit(staff, { walkIn: true, buyerName: 'Meena', buyerPhone: '+919111111111', hostedByType: 'OTHER_PERSON', hostedByName: 'Front desk', photoConsent: true }, PHOTO, '1.2.3.4');
    expect(admin.createLead).toHaveBeenCalledWith(expect.objectContaining({ source: 'WALK_IN', buyerPhone: '+919111111111' }), staff.id, '1.2.3.4');
    expect(r).toMatchObject({ codeVerified: false, walkInLeadCreated: true });
    expect(leads.completeVisitWithCode).not.toHaveBeenCalled();
  });

  test('walk-in with an open lead reuses it, no duplicate lead', async () => {
    prisma.lead.findFirst.mockResolvedValue(lead({ status: 'ASSIGNED' }));
    const r = await svc.recordVisit(staff, { walkIn: true, buyerName: 'Ravi', buyerPhone: '+919876543210', hostedByType: 'ASSIGNED_PARTNER', photoConsent: true }, PHOTO);
    expect(admin.createLead).not.toHaveBeenCalled();
    expect(r.walkInLeadCreated).toBe(false);
  });

  test('visit time: up to two days late, never in the future', () => {
    const now = Date.now();
    expect(svc.visitTime(undefined, now).getTime()).toBe(now);
    expect(() => svc.visitTime(new Date(now + 60 * 60 * 1000), now)).toThrow(/future/);
    expect(() => svc.visitTime(new Date(now - 3 * 24 * 60 * 60 * 1000), now)).toThrow(/two days/);
    expect(svc.visitTime(new Date(now - 24 * 60 * 60 * 1000), now)).toBeInstanceOf(Date);
  });
});

describe('form rules', () => {
  test('consent is required, and multipart strings are understood', () => {
    expect(recordVisitSchema.safeParse({ ...base, photoConsent: 'false' }).success).toBe(false);
    expect(recordVisitSchema.safeParse({ ...base, photoConsent: 'true' }).success).toBe(true);
  });
  test('the code has 6 digits; a walk-in has none', () => {
    expect(recordVisitSchema.safeParse({ ...base, code: '12345' }).success).toBe(false);
    expect(recordVisitSchema.safeParse({ walkIn: 'true', buyerName: 'Meena', buyerPhone: '9111111111', code: '123456', hostedByType: 'ASSIGNED_PARTNER', photoConsent: 'true' }).success).toBe(false);
  });
  test('someone else needs a name; a booked visit needs the lead', () => {
    expect(recordVisitSchema.safeParse({ ...base, hostedByType: 'OTHER_PERSON' }).success).toBe(false);
    expect(recordVisitSchema.safeParse({ hostedByType: 'ASSIGNED_PARTNER', photoConsent: true }).success).toBe(false);
  });
});

describe('admin list', () => {
  test('filters and caps', async () => {
    prisma.receptionVisit.findMany.mockResolvedValue([]);
    prisma.receptionVisit.count.mockResolvedValue(0);
    await svc.adminList({ from: '2026-11-23', to: '2026-11-23', verified: 'no', page: 2, limit: 50 });
    const args = prisma.receptionVisit.findMany.mock.calls[0][0];
    expect(args.where.codeVerified).toBe(false);
    expect(args.where.visitedAt.gte.toISOString()).toBe('2026-11-22T18:30:00.000Z');
    expect(args.where.visitedAt.lt.toISOString()).toBe('2026-11-23T18:30:00.000Z');
    expect(args).toMatchObject({ skip: 50, take: 50 });
  });
});

