jest.mock('https', () => ({ get: jest.fn() }));

const https = require('https');
const { isTrustedMediaUrl } = require('../../src/lib/trustedUrl');
const { buildPropertyBrochurePdf } = require('../../src/lib/propertyBrochure');

const env = { AWS_S3_BUCKET: 'rd-media', AWS_REGION: 'ap-south-1', TRUSTED_MEDIA_HOSTS: 'cdn.example.com, Images.Example.com' };

describe('isTrustedMediaUrl', () => {
  test('accepts https URLs on our bucket and on the named hosts, in any letter case', () => {
    expect(isTrustedMediaUrl('https://rd-media.s3.ap-south-1.amazonaws.com/listings/a.png', env)).toBe(true);
    expect(isTrustedMediaUrl('https://cdn.example.com/a.jpg', env)).toBe(true);
    expect(isTrustedMediaUrl('https://IMAGES.example.com/a.jpg', env)).toBe(true);
  });
  test('rejects internal addresses, other hosts, plain http, odd ports and credential tricks', () => {
    for (const bad of [
      'http://rd-media.s3.ap-south-1.amazonaws.com/a.png',
      'https://169.254.169.254/latest/meta-data/x.png',
      'https://localhost/a.png',
      'https://10.0.0.5/a.png',
      'https://evil.example/a.png',
      'https://rd-media.s3.ap-south-1.amazonaws.com.evil.example/a.png',
      'https://rd-media.s3.ap-south-1.amazonaws.com@evil.example/a.png',
      'https://cdn.example.com:8443/a.png',
      'https://user:pw@cdn.example.com/a.png',
      'file:///etc/passwd', 'javascript:alert(1)', '//cdn.example.com/a.png', 'not a url', '', null, undefined, 42,
    ]) {
      expect(isTrustedMediaUrl(bad, env)).toBe(false);
    }
  });
  test('rejects an absurdly long URL', () => {
    expect(isTrustedMediaUrl(`https://cdn.example.com/${'a'.repeat(3000)}.png`, env)).toBe(false);
  });
  test('trusts nothing when no bucket or host is configured', () => {
    expect(isTrustedMediaUrl('https://cdn.example.com/a.png', {})).toBe(false);
  });
});

describe('property brochure image fetching', () => {
  test('never requests a URL that is not on trusted storage, so a listing cannot aim the server at an internal address', async () => {
    const pdf = await buildPropertyBrochurePdf({
      title: 'Test Villa', images: ['https://169.254.169.254/latest/meta-data/x.png', 'http://localhost:27017/a.png', 'https://evil.example/a.png'],
      listingType: 'SALE', price: 5000000,
    });
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(https.get).not.toHaveBeenCalled();
  });
});
