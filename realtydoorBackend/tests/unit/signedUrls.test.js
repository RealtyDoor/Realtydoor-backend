// BUG-048: allocation letters, KYC papers and other private uploads were stored and returned as plain public bucket links that
// anyone holding the URL could open. Responses on signed-in routes now carry short-lived signed links for private folders.
process.env.AWS_S3_BUCKET = 'test-bucket';
process.env.AWS_REGION = 'ap-south-2';
process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
process.env.AWS_SECRET_ACCESS_KEY = 'testsecrettestsecrettestsecret1234567890';

const express = require('express');
const request = require('supertest');
const { isPrivateUrl, signUrl, signDeep, signPrivateUrls } = require('../../src/lib/signedUrls');

const host = 'https://test-bucket.s3.ap-south-2.amazonaws.com';

describe('which links are private', () => {
  test.each([
    `${host}/visits/a1.pdf`, `${host}/kyc/a1.jpg`, `${host}/documents/a1.pdf`, `${host}/properties/documents/a1.pdf`,
    `${host}/partners/tax-invoices/a1.pdf`, `${host}/tickets/a1.png`,
    // Audit Nov 2026 (A1): private unless the folder is public, so these and any new folder are covered.
    `${host}/receipts/r1.pdf`, `${host}/video-tours/a.mp4`, `${host}/realtydoor/kyc/a.jpeg`, `${host}/onboarding/a.pdf`, `${host}/some-new-folder/a.pdf`,
  ])('%s is private', (u) => expect(isPrivateUrl(u)).toBe(true));

  test.each([
    `${host}/properties/a1.jpg`, `${host}/admin-cms/a1.png`, `${host}/partners/profile-photos/a1.png`, `${host}/blog/a.png`, `${host}/microsites/a.png`, `${host}/properties/import/b.pdf`, `${host}/`,
    'https://other-bucket.s3.ap-south-2.amazonaws.com/visits/a1.pdf', 'https://evil.example.com/visits/a1.pdf',
    'not a url', '', null, 42, `${host}/visits/a1.pdf?X-Amz-Signature=abc`,
  ])('%s is left alone', (u) => expect(isPrivateUrl(u)).toBe(false));
});

describe('signing', () => {
  test('a private link becomes a signed, expiring link to the same object', async () => {
    const out = await signUrl(`${host}/visits/a1.pdf`, 600);
    const u = new URL(out);
    expect(u.pathname).toBe('/visits/a1.pdf');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(u.searchParams.get('response-cache-control')).toBe('private, no-store');
  });

  test('signDeep signs private links wherever they sit and keeps everything else as it was', async () => {
    const date = new Date('2026-10-24T00:00:00Z');
    const input = {
      id: 'x', n: 3, ok: true, nothing: null, when: date,
      allocationLetterUrl: `${host}/visits/a1.pdf`, photo: `${host}/properties/p.jpg`,
      docs: [`${host}/kyc/1.jpg`, { fileUrl: `${host}/documents/2.pdf`, name: 'a' }],
    };
    const out = await signDeep(input);
    expect(out.allocationLetterUrl).toContain('X-Amz-Signature');
    expect(out.docs[0]).toContain('X-Amz-Signature');
    expect(out.docs[1].fileUrl).toContain('X-Amz-Signature');
    expect(out.photo).toBe(`${host}/properties/p.jpg`);
    expect(out.when).toBe(date);
    expect(out).toMatchObject({ id: 'x', n: 3, ok: true, nothing: null });
    expect(input.allocationLetterUrl).toBe(`${host}/visits/a1.pdf`); // the input is not mutated
  });
});

describe('the response middleware', () => {
  const app = express();
  app.use(signPrivateUrls);
  app.get('/doc', (req, res) => res.status(200).json({ success: true, data: { url: `${host}/visits/a1.pdf`, cover: `${host}/properties/c.jpg` } }));
  app.get('/text', (req, res) => res.send('plain'));

  test('JSON responses carry signed private links and untouched public ones', async () => {
    const res = await request(app).get('/doc');
    expect(res.status).toBe(200);
    expect(res.body.data.url).toContain('X-Amz-Signature');
    expect(res.body.data.cover).toBe(`${host}/properties/c.jpg`);
  });

  test('a response that is not JSON passes through', async () => {
    expect((await request(app).get('/text')).text).toBe('plain');
  });
});

test('a video tour link lasts 4 hours, other private links 15 minutes', async () => {
  expect(new URL(await signUrl(`${host}/video-tours/a.mp4`)).searchParams.get('X-Amz-Expires')).toBe('14400');
  expect(new URL(await signUrl(`${host}/kyc/a.jpg`)).searchParams.get('X-Amz-Expires')).toBe('900');
});

describe('a signed link sent back to us is stored plain (audit Nov 2026, A1)', () => {
  const { unsignUrl, unsignRequestUrls } = require('../../src/lib/signedUrls');

  test('our own signed link loses its signature; everything else is untouched', async () => {
    const signed = await signUrl(`${host}/kyc/a1.jpg`);
    expect(unsignUrl(signed)).toBe(`${host}/kyc/a1.jpg`);
    expect(unsignUrl(`${host}/properties/p.jpg`)).toBe(`${host}/properties/p.jpg`);
    expect(unsignUrl('https://other.example.com/a.pdf?X-Amz-Signature=abc')).toBe('https://other.example.com/a.pdf?X-Amz-Signature=abc');
    expect(unsignUrl('https://maps.example.com/?q=1')).toBe('https://maps.example.com/?q=1');
  });

  test('the request middleware cleans a JSON body, at any depth', async () => {
    const signed = await signUrl(`${host}/properties/documents/d.pdf`);
    const app = express();
    app.use(express.json(), unsignRequestUrls);
    app.post('/save', (req, res) => res.json(req.body));
    const res = await request(app).post('/save').send({ title: 'x', n: 2, documents: [{ name: 'Deed', url: signed }], cover: `${host}/properties/c.jpg` });
    expect(res.body).toEqual({ title: 'x', n: 2, documents: [{ name: 'Deed', url: `${host}/properties/documents/d.pdf` }], cover: `${host}/properties/c.jpg` });
  });
});
