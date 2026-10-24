// BUG-025: a partner can list a buyer's lead under the buyer's name, yet the buyer's own list does not show it. The code is
// deliberate: a lead created without an account link (partner-added, admin-created) is the buyer's only after the buyer, with a
// VERIFIED phone that matches, claims it. These tests pin that rule from both sides: the buyer's list never includes anyone
// else's lead, and the claim path shows only what the phone proves is theirs.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn().mockResolvedValue(), createNotification: jest.fn().mockResolvedValue() }));
const prisma = require('../../src/lib/prisma');
const users = require('../../src/modules/users/users.service');

const buyer = (over = {}) => ({ id: 'u1', role: 'USER', phone: '+919999999999', phoneVerified: true, deletedAt: null, isSuspended: false, ...over });
beforeEach(() => { jest.resetAllMocks(); prisma.lead.findMany.mockResolvedValue([]); });

describe("the buyer's own list", () => {
  test('is exactly the leads linked to this account, never matched by name or phone', async () => {
    await users.getMyLeads('u1');
    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({ buyerId: 'u1' });
  });
});

describe('claimable leads', () => {
  test('a phone that is not verified sees nothing, whatever leads carry that number', async () => {
    prisma.user.findUnique.mockResolvedValue(buyer({ phoneVerified: false }));
    expect(await users.getClaimableLeads('u1')).toEqual([]);
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });
  test('no phone on the account sees nothing', async () => {
    prisma.user.findUnique.mockResolvedValue(buyer({ phone: null }));
    expect(await users.getClaimableLeads('u1')).toEqual([]);
  });
  test('only unlinked leads with this exact phone are offered', async () => {
    prisma.user.findUnique.mockResolvedValue(buyer());
    await users.getClaimableLeads('u1');
    const where = JSON.stringify(prisma.lead.findMany.mock.calls[0][0].where);
    expect(where).toContain('+919999999999');
    expect(where).toMatch(/buyerId/);
  });
  test('the list shows no other person\'s details (no phone, email or partner)', async () => {
    prisma.user.findUnique.mockResolvedValue(buyer());
    await users.getClaimableLeads('u1');
    const select = prisma.lead.findMany.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(['createdAt', 'id', 'propertyInterest', 'property', 'refCode', 'status'].sort());
  });
});

describe('claiming', () => {
  const lead = (over = {}) => ({ id: 'l1', refCode: 'RD-L-1', buyerId: null, buyerPhone: '+919999999999', status: 'ASSIGNED', ...over });
  test('needs a verified phone', async () => {
    prisma.user.findUnique.mockResolvedValue(buyer({ phoneVerified: false }));
    await expect(users.claimLead('u1', 'l1')).rejects.toMatchObject({ statusCode: 403, data: { code: 'PHONE_NOT_VERIFIED' } });
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });
  test.each([
    ['a lead that does not exist', null],
    ["another person's number", lead({ buyerPhone: '+918888888888' })],
    ['a lead already linked to someone', lead({ buyerId: 'u2' })],
    ['a lead still waiting for admin review', lead({ status: 'AWAITING_ADMIN' })],
  ])('%s is the same plain 404, so nobody can probe which leads exist', async (_n, found) => {
    prisma.user.findUnique.mockResolvedValue(buyer());
    prisma.lead.findUnique.mockResolvedValue(found);
    await expect(users.claimLead('u1', 'l1')).rejects.toMatchObject({ statusCode: 404, message: 'Inquiry not found' });
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });
  test('a partner account cannot claim a buyer lead', async () => {
    prisma.user.findUnique.mockResolvedValue(buyer({ role: 'PARTNER' }));
    prisma.lead.findUnique.mockResolvedValue(lead());
    await expect(users.claimLead('u1', 'l1')).rejects.toMatchObject({ statusCode: 404 });
  });
  test('RACE: the claim only succeeds on a still-unlinked lead; the loser gets a 409', async () => {
    prisma.user.findUnique.mockResolvedValue(buyer());
    prisma.lead.findUnique.mockResolvedValue(lead());
    prisma.lead.updateMany.mockResolvedValue({ count: 0 });
    await expect(users.claimLead('u1', 'l1')).rejects.toMatchObject({ statusCode: 409, data: { code: 'LEAD_ALREADY_CLAIMED' } });
    expect(JSON.stringify(prisma.lead.updateMany.mock.calls[0][0].where)).toContain('buyerId');
  });
});
