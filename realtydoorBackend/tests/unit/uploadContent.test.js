const { assertFileMatchesExtension } = require('../../src/lib/fileUpload');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(10)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

describe('assertFileMatchesExtension: the file must really be what its name says', () => {
  test('genuine images and PDFs pass', () => {
    expect(() => assertFileMatchesExtension(JPEG, '.jpg')).not.toThrow();
    expect(() => assertFileMatchesExtension(JPEG, '.jpeg')).not.toThrow();
    expect(() => assertFileMatchesExtension(PNG, '.png')).not.toThrow();
    expect(() => assertFileMatchesExtension(WEBP, '.webp')).not.toThrow();
    expect(() => assertFileMatchesExtension(PDF, '.pdf')).not.toThrow();
  });

  test('a PDF with a little junk before the header (allowed by the format) still passes', () => {
    expect(() => assertFileMatchesExtension(Buffer.concat([Buffer.from('junk\n'), PDF]), '.pdf')).not.toThrow();
  });

  test.each([
    ['an HTML page named .png', HTML, '.png'],
    ['an SVG with a script named .jpg', SVG, '.jpg'],
    ['a PNG named .pdf', PNG, '.pdf'],
    ['a PDF named .png', PDF, '.png'],
    ['a JPEG named .webp', JPEG, '.webp'],
    ['an empty file', Buffer.alloc(0), '.png'],
    ['a tiny file', Buffer.from([0xff]), '.jpg'],
    ['a RIFF file that is not WEBP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(10)]), '.webp'],
  ])('rejects %s', (_n, buf, ext) => {
    expect(() => assertFileMatchesExtension(buf, ext)).toThrow(/not a valid/);
  });

  test('the error is a 400 with a code the app can show', () => {
    try { assertFileMatchesExtension(HTML, '.png'); } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.data.code).toBe('FILE_CONTENT_MISMATCH');
    }
  });

  test('videos and unknown extensions are left to the extension allow-list', () => {
    expect(() => assertFileMatchesExtension(HTML, '.mp4')).not.toThrow();
    expect(() => assertFileMatchesExtension(HTML, '.mov')).not.toThrow();
  });

  test('a non-buffer is refused for a checked type', () => {
    expect(() => assertFileMatchesExtension('not a buffer', '.png')).toThrow(/not a valid/);
    expect(() => assertFileMatchesExtension(undefined, '.pdf')).toThrow(/not a valid/);
  });
});
