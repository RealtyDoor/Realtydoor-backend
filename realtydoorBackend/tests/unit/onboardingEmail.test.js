// The designed build-out form emails (src/lib/welcomeEmailHtml.js buildFormEmail).
const { buildFormEmail } = require('../../src/lib/welcomeEmailHtml');

describe('"form ready" email', () => {
  const r = () => buildFormEmail('ready', { name: 'Ramesh Kumar', title: 'Vrunda City', formUrl: 'https://www.realtydoor.com/listing-form/abc_DEF-123', expiresAt: new Date('2026-12-05T10:00:00Z') });
  test('greets by first name, names the project, and has the private link as a button and as plain text', () => {
    const { subject, html } = r();
    expect(subject).toBe('Your Realtydoor property details form is ready');
    expect(html).toContain('Ramesh');
    expect(html).not.toContain('Kumar');
    expect(html).toContain('Vrunda City');
    expect(html.match(/https:\/\/www\.realtydoor\.com\/listing-form\/abc_DEF-123/g).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('>Open the form</a>');
  });
  test('says the link is private and when it closes (India date)', () => {
    const { html } = r();
    expect(html).toContain('private to you');
    expect(html).toContain('5 December 2026');
  });
  test('uses the same logo, social icons and footer as the welcome email, attached by cid', () => {
    const { html, attachments } = r();
    expect(html).toContain('cid:realtydoor-logo');
    expect(html).toContain('Follow us on');
    expect(html).toContain('Realtydoor tech private limited');
    expect(attachments.length).toBe(6);
  });
  test('escapes anything typed by the team', () => {
    const { html } = buildFormEmail('ready', { name: '<script>x</script> Raj', title: '"><img src=x onerror=1>', formUrl: 'https://www.realtydoor.com/listing-form/t' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
  });
  test('without a link there is no button (never an empty one)', () => {
    expect(buildFormEmail('ready', { name: 'A', title: 'P' }).html).not.toContain('>Open the form</a>');
  });
});

describe('"form received" email', () => {
  test('thanks them, has no link and no button, and says what happens next', () => {
    const { subject, html } = buildFormEmail('received', { name: 'Ramesh Kumar', title: 'Vrunda City', formUrl: 'https://www.realtydoor.com/listing-form/secret' });
    expect(subject).toBe('We received your property details');
    expect(html).toContain('Thank you, Ramesh!');
    expect(html).toContain('What happens next');
    expect(html).not.toContain('listing-form/secret');
    expect(html).not.toContain('>Open the form</a>');
  });
  test('falls back to plain words when the name or title is missing', () => {
    const { html } = buildFormEmail('received', {});
    expect(html).toContain('there');
    expect(html).toContain('your property');
  });
});

describe('inline preview mode', () => {
  test('puts the images in the page and attaches nothing', () => {
    const { html, attachments } = buildFormEmail('received', { name: 'A' }, { inline: true });
    expect(html).toContain('data:image/png;base64,');
    expect(attachments).toEqual([]);
  });
});

describe('status-change emails', () => {
  const kinds = {
    in_discussion: ['We are reviewing your property details', 'We are on it, Ramesh'],
    ready_to_list: ['Your property details are ready to list', 'Good news, Ramesh'],
    listing_created: ['Your listing has been created', 'Your listing is created, Ramesh'],
    closed: ['An update on your property details', 'A quick update, Ramesh'],
  };
  test.each(Object.entries(kinds))('%s has its own subject and headline, the project name, no link and the shared footer', (kind, [subject, headline]) => {
    const out = buildFormEmail(kind, { name: 'Ramesh Kumar', title: 'Vrunda City', formUrl: 'https://www.realtydoor.com/listing-form/secret' });
    expect(out.subject).toBe(subject);
    expect(out.html).toContain(headline);
    expect(out.html).toContain('Vrunda City');
    expect(out.html).not.toContain('listing-form/secret');
    expect(out.html).not.toContain('>Open the form</a>');
    expect(out.html).toContain('Follow us on');
    expect(out.attachments.length).toBe(6);
  });
  test('the project name typed by the team is escaped in every one of them', () => {
    for (const kind of Object.keys(kinds)) {
      const out = buildFormEmail(kind, { name: 'A', title: '<b onmouseover=1>x</b>' });
      expect(out.html).not.toContain('<b onmouseover=1>');
    }
  });
  test('an unknown kind falls back to the plain thank-you instead of breaking', () => {
    expect(buildFormEmail('nonsense', { name: 'A' }).subject).toBe('We received your property details');
  });
});
