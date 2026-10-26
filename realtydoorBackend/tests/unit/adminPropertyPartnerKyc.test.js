// BUG-K3 (25 Oct 2026): the admin property page said "Partner KYC complete" was unmet for a VERIFIED partner,
// because the partner lookup did not select kycStatus.
jest.mock('../../src/lib/prisma', () => ({
  property: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
}));
const prisma = require('../../src/lib/prisma');
const { getPropertyByIdAdmin } = require('../../src/modules/admin/admin.service');

test('the partner on an admin property includes their KYC status', async () => {
  prisma.property.findUnique.mockResolvedValue({ id: 'p1', partnerId: 'u1', editLogs: [] });
  prisma.user.findUnique.mockResolvedValue({ name: 'Dev', kycStatus: 'VERIFIED' });
  const p = await getPropertyByIdAdmin('p1');
  expect(prisma.user.findUnique.mock.calls[0][0].select.kycStatus).toBe(true);
  expect(p.partner.kycStatus).toBe('VERIFIED');
});
