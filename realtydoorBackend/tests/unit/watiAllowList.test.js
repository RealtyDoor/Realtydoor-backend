jest.mock('../../src/lib/prisma', () => ({}));
jest.mock('../../src/lib/notificationGate', () => ({ canSend: () => true, CATEGORIES: {} }));
jest.mock('axios', () => ({ create: () => ({ post: jest.fn() }) }));
const { isRecipientAllowed, sendTemplateMessage } = require('../../src/lib/wati');

describe('WATI_ALLOWED_NUMBERS (T23)', () => {
  const list = '+91 79080 43093, 9844412345';
  it('allows everyone when unset', () => {
    expect(isRecipientAllowed('+919999999999', { NODE_ENV: 'development' })).toBe(true);
  });
  it('allows listed numbers in any format outside production', () => {
    const env = { NODE_ENV: 'development', WATI_ALLOWED_NUMBERS: list };
    expect(isRecipientAllowed('+917908043093', env)).toBe(true);
    expect(isRecipientAllowed('919844412345', env)).toBe(true);
  });
  it('blocks unlisted numbers outside production', () => {
    expect(isRecipientAllowed('+919999999999', { NODE_ENV: 'development', WATI_ALLOWED_NUMBERS: list })).toBe(false);
  });
  it('production ignores the list', () => {
    expect(isRecipientAllowed('+919999999999', { NODE_ENV: 'production', WATI_ALLOWED_NUMBERS: list })).toBe(true);
  });
  it('a blocked send returns null without calling WATI', async () => {
    process.env.WATI_ALLOWED_NUMBERS = list;
    process.env.NODE_ENV = 'test';
    await expect(sendTemplateMessage('+919999999999', 'site_visit_otp', [])).resolves.toBeNull();
    delete process.env.WATI_ALLOWED_NUMBERS;
  });
});
