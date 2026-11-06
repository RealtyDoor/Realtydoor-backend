// An admin correcting a lead's own details.
jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  user: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  escrowTransaction: { count: jest.fn().mockResolvedValue(0) },
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


const L = (over = {}) => ({ id: 'l1', refCode: 'RD-L-000001', status: 'UNASSIGNED', buyerName: 'WhatsApp contact', buyerPhone: '+919876500123', buyerEmail: '', budget: null, city: null, buyerMessage: 'hi', addedByPartnerId: null, isOtpVerified: false, ...over });

describe('updateLeadDetails', () => {
  beforeEach(() => { jest.clearAllMocks(); prisma.lead.update.mockImplementation(async ({ data }) => ({ id: 'l1', ...data })); prisma.escrowTransaction.count.mockResolvedValue(0); });

  test('corrects the name, email, city and budget, and records what changed', async () => {
    prisma.lead.findUnique.mockResolvedValue(L());
    await admin.updateLeadDetails('l1', { buyerName: 'Asha Kumar', buyerEmail: 'asha@x.com', city: 'Bengaluru', budget: '80L' }, 'admin1', '1.1.1.1');
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { buyerName: 'Asha Kumar', buyerEmail: 'asha@x.com', city: 'Bengaluru', budget: '80L' } });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEAD_DETAILS_EDITED', before: { buyerName: 'WhatsApp contact', buyerEmail: '', city: null, budget: null }, after: { buyerName: 'Asha Kumar', buyerEmail: 'asha@x.com', city: 'Bengaluru', budget: '80L' } }));
  });
  test('changing nothing writes nothing', async () => {
    prisma.lead.findUnique.mockResolvedValue(L());
    await admin.updateLeadDetails('l1', { buyerName: 'WhatsApp contact' }, 'admin1', '1.1.1.1');
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });
  test('an empty project clears it; the number is cleaned', async () => {
    prisma.lead.findUnique.mockResolvedValue(L({ projectId: 'p1' }));
    await admin.updateLeadDetails('l1', { projectId: '', buyerPhone: '98765 00999' }, 'admin1', '1.1.1.1');
    expect(prisma.lead.update.mock.calls[0][0].data).toEqual({ projectId: null, buyerPhone: '+919876500999' });
  });
  test('the number is locked on a partner lead, a verified visit or a lead with money', async () => {
    for (const lead of [L({ addedByPartnerId: 'P1' }), L({ isOtpVerified: true })]) {
      prisma.lead.findUnique.mockResolvedValue(lead);
      await expect(admin.updateLeadDetails('l1', { buyerPhone: '9876500999' }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 409, data: { code: 'PHONE_LOCKED' } });
    }
    prisma.lead.findUnique.mockResolvedValue(L());
    prisma.escrowTransaction.count.mockResolvedValue(1);
    await expect(admin.updateLeadDetails('l1', { buyerPhone: '9876500999' }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('an invalid number, a missing lead and a closed lead are refused', async () => {
    prisma.lead.findUnique.mockResolvedValue(L());
    await expect(admin.updateLeadDetails('l1', { buyerPhone: '123' }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 400 });
    prisma.lead.findUnique.mockResolvedValue(null);
    await expect(admin.updateLeadDetails('x', { buyerName: 'Abc' }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 404 });
    prisma.lead.findUnique.mockResolvedValue(L({ status: 'CLOSED' }));
    await expect(admin.updateLeadDetails('l1', { buyerName: 'Abc' }, 'a', 'ip')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('getLeadById', () => {
  test('returns who added the lead, so the page can offer "Release this buyer" and lock the phone', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', ownerStaffId: null, status: 'AWAITING_ADMIN', addedByPartner: { name: 'Developer One', companyName: null } });
    prisma.user.findUnique.mockResolvedValue(null);
    const lead = await admin.getLeadById('l1');
    expect(prisma.lead.findUnique.mock.calls.pop()[0].include.addedByPartner).toEqual({ select: { name: true, companyName: true } });
    expect(lead.addedByPartner).toMatchObject({ name: 'Developer One' });
  });
});
