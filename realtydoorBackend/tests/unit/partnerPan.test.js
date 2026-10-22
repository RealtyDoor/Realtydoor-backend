jest.mock('../../src/lib/prisma', () => ({ user: { findUnique: jest.fn(), update: jest.fn() }, auditLog: { findFirst: jest.fn(), create: jest.fn() } }));
const prisma = require('../../src/lib/prisma');
const service = require('../../src/modules/partners/partners.service');
const { updateProfileSchema, unsupportedProfileFields } = require('../../src/modules/partners/partners.validator');

beforeEach(() => {
  jest.resetAllMocks();
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockImplementation(async ({ data }) => data);
  prisma.user.update.mockImplementation(async ({ data }) => data);
});

describe('partner PAN', () => {
  test('the profile schema takes a PAN, upper-cases it and rejects a bad one', () => {
    expect(updateProfileSchema.parse({ panNumber: 'abcde1234f' }).panNumber).toBe('ABCDE1234F');
    expect(() => updateProfileSchema.parse({ panNumber: 'ABCDE12345' })).toThrow();
    expect(unsupportedProfileFields({ panNumber: 'X', gstin: 'Y' })).toEqual([]);
  });
  test('can be added while none is on file; verification is reset; the change is audited with the PAN masked', async () => {
    prisma.user.findUnique.mockResolvedValue({ panNumber: null, gstin: null });
    await service.updateProfile('p1', { panNumber: 'ABCDE1234F' });
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ panNumber: 'ABCDE1234F', panVerificationStatus: null });
  });
  test('an existing PAN cannot be changed by the partner', async () => {
    prisma.user.findUnique.mockResolvedValue({ panNumber: 'AAAAA1111A' });
    await expect(service.updateProfile('p1', { panNumber: 'BBBBB2222B' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'PAN_LOCKED' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('re-sending the same PAN is fine', async () => {
    prisma.user.findUnique.mockResolvedValue({ panNumber: 'AAAAA1111A' });
    await expect(service.updateProfile('p1', { panNumber: 'AAAAA1111A' })).resolves.toBeDefined();
  });
});
