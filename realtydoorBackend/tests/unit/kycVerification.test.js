// This environment has no KYC_VERIFICATION_API_KEY set (see .env.example —
// it's deliberately blank by default), so these tests exercise exactly the
// path that's actually live in every real environment today: the no-op.
// They do NOT and cannot test the real Karza HTTP calls — no vendor
// credentials exist to test against; see lib/kycVerification.js's own
// comment.
delete process.env.KYC_VERIFICATION_API_KEY;
const kycVerification = require('../../src/lib/kycVerification');

describe('kycVerification (not configured)', () => {
  test('isConfigured() is false without an API key', () => {
    expect(kycVerification.isConfigured()).toBe(false);
  });

  test('verifyPan returns NOT_CONFIGURED without making a network call', async () => {
    const result = await kycVerification.verifyPan('ABCDE1234F', 'Test Name');
    expect(result).toEqual({ status: 'NOT_CONFIGURED', verifiedName: null });
  });

  test('verifyGstin returns NOT_CONFIGURED without making a network call', async () => {
    const result = await kycVerification.verifyGstin('27AAAPL1234C1ZV');
    expect(result).toEqual({ status: 'NOT_CONFIGURED', verifiedName: null });
  });

  test('verifyRera returns NOT_CONFIGURED without making a network call', async () => {
    const result = await kycVerification.verifyRera('P52100012345');
    expect(result).toEqual({ status: 'NOT_CONFIGURED', verifiedName: null });
  });
});
