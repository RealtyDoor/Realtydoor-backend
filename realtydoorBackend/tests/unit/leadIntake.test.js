// Lead integrations: cleaning an incoming lead, matching a form to a project, the keys, and the intake rules.
jest.mock('../../src/lib/prisma', () => ({
  leadIntegration: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  leadIntakeEvent: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  leadSourceMapping: { create: jest.fn(), deleteMany: jest.fn() },
  lead: { findFirst: jest.fn(), create: jest.fn() },
  leadNote: { create: jest.fn().mockResolvedValue({}) },
  project: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/refCode', () => ({ nextRefCode: jest.fn().mockResolvedValue('RD-L-000500') }));
jest.mock('../../src/modules/leads/leads.service', () => ({ evaluateBuyerOwnership: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { notifyAdmins } = require('../../src/lib/notifications');
const leadsService = require('../../src/modules/leads/leads.service');
const li = require('../../src/lib/leadIntake');
const service = require('../../src/modules/leadIntake/leadIntake.service');
const ctrl = require('../../src/modules/leadIntake/leadIntake.controller');

const integ = (over = {}) => ({ id: 'i1', name: 'Meta Lakeview', kind: 'META', isActive: true, defaultSource: 'OTHER', defaultCampaign: null, defaultProjectId: null, consentAssumed: true, mappings: [], ...over });

describe('normalizeIncoming', () => {
  test('accepts the many names senders use and cleans the phone', () => {
    const f = li.normalizeIncoming({ full_name: 'Asha K', mobile: '98765 43210', email: 'a@x.com', form_id: 'F1', campaign_name: 'Lakeview', utm_source: 'ig', gclid: 'g1', lead_id: 'L7', source: 'Instagram' });
    expect(f).toMatchObject({ name: 'Asha K', phone: '+919876543210', email: 'a@x.com', formId: 'F1', campaign: 'Lakeview', adClickId: 'g1', externalId: 'L7', sourceWord: 'INSTAGRAM' });
  });
  test('reads a Google Ads lead form (user_column_data)', () => {
    const f = li.normalizeIncoming({ lead_id: 'G1', form_id: '9', campaign_id: '55', gcl_id: 'abc', user_column_data: [{ column_id: 'FULL_NAME', column_value: 'Ravi S' }, { column_id: 'PHONE_NUMBER', column_value: '+91 90000 00001' }, { column_id: 'CITY', column_value: 'Bengaluru' }] });
    expect(f).toMatchObject({ name: 'Ravi S', phone: '+919000000001', city: 'Bengaluru', formId: '9', campaignId: '55', adClickId: 'abc', externalId: 'G1' });
  });
  test('a missing or invalid phone comes back null, never throws', () => {
    expect(li.normalizeIncoming({ name: 'X' }).phone).toBeNull();
    expect(li.normalizeIncoming({ phone: '123' }).phone).toBeNull();
    expect(li.normalizeIncoming(null).name).toBe('Unknown');
  });
});

describe('resolveMapping and externalId', () => {
  const maps = [
    { matchField: 'formId', matchValue: 'F-LAKE', projectId: 'p1' },
    { matchField: 'campaign', matchValue: 'Whitefield Villas', projectId: 'p2', campaignLabel: 'WF villas' },
    { matchField: 'project', matchValue: 'Greenpark', projectId: 'p3' },
  ];
  test('form id first, then campaign, then the project word the form sends; not case sensitive', () => {
    expect(li.resolveMapping(maps, { formId: 'f-lake', campaign: 'Whitefield Villas' }).projectId).toBe('p1');
    expect(li.resolveMapping(maps, { campaign: 'whitefield villas' }).projectId).toBe('p2');
    expect(li.resolveMapping(maps, { projectWord: 'GREENPARK' }).projectId).toBe('p3');
    expect(li.resolveMapping(maps, { formId: 'other' })).toBeNull();
  });
  test('the same lead without an id gets the same stand-in id on the same day', () => {
    const f = { phone: '+919000000001', campaign: 'c' };
    const d = new Date('2026-11-04T10:00:00Z');
    expect(li.externalIdFor(f, d)).toBe(li.externalIdFor(f, new Date('2026-11-04T20:00:00Z')));
    expect(li.externalIdFor(f, d)).not.toBe(li.externalIdFor(f, new Date('2026-11-05T10:00:00Z')));
    expect(li.externalIdFor({ externalId: 'X1' })).toBe('X1');
  });
});

describe('keys', () => {
  test('the secret matches only its own hash, and a wrong or empty one never does', () => {
    const s = li.newSecret();
    const h = li.hashSecret(s);
    expect(li.secretMatches(s, h)).toBe(true);
    expect(li.secretMatches('ls_wrong', h)).toBe(false);
    expect(li.secretMatches('', h)).toBe(false);
    expect(li.secretMatches(s, undefined)).toBe(false);
    expect(li.newKeyId()).toMatch(/^lk_[0-9a-f]{16}$/);
  });
  test('creating an integration returns the secret once and never the hash', async () => {
    prisma.leadIntegration.create.mockImplementation(async ({ data }) => ({ id: 'i1', ...data }));
    const out = await service.createIntegration({ name: 'Google leads', kind: 'GOOGLE_ADS' }, 'admin1');
    expect(out.secret).toMatch(/^ls_/);
    expect(out.secretHash).toBeUndefined();
    expect(prisma.leadIntegration.create.mock.calls[0][0].data.secretHash).toBe(li.hashSecret(out.secret));
  });
  test('authenticate: wrong key, wrong secret and switched-off all look the same', async () => {
    const s = li.newSecret();
    prisma.leadIntegration.findUnique.mockResolvedValue(integ({ secretHash: li.hashSecret(s) }));
    await expect(service.authenticate('lk_x', s)).resolves.toMatchObject({ id: 'i1' });
    await expect(service.authenticate('lk_x', 'nope')).rejects.toMatchObject({ statusCode: 401 });
    prisma.leadIntegration.findUnique.mockResolvedValue(integ({ isActive: false, secretHash: li.hashSecret(s) }));
    await expect(service.authenticate('lk_x', s)).rejects.toMatchObject({ statusCode: 401 });
    prisma.leadIntegration.findUnique.mockResolvedValue(null);
    await expect(service.authenticate('lk_x', s)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('ingest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.leadIntakeEvent.create.mockResolvedValue({ id: 'e1' });
    prisma.leadIntakeEvent.update.mockResolvedValue({});
    prisma.leadIntegration.update.mockResolvedValue({});
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.lead.create.mockImplementation(async ({ data }) => ({ id: 'L1', ...data }));
    prisma.project.findUnique.mockResolvedValue({ title: 'Lakeview', city: 'Bengaluru' });
    leadsService.evaluateBuyerOwnership.mockResolvedValue({ reason: 'NEW_BUYER' });
  });

  test('a new lead is created in the sales queue with its source, campaign and project, and admins are told', async () => {
    const i = integ({ mappings: [{ matchField: 'formId', matchValue: 'F1', projectId: 'p1', campaignLabel: 'Lakeview Meta', source: 'INSTAGRAM' }] });
    const out = await service.ingest(i, { name: 'Asha', phone: '9876543210', form_id: 'F1', lead_id: 'X1', utm_source: 'ig', message: 'Call me' });
    expect(out).toMatchObject({ status: 'CREATED', leadId: 'L1' });
    expect(prisma.lead.create.mock.calls[0][0].data).toMatchObject({
      buyerPhone: '+919876543210', source: 'INSTAGRAM', campaign: 'Lakeview Meta', projectId: 'p1', status: 'UNASSIGNED', propertyInterest: 'Lakeview',
      utmSource: 'ig', intakeIntegrationId: 'i1', buyerConsentAt: expect.any(Date),
    });
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('instagram') }));
    expect(prisma.leadIntegration.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: expect.objectContaining({ leadCount: { increment: 1 } }) });
  });

  test('the same lead sent twice is one lead', async () => {
    prisma.leadIntakeEvent.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    prisma.leadIntakeEvent.findFirst.mockResolvedValue({ leadId: 'L9' });
    const out = await service.ingest(integ(), { name: 'A', phone: '9876543210', lead_id: 'X1' });
    expect(out).toEqual({ status: 'DUPLICATE', leadId: 'L9', reason: 'Already received' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  test('no valid phone: rejected and logged, nothing created', async () => {
    const out = await service.ingest(integ(), { name: 'A', phone: 'abc' });
    expect(out.status).toBe('REJECTED');
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(prisma.leadIntakeEvent.create.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED' });
  });

  test('a buyer a partner already holds is not added again: a note goes on the partner lead instead', async () => {
    leadsService.evaluateBuyerOwnership.mockResolvedValue({ reason: 'OTHER_PARTNER', holderPartnerId: 'P1' });
    prisma.lead.findFirst.mockResolvedValue({ id: 'LP1' });
    const out = await service.ingest(integ(), { name: 'A', phone: '9876543210', lead_id: 'X2', campaign: 'c' });
    expect(out).toEqual({ status: 'HELD_BY_PARTNER', leadId: 'LP1' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(prisma.leadNote.create.mock.calls[0][0].data.text).toContain('holds the buyer');
  });

  test('an open lead for the same buyer and project gets a note, not a second lead', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'LOPEN' });
    const i = integ({ defaultProjectId: 'p1' });
    const out = await service.ingest(i, { name: 'A', phone: '9876543210', lead_id: 'X3', message: 'again' });
    expect(out).toEqual({ status: 'DUPLICATE', leadId: 'LOPEN' });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toMatchObject({ projectId: 'p1' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  test('a test (dry run) writes nothing and shows what would happen', async () => {
    const out = await service.ingest(integ({ mappings: [{ matchField: 'campaign', matchValue: 'c1', projectId: 'p1' }] }), { name: 'T', phone: '9876543210', campaign: 'c1' }, { dryRun: true });
    expect(out).toMatchObject({ status: 'DRY_RUN', would: { projectId: 'p1', mappingMatched: true } });
    expect(prisma.leadIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  test('an unexpected failure is logged on the event and the integration, and rethrown', async () => {
    prisma.lead.create.mockRejectedValue(new Error('db down'));
    await expect(service.ingest(integ(), { name: 'A', phone: '9876543210', lead_id: 'X4' })).rejects.toThrow('db down');
    expect(prisma.leadIntakeEvent.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: expect.objectContaining({ status: 'ERROR' }) });
  });
});

describe('webhook handler', () => {
  const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
  test('a wrong secret is a 401 and a lead we cannot use is a 422; repeats are a 200', async () => {
    const secret = li.newSecret();
    prisma.leadIntegration.findUnique.mockResolvedValue(integ({ secretHash: li.hashSecret(secret) }));
    let r = res();
    await ctrl.webhook({ params: { keyId: 'lk_x' }, headers: { 'x-integration-secret': 'bad' }, body: {} }, r);
    expect(r.status).toHaveBeenCalledWith(401);
    r = res();
    await ctrl.webhook({ params: { keyId: 'lk_x' }, headers: { authorization: `Bearer ${secret}` }, body: { name: 'A', phone: 'x' } }, r);
    expect(r.status).toHaveBeenCalledWith(422);
    prisma.leadIntakeEvent.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    prisma.leadIntakeEvent.findFirst.mockResolvedValue({ leadId: 'L1' });
    r = res();
    await ctrl.webhook({ params: { keyId: 'lk_x' }, headers: {}, body: { name: 'A', phone: '9876543210', lead_id: 'Z', google_key: secret } }, r);
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

describe('admin input rules', () => {
  test('a mapping must say what the form means', () => {
    expect(() => ctrl._schemas.mappingSchema.parse({ matchField: 'formId', matchValue: 'F1' })).toThrow();
    expect(ctrl._schemas.mappingSchema.parse({ matchField: 'formId', matchValue: 'F1', projectId: 'a'.repeat(24) })).toBeTruthy();
    expect(() => ctrl._schemas.mappingSchema.parse({ matchField: 'nonsense', matchValue: 'x', campaignLabel: 'c' })).toThrow();
  });
});
