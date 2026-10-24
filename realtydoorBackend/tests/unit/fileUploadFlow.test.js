// File upload end to end through a real multer + the uploader factory, with S3 replaced by a recorder: type allow-list,
// content check, forced content type, unguessable key, size limit, many files, and no upload when anything is refused.
const mockSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn((input) => ({ kind: 'put', input })),
  DeleteObjectCommand: jest.fn((input) => ({ kind: 'delete', input })),
}));
process.env.AWS_S3_BUCKET = 'test-bucket';
process.env.AWS_REGION = 'ap-south-2';

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../src/middleware/errorHandler');
const f = require('../../src/lib/fileUpload');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const app = express();
app.post('/doc', f.userDocUploader.single('file'), (req, res) => res.json({ path: req.file?.path, key: req.file?.s3Key }));
app.post('/photos', f.visitPhotoUploader.array('photos', 3), (req, res) => res.json({ paths: (req.files || []).map((x) => x.path) }));
app.post('/mixed', f.dealDocUploader.fields([{ name: 'visitPhotos', maxCount: 2 }, { name: 'closureDocs', maxCount: 2 }]), (req, res) => res.json({ ok: true, n: Object.values(req.files || {}).flat().length }));
app.use(errorHandler);

beforeEach(() => mockSend.mockClear());
const puts = () => mockSend.mock.calls.map((c) => c[0]).filter((c) => c.kind === 'put').map((c) => c.input);

describe('what is accepted', () => {
  test.each([['a.pdf', PDF, 'application/pdf'], ['a.jpg', JPEG, 'image/jpeg'], ['a.jpeg', JPEG, 'image/jpeg'], ['a.png', PNG, 'image/png']])('%s is stored under documents/ as a random name', async (name, buf, type) => {
    const res = await request(app).post('/doc').attach('file', buf, name);
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(/^documents\/[0-9a-f-]{36}\.(pdf|jpe?g|png)$/);
    expect(res.body.path).toBe(`https://test-bucket.s3.ap-south-2.amazonaws.com/${res.body.key}`);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ Bucket: 'test-bucket', Key: res.body.key, ContentType: type });
  });
  test('the stored name never contains anything the sender chose', async () => {
    const res = await request(app).post('/doc').attach('file', PDF, '../../etc/passwd.pdf');
    expect(res.status).toBe(200);
    expect(res.body.key).not.toMatch(/passwd|\.\./);
  });
  test('the uppercase extension works and is stored lower case', async () => {
    const res = await request(app).post('/doc').attach('file', PNG, 'PHOTO.PNG');
    expect(res.status).toBe(200);
    expect(res.body.key.endsWith('.png')).toBe(true);
  });
  test('a client-claimed content type is ignored: the stored type comes from the checked extension', async () => {
    await request(app).post('/doc').attach('file', PNG, { filename: 'a.png', contentType: 'text/html' });
    expect(puts()[0].ContentType).toBe('image/png');
  });
});

describe('what is refused (and nothing is uploaded)', () => {
  test.each([['x.exe'], ['x.html'], ['x.svg'], ['x.js'], ['x.php'], ['x.pdf.exe'], ['x'], ['x.'], ['.htaccess'], ['x.gif']])('the file name %s is a 400', async (name) => {
    const res = await request(app).post('/doc').attach('file', PDF, name);
    expect(res.status).toBe(400);
    expect(puts()).toHaveLength(0);
  });
  test.each([['an HTML page named .png', HTML, 'a.png'], ['an HTML page named .pdf', HTML, 'a.pdf'], ['a PNG named .jpg', PNG, 'a.jpg'], ['an empty .png', Buffer.alloc(0), 'a.png']])('%s is a 400 FILE_CONTENT_MISMATCH', async (_n, buf, name) => {
    const res = await request(app).post('/doc').attach('file', buf, name);
    expect(res.status).toBe(400);
    expect(res.body.data?.code).toBe('FILE_CONTENT_MISMATCH');
    expect(puts()).toHaveLength(0);
  });
  test('a file over the 10 MB limit is a 400, not a 500, and is not stored', async () => {
    const res = await request(app).post('/doc').attach('file', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 10)]), 'a.pdf');
    expect(res.status).toBe(400);
    expect(puts()).toHaveLength(0);
  });
  test('too many files for the field is a 400', async () => {
    let req = request(app).post('/photos');
    for (let i = 0; i < 4; i += 1) req = req.attach('photos', JPEG, `p${i}.jpg`);
    expect((await req).status).toBe(400);
    expect(puts()).toHaveLength(0);
  });
  test('a file in a field nobody asked for is a 400', async () => {
    const res = await request(app).post('/doc').attach('other', PDF, 'a.pdf');
    expect(res.status).toBe(400);
    expect(puts()).toHaveLength(0);
  });
  test('a request with no file passes through with no upload (the route decides if one is required)', async () => {
    const res = await request(app).post('/doc').field('x', '1');
    expect(res.status).toBe(200);
    expect(res.body.path).toBeUndefined();
    expect(puts()).toHaveLength(0);
  });
  test('an S3 outage is an error response, not a hang', async () => {
    mockSend.mockRejectedValueOnce(new Error('S3 down'));
    const res = await request(app).post('/doc').attach('file', PDF, 'a.pdf');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toContain('S3 down');
  });
});

describe('several files', () => {
  test('an array upload stores each with its own random key', async () => {
    const res = await request(app).post('/photos').attach('photos', JPEG, 'a.jpg').attach('photos', PNG, 'b.png');
    expect(res.status).toBe(200);
    expect(new Set(res.body.paths).size).toBe(2);
    expect(res.body.paths.every((p) => p.includes('/visits/'))).toBe(true);
  });
  test('named fields upload to the same folder; one bad file stops the request after refusing, and no later file is stored as valid', async () => {
    const good = await request(app).post('/mixed').attach('visitPhotos', JPEG, 'a.jpg').attach('closureDocs', PDF, 'b.pdf');
    expect(good.body).toMatchObject({ ok: true, n: 2 });
    mockSend.mockClear();
    const bad = await request(app).post('/mixed').attach('visitPhotos', HTML, 'a.jpg').attach('closureDocs', PDF, 'b.pdf');
    expect(bad.status).toBe(400);
    expect(puts().every((p) => !/html/i.test(String(p.Body)))).toBe(true);
  });
});

test('deleteFile asks S3 to remove exactly that key', async () => {
  await f.deleteFile('visits/abc.pdf');
  expect(mockSend.mock.calls[0][0]).toEqual({ kind: 'delete', input: { Bucket: 'test-bucket', Key: 'visits/abc.pdf' } });
});
