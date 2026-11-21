// Partners (and buyers) are told where to sign in, in the welcome and KYC-verified emails.
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'x', accepted: ['a@b.c'] });
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: mockSendMail }) }));

const email = require('../../src/lib/email');

describe('portalUrl', () => {
  it('uses the partner and app hosts on the live site', () => {
    expect(email.portalUrl('partner', { FRONTEND_URL: 'https://www.realtydoor.com' })).toBe('https://partner.realtydoor.com');
    expect(email.portalUrl('buyer', { FRONTEND_URL: 'https://www.realtydoor.com/' })).toBe('https://app.realtydoor.com');
  });
  it('uses paths on a single-host site', () => {
    expect(email.portalUrl('partner', { FRONTEND_URL: 'http://localhost:3000' })).toBe('http://localhost:3000/partners');
    expect(email.portalUrl('buyer', { FRONTEND_URL: 'http://localhost:3000' })).toBe('http://localhost:3000/user');
  });
  it('lets an override win and returns empty when nothing is set', () => {
    expect(email.portalUrl('partner', { FRONTEND_URL: 'https://www.x.com', PARTNER_PORTAL_URL: 'https://p.x.com/' })).toBe('https://p.x.com');
    expect(email.portalUrl('partner', {})).toBe('');
  });
});

describe('emails carry the sign-in address', () => {
  beforeEach(() => { mockSendMail.mockClear(); process.env.FRONTEND_URL = 'https://www.realtydoor.com'; });

  it('partner welcome', async () => {
    await email.sendWelcomeEmail('p@x.com', 'Anil <b>', 'PARTNER', {});
    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('https://partner.realtydoor.com');
    expect(html).toContain('How to sign in');
    expect(html).not.toContain('<b>');
  });
  it('buyer welcome points to the app, not the partner portal', async () => {
    await email.sendWelcomeEmail('b@x.com', 'Asha', 'USER', {});
    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('https://app.realtydoor.com');
    expect(html).not.toContain('partner.realtydoor.com');
  });
  it('KYC verified', async () => {
    await email.sendKycVerified('p@x.com', {});
    expect(mockSendMail.mock.calls[0][0].html).toContain('https://partner.realtydoor.com');
  });
});
