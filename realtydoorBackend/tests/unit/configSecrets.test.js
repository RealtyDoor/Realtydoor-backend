jest.mock('../../src/lib/prisma', () => ({
  platformConfig: { findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
}));
jest.mock('../../src/lib/cache', () => ({ withCache: jest.fn(), cacheDel: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { adminListConfig, adminUpsertConfig } = require('../../src/modules/config/config.service');

describe('platform config secrets', () => {
  test('masks secret-looking values in the admin list but not token-percentage keys', async () => {
    prisma.platformConfig.findMany.mockResolvedValue([
      { key: 'razorpay_webhook_secret', value: 'whsec_real' },
      { key: 'escrow_max_token_pct', value: '10' },
    ]);
    const rows = await adminListConfig();
    expect(rows[0].value).toBe('********');
    expect(rows[1].value).toBe('10');
  });

  test('refuses to store a secret', async () => {
    await expect(adminUpsertConfig('razorpay_webhook_secret', { value: 'x' }, 'a1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.platformConfig.upsert).not.toHaveBeenCalled();
  });
});
