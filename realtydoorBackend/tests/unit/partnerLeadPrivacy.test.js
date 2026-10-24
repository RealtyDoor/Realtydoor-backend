// What a partner may see of a lead: no buyer phone or email until the visit code has been verified (and never after the buyer asks
// to be deleted), never the code itself, the admin's notes, or the platform's commission internals; only their own leads.
jest.mock('../../src/lib/prisma', () => ({ lead: { findMany: jest.fn(), findFirst: jest.fn() } }));
jest.mock('../../src/modules/config/config.service', () => ({ getConfigNumber: jest.fn().mockResolvedValue(0), getConfigBool: jest.fn(), getConfig: jest.fn() }));
const prisma = require('../../src/lib/prisma');
const leads = require('../../src/modules/leads/leads.service');

const raw = (over = {}) => ({
  id: 'l1', refCode: 'RD-L-1', assignedPartnerId: 'p1', status: 'ASSIGNED', createdAt: new Date(),
  buyerName: 'Buyer One', buyerPhone: '+919876543210', buyerEmail: 'buyer.one@example.com', isOtpVerified: false,
  siteVisitOTP: '123456', adminNotes: 'internal: suspicious', feePct: 2, dealPriceAtLock: 1e7, commissionLockedAt: new Date(), commissionStatus: 'PENDING',
  platformFeePct: 1, partnerRatePct: 1, commissionRateReason: 'big deal', contactRevealedIp: '1.2.3.4', invoiceUrl: 'u', escrowTransactions: [],
  buyer: { refCode: 'RD-U-1', phoneVerified: true, deletionRequestedAt: null }, property: { title: 'P' }, ...over,
});
const listOne = async (over) => { prisma.lead.findMany.mockResolvedValue([raw(over)]); return (await leads.getPartnerLeads('p1'))[0]; };

beforeEach(() => jest.clearAllMocks());

test('only the partner\'s own leads are asked for', async () => {
  prisma.lead.findMany.mockResolvedValue([]);
  await leads.getPartnerLeads('p1');
  expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({ assignedPartnerId: 'p1' });
});
test("another partner's lead by id is a 404", async () => {
  prisma.lead.findFirst.mockResolvedValue(null);
  await expect(leads.getPartnerLeadById('l1', 'p2')).rejects.toMatchObject({ statusCode: 404 });
  expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'l1', assignedPartnerId: 'p2' });
});

describe('before the visit code is verified', () => {
  test('the buyer\'s phone and email are masked, so the real number is nowhere in the response', async () => {
    const out = await listOne();
    expect(out.buyerPhone).not.toContain('9876543210');
    expect(out.buyerEmail).not.toContain('buyer.one');
    expect(JSON.stringify(out)).not.toMatch(/9876543210|buyer\.one@example\.com/);
  });
});
describe('after it is verified', () => {
  test('the contact details are shown in full', async () => {
    const out = await listOne({ isOtpVerified: true });
    expect(out.buyerPhone).toContain('9876543210');
    expect(out.buyerEmail).toBe('buyer.one@example.com');
  });
  test('…unless the buyer has asked for their account to be deleted: then they are masked again', async () => {
    const out = await listOne({ isOtpVerified: true, buyer: { refCode: 'RD-U-1', phoneVerified: true, deletionRequestedAt: new Date() } });
    expect(JSON.stringify(out)).not.toMatch(/9876543210|buyer\.one@example\.com/);
  });
});
describe('never, in any state', () => {
  test.each([[false], [true]])('the code itself, admin notes and the platform commission internals (verified=%s)', async (isOtpVerified) => {
    const out = await listOne({ isOtpVerified });
    const text = JSON.stringify(out);
    expect(text).not.toContain('123456');
    expect(text).not.toContain('internal: suspicious');
    for (const f of ['siteVisitOTP', 'adminNotes', 'feePct', 'dealPriceAtLock', 'platformFeePct', 'partnerRatePct', 'commissionRateReason', 'contactRevealedIp', 'invoiceUrl', 'commissionStatus']) {
      expect(out[f]).toBeUndefined();
    }
  });
});
