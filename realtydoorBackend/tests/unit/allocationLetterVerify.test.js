// An uploaded allocation letter must not end the buyer's right to cancel; only an admin's "verified" does.

jest.mock('../../src/lib/prisma', () => ({
  lead: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  escrowTransaction: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  platformConfig: { findMany: jest.fn(), findUnique: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn() }));
jest.mock('../../src/lib/notifications', () => ({ createNotification: jest.fn().mockResolvedValue({}), broadcastNotification: jest.fn(), notifyAdmins: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { createAuditLog } = require('../../src/lib/auditLog');
const { createNotification } = require('../../src/lib/notifications');
const leads = require('../../src/modules/leads/leads.service');
const escrow = require('../../src/modules/escrow/escrow.service');
const users = require('../../src/modules/users/users.service');

beforeEach(() => {
  jest.resetAllMocks();
  createNotification.mockResolvedValue({});
  prisma.platformConfig.findMany.mockResolvedValue([]);
  prisma.platformConfig.findUnique.mockResolvedValue(null);
});

describe('adminVerifyAllocationLetter', () => {
  test('needs an uploaded letter', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', allocationLetterUrl: null });
    await expect(leads.adminVerifyAllocationLetter('l1', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
  test('stamps who and when, tells the buyer and audits it', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', refCode: 'RD-L-1', buyerId: 'b1', allocationLetterUrl: 'https://x/a.pdf', allocationLetterVerifiedAt: null });
    prisma.lead.update.mockResolvedValue({ id: 'l1', allocationLetterVerifiedAt: new Date() });
    await leads.adminVerifyAllocationLetter('l1', 'a1', '1.1.1.1');
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ allocationLetterVerifiedBy: 'a1' });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'b1', type: 'ALLOCATION_LETTER_VERIFIED' }));
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ALLOCATION_LETTER_VERIFIED', targetId: 'l1' }));
  });
  test('a second call changes nothing', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: 'l1', allocationLetterUrl: 'u', allocationLetterVerifiedAt: new Date() });
    await leads.adminVerifyAllocationLetter('l1', 'a1');
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });
});

describe('refund quote: upload is not verification', () => {
  const heldEscrow = { id: 'e1', status: 'HELD', razorpayPaymentId: 'pay_1', amount: 50000, processingFeePaise: 120900, leadId: 'l1', heldAt: new Date(Date.now() - 10 * 24 * 3600e3) };
  test('a letter that is only uploaded still allows a refund minus the charge', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(heldEscrow);
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: 'u', allocationLetterVerifiedAt: null });
    const q = await escrow.refund('e1', 'b1', null, { reason: 'BUYER_CANCEL', dryRun: true });
    expect(q).toMatchObject({ stage: 'AFTER_WINDOW', refundable: true });
  });
  test('a verified letter makes it not refundable', async () => {
    prisma.escrowTransaction.findUnique.mockResolvedValue(heldEscrow);
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterUrl: 'u', allocationLetterVerifiedAt: new Date() });
    const q = await escrow.refund('e1', 'b1', null, { reason: 'BUYER_CANCEL', dryRun: true });
    expect(q).toMatchObject({ stage: 'AFTER_VERIFICATION', refundable: false });
  });
});

describe('cancelLead with a token that cannot be refunded', () => {
  test('refuses, and does not drop the inquiry while the token stays held', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1', status: 'SITE_VISIT_DONE' });
    prisma.escrowTransaction.findFirst.mockResolvedValue({ id: 'e1', status: 'HELD' });
    prisma.escrowTransaction.findUnique.mockResolvedValue({ id: 'e1', status: 'HELD', razorpayPaymentId: 'pay_1', amount: 50000, processingFeePaise: 0, leadId: 'l1', heldAt: new Date(Date.now() - 10 * 24 * 3600e3) });
    prisma.lead.findUnique.mockResolvedValue({ allocationLetterVerifiedAt: new Date() });
    await expect(users.cancelLead('b1', 'l1', { reason: 'x', reasonLabel: 'x' })).rejects.toMatchObject({ statusCode: 409, data: expect.objectContaining({ code: 'NOT_REFUNDABLE_AFTER_VERIFICATION' }) });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});
