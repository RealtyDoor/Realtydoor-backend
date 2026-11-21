// Build-out form: the sender (builder or owner) gets an email and a WhatsApp message when their link is created or re-issued, and a thank-you after
// they press Send. Only to the contact details the team typed; WhatsApp stays silent until its template is live; a failed message never blocks the form.
const mockLive = { set: new Set() };
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
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/fileUpload', () => ({ deleteFile: jest.fn(), copyFile: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendOnboardingFormReady: jest.fn(), sendOnboardingReceived: jest.fn(), sendOnboardingUpdate: jest.fn() }));
jest.mock('../../src/lib/wati', () => ({ sendOnboardingWhatsApp: jest.fn(), liveSet: () => mockLive.set }));

const prisma = require('../../src/lib/prisma');
const email = require('../../src/lib/email');
const wati = require('../../src/lib/wati');
const svc = require('../../src/modules/onboarding/onboarding.service');
const f = require('../../src/lib/onboardingForm');

const base = (over = {}) => ({
  id: 'r1', propertyType: 'NEW_PROJECT', title: 'Vrunda City', contactName: 'Ramesh Kumar', contactPhone: '+919800000001', contactEmail: 'ramesh@example.com',
  contactRole: null, status: 'SENT', data: {}, documents: [], adminNotes: [], expiresAt: new Date('2026-12-01T00:00:00Z'), createdAt: new Date(), updatedAt: new Date(), ...over,
});
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockLive.set = new Set();
  process.env.FRONTEND_URL = 'https://www.realtydoor.com';
  email.sendOnboardingFormReady.mockResolvedValue({});
  email.sendOnboardingReceived.mockResolvedValue({});
  email.sendOnboardingUpdate.mockResolvedValue({});
  wati.sendOnboardingWhatsApp.mockResolvedValue({});
});

describe('creating a link', () => {
  const create = (rowOver) => { prisma.onboardingRequest.create.mockResolvedValue(base(rowOver)); return svc.adminCreate('a1', { propertyType: 'NEW_PROJECT', contactName: 'Ramesh Kumar' }, '1.1.1.1'); };

  test('emails the private link to the sender, and says WhatsApp is waiting for its template', async () => {
    const out = await create();
    await flush();
    expect(email.sendOnboardingFormReady).toHaveBeenCalledTimes(1);
    const [to, args] = email.sendOnboardingFormReady.mock.calls[0];
    expect(to).toBe('ramesh@example.com');
    expect(args.formUrl).toBe(`https://www.realtydoor.com/listing-form/${out.token}`);
    expect(args).toMatchObject({ name: 'Ramesh Kumar', title: 'Vrunda City' });
    expect(wati.sendOnboardingWhatsApp).not.toHaveBeenCalled();
    expect(out.notified).toEqual({ email: true, whatsapp: false, whatsappWaitingForTemplate: true });
  });
  test('also sends WhatsApp once the template is live', async () => {
    mockLive.set = new Set(['onboarding_form_ready']);
    const out = await create();
    await flush();
    expect(wati.sendOnboardingWhatsApp).toHaveBeenCalledWith('+919800000001', 'onboarding_form_ready', { name: 'Ramesh Kumar', project: 'Vrunda City', formLink: `https://www.realtydoor.com/listing-form/${out.token}` });
    expect(out.notified.whatsapp).toBe(true);
  });
  test('sends nothing when the team typed no contact details', async () => {
    const out = await create({ contactEmail: null, contactPhone: null });
    await flush();
    expect(email.sendOnboardingFormReady).not.toHaveBeenCalled();
    expect(wati.sendOnboardingWhatsApp).not.toHaveBeenCalled();
    expect(out.notified).toEqual({ email: false, whatsapp: false, whatsappWaitingForTemplate: false });
  });
  test('a failed email or WhatsApp never blocks creating the link', async () => {
    mockLive.set = new Set(['onboarding_form_ready']);
    email.sendOnboardingFormReady.mockRejectedValue(new Error('smtp down'));
    wati.sendOnboardingWhatsApp.mockRejectedValue(new Error('wati down'));
    const out = await create();
    await flush();
    expect(out.token).toBeTruthy();
    expect(out.id).toBe('r1');
  });
});

describe('re-issuing a link', () => {
  test('the sender gets the new link, because the old one stops working', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(base({ status: 'SENT' }));
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => base({ ...data }));
    const out = await svc.adminReopen('a1', 'r1', 7, '1.1.1.1');
    await flush();
    expect(email.sendOnboardingFormReady).toHaveBeenCalledTimes(1);
    expect(email.sendOnboardingFormReady.mock.calls[0][1].formUrl).toBe(`https://www.realtydoor.com/listing-form/${out.token}`);
  });
});

describe('the sender presses Send', () => {
  const token = f.newToken();
  const submit = async (rowOver) => {
    // A form with one uploaded document counts as filled in; no answers are sent in the body.
    prisma.onboardingRequest.findFirst.mockResolvedValue(base({ tokenHash: f.hashToken(token), documents: [{ id: 'd1', key: 'rera', name: 'rera.pdf' }], ...rowOver }));
    prisma.onboardingRequest.update.mockResolvedValue({});
    return svc.senderSubmit(token, {});
  };
  test('gets a thank-you email, and WhatsApp once live; the admins are still told', async () => {
    mockLive.set = new Set(['onboarding_form_received']);
    await submit();
    await flush();
    expect(email.sendOnboardingReceived).toHaveBeenCalledWith('ramesh@example.com', { name: 'Ramesh Kumar', title: 'Vrunda City' });
    expect(wati.sendOnboardingWhatsApp).toHaveBeenCalledWith('+919800000001', 'onboarding_form_received', { name: 'Ramesh Kumar', project: 'Vrunda City', formLink: '' });
    expect(require('../../src/lib/notifications').notifyAdmins).toHaveBeenCalled();
  });
  test('without contact details only the admins are told', async () => {
    await submit({ contactEmail: null, contactPhone: null });
    await flush();
    expect(email.sendOnboardingReceived).not.toHaveBeenCalled();
    expect(wati.sendOnboardingWhatsApp).not.toHaveBeenCalled();
  });
});

describe('the team changes the status', () => {
  const change = async (from, to, rowOver = {}) => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(base({ status: from, ...rowOver }));
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => base({ status: from, ...rowOver, ...data }));
    const out = await svc.adminUpdate('a1', 'r1', { status: to }, '1.1.1.1');
    await flush();
    return out;
  };

  test.each([
    ['RECEIVED', 'IN_DISCUSSION', 'in_discussion'],
    ['IN_DISCUSSION', 'READY', 'ready_to_list'],
    ['READY', 'CLOSED', 'closed'],
  ])('%s to %s emails the sender "%s"', async (from, to, kind) => {
    const out = await change(from, to);
    expect(email.sendOnboardingUpdate).toHaveBeenCalledTimes(1);
    expect(email.sendOnboardingUpdate).toHaveBeenCalledWith('ramesh@example.com', kind, { name: 'Ramesh Kumar', title: 'Vrunda City' });
    expect(out.statusEmailSent).toBe(true);
  });
  test('saving the same status again emails nothing', async () => {
    const out = await change('IN_DISCUSSION', 'IN_DISCUSSION');
    expect(email.sendOnboardingUpdate).not.toHaveBeenCalled();
    expect(out.statusEmailSent).toBeUndefined();
  });
  test('moving back to RECEIVED emails nothing (that email goes when the sender presses Send)', async () => {
    await change('IN_DISCUSSION', 'RECEIVED');
    expect(email.sendOnboardingUpdate).not.toHaveBeenCalled();
  });
  test('editing other fields without a status change emails nothing', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(base({ status: 'IN_DISCUSSION' }));
    prisma.onboardingRequest.update.mockImplementation(async ({ data }) => base({ status: 'IN_DISCUSSION', ...data }));
    await svc.adminUpdate('a1', 'r1', { title: 'New name' }, '1.1.1.1');
    await flush();
    expect(email.sendOnboardingUpdate).not.toHaveBeenCalled();
  });
  test('no email on file: nothing is sent, and the admin is told so', async () => {
    const out = await change('RECEIVED', 'READY', { contactEmail: null });
    expect(email.sendOnboardingUpdate).not.toHaveBeenCalled();
    expect(out.statusEmailSent).toBe(false);
  });
  test('a failed email never blocks the status change', async () => {
    email.sendOnboardingUpdate.mockRejectedValue(new Error('smtp down'));
    const out = await change('RECEIVED', 'READY');
    expect(out.status).toBe('READY');
  });
});
