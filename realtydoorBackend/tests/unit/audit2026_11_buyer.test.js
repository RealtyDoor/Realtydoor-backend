// Audit Nov 2026, phase 5 (buyer app and public site). One or more tests per finding U1 to U10; see admin-nextjs/docs/AUDIT_2026-11.md.
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
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn(), createNotification: jest.fn(), broadcastNotification: jest.fn() }));
jest.mock('../../src/lib/cache', () => ({ withCache: jest.fn((k, t, fn) => fn()), cacheDel: jest.fn(), cacheDelPattern: jest.fn() }));

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/lib/prisma');
const notifications = require('../../src/lib/notifications');
const src = (p) => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');

beforeEach(() => {
  jest.resetAllMocks();
  notifications.notifyAdmins.mockResolvedValue({});
  prisma.counter.create.mockResolvedValue({});
  prisma.counter.deleteMany.mockResolvedValue({});
});

describe('U1: favorites', () => {
  const users = () => require('../../src/modules/users/users.service');
  test('a listing that is not public cannot be saved', async () => {
    prisma.favorite.findFirst.mockResolvedValue(null);
    prisma.property.findFirst.mockResolvedValue(null);
    await expect(users().toggleFavorite('u1', 'p1')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.favorite.create).not.toHaveBeenCalled();
    expect(prisma.property.findFirst.mock.calls[0][0].where).toMatchObject({ publishStatus: 'APPROVED', isB2BOnly: false });
  });
  test('removing a saved listing works even after it went private', async () => {
    prisma.favorite.findFirst.mockResolvedValue({ id: 'f1' });
    prisma.favorite.deleteMany.mockResolvedValue({ count: 1 });
    await expect(users().toggleFavorite('u1', 'p1')).resolves.toEqual({ favorited: false });
  });
  test('a double click that hits the unique index still answers saved', async () => {
    prisma.favorite.findFirst.mockResolvedValue(null);
    prisma.property.findFirst.mockResolvedValue({ id: 'p1' });
    prisma.favorite.create.mockRejectedValue({ code: 'P2002' });
    await expect(users().toggleFavorite('u1', 'p1')).resolves.toEqual({ favorited: true });
  });
  test('the list shows a placeholder, no details, for a listing that is no longer public', async () => {
    const live = { id: 'a', title: 'Live', publishStatus: 'APPROVED', isB2BOnly: false, partner: { role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: false, deletedAt: null } };
    const hidden = { id: 'b', title: 'Secret', price: 9, publishStatus: 'PENDING_APPROVAL', isB2BOnly: false, partner: { role: 'PARTNER', kycStatus: 'VERIFIED' } };
    const suspended = { id: 'c', title: 'Suspended', publishStatus: 'APPROVED', isB2BOnly: false, partner: { role: 'PARTNER', kycStatus: 'VERIFIED', isSuspended: true } };
    prisma.favorite.findMany.mockResolvedValue([
      { propertyId: 'a', property: live, savedAt: new Date() }, { propertyId: 'b', property: hidden, savedAt: new Date() },
      { propertyId: 'c', property: suspended, savedAt: new Date() }, { propertyId: 'd', property: null, savedAt: new Date() },
    ]);
    const list = await users().getFavorites('u1');
    expect(list[0]).toMatchObject({ id: 'a', title: 'Live' });
    expect(list[0].partner).toBeUndefined();
    for (const i of [1, 2, 3]) expect(list[i]).toMatchObject({ unavailable: true, title: 'This listing is no longer available' });
    expect(JSON.stringify(list.slice(1))).not.toMatch(/Secret|Suspended/);
  });
});

describe('U2, U7: routes', () => {
  test('service payment routes carry the payment limiters', () => {
    const r = src('modules/services/services.routes.js');
    expect(r).toMatch(/paymentStartLimiter, ctrl\.createOrder/);
    expect(r).toMatch(/paymentVerifyLimiter, ctrl\.verifyPayment/);
  });
  test('buyer ticket and video tour creation carry a limiter', () => {
    const r = src('modules/users/users.routes.js');
    expect(r).toMatch(/supportTicketLimiter, ctrl\.raiseTicket/);
    expect(r).toMatch(/supportTicketLimiter, ctrl\.requestVideoTour/);
  });
  test('ticket photos from another website are refused', async () => {
    const users = require('../../src/modules/users/users.service');
    await expect(users.raiseTicket('u1', undefined, { subject: 's', description: 'd', photos: ['https://evil.example/x.png'] }))
      .rejects.toMatchObject({ statusCode: 400 });
    prisma.serviceTicket.findFirst.mockResolvedValue({ id: 't1', subject: 's' });
    await expect(users.addTicketComment('u1', 't1', { text: 'hi', photos: ['https://evil.example/x.png'] })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('a ticket takes at most 100 notes from the buyer', async () => {
    const users = require('../../src/modules/users/users.service');
    prisma.serviceTicket.findFirst.mockResolvedValue({ id: 't1', subject: 's' });
    prisma.ticketComment.count.mockResolvedValue(100);
    await expect(users.addTicketComment('u1', 't1', { text: 'hi' })).rejects.toMatchObject({ statusCode: 429 });
    expect(prisma.ticketComment.create).not.toHaveBeenCalled();
  });
});

describe('U3: service requests', () => {
  const ctrl = () => require('../../src/modules/serviceRequests/serviceRequests.controller');
  const id = '507f1f77bcf86cd799439011';
  const body = { name: 'Asha', phone: '9876543210', serviceIds: [id], source: 'services-page' };
  test('an unknown service id is refused', async () => {
    prisma.service.count.mockResolvedValue(0);
    const next = jest.fn();
    await ctrl().submit({ body }, {}, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(prisma.serviceRequest.create).not.toHaveBeenCalled();
  });
  test('a good request is stored with a standard phone and admins are told', async () => {
    prisma.service.count.mockResolvedValue(1);
    prisma.serviceRequest.create.mockResolvedValue({ id: 'r1' });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await ctrl().submit({ body }, res, jest.fn());
    expect(prisma.serviceRequest.create.mock.calls[0][0].data.phone).toMatch(/^\+91/);
    expect(notifications.notifyAdmins).toHaveBeenCalled();
  });
});

describe('U5, U6: search input', () => {
  const { searchSchema } = require('../../src/modules/properties/properties.validator');
  test('isVerified=false means not filtered to verified', () => {
    expect(searchSchema.parse({ isVerified: 'false' }).isVerified).toBe(false);
    expect(searchSchema.parse({ isVerified: 'true' }).isVerified).toBe(true);
    expect(() => searchSchema.parse({ isVerified: 'maybe' })).toThrow();
  });
  test('long text is refused', () => {
    expect(() => searchSchema.parse({ q: 'x'.repeat(101) })).toThrow();
    expect(() => searchSchema.parse({ city: 'x'.repeat(101) })).toThrow();
    expect(searchSchema.parse({ q: 'whitefield 3bhk' }).q).toBe('whitefield 3bhk');
  });
});

describe('U8: double submits', () => {
  const users = () => require('../../src/modules/users/users.service');
  test('a second rating that loses the race is refused', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1', status: 'SITE_VISIT_DONE', buyerRating: null });
    prisma.lead.updateMany.mockResolvedValue({ count: 0 });
    await expect(users().rateLead('u1', 'l1', { rating: 5 })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('a video tour request is checked and written under a lock', async () => {
    prisma.property.findFirst.mockResolvedValue({ id: 'p1', title: 'T' });
    prisma.counter.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    prisma.counter.findUnique.mockResolvedValue({ seq: Math.floor(Date.now() / 1000) });
    await expect(users().requestVideoTour('u1', 'p1', 'note')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.videoTourRequest.create).not.toHaveBeenCalled();
  });
});

describe('U9: microsite cache', () => {
  test('suspending or freezing a partner clears their microsite pages', () => {
    expect(src('modules/admin/admin.service.js')).toMatch(/await clearMicrositeCachesFor\(userId\)/);
  });
});
