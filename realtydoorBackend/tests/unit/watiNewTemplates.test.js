// The WhatsApp templates added on 21 Nov 2026 for gaps where only an email or in-app message went out. Each is silent until it is live.
const { sendOnboardingWhatsApp } = require('../../src/lib/wati');


describe('builder messages through sendOnboardingWhatsApp', () => {
  const env = (names) => ({ WATI_LIVE_TEMPLATES: names.join(',') });
  test('a status update is silent until its template is live', async () => {
    expect(await sendOnboardingWhatsApp('+919800000001', 'onboarding_status_update', { name: 'A', project: 'P', statusKind: 'closed' }, env([]))).toBeNull();
  });
  test('an unknown stage sends nothing', async () => {
    expect(await sendOnboardingWhatsApp('+919800000001', 'onboarding_status_update', { name: 'A', project: 'P', statusKind: 'weird' }, env(['onboarding_status_update']))).toBeNull();
  });
  test('templates outside the onboarding set are refused', async () => {
    expect(await sendOnboardingWhatsApp('+919800000001', 'escrow_refunded', { name: 'A', project: 'P' }, env(['escrow_refunded']))).toBeNull();
  });
});
