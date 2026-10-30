// S3 clients must use the task's IAM role when no static keys are set. Passing { accessKeyId: undefined } makes the AWS SDK fail
// ("Resolved credential object is not valid") instead of falling back to the role, so the option has to be left out entirely.
const mockS3 = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: mockS3, PutObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(), GetObjectCommand: jest.fn() }));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const ENV = process.env;
beforeEach(() => { mockS3.mockClear(); jest.resetModules(); });
afterEach(() => { process.env = ENV; });
const withEnv = (extra) => { process.env = { ...ENV, AWS_REGION: 'ap-south-2', AWS_S3_BUCKET: 'b', ...extra }; delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY; Object.assign(process.env, extra); };

const loaders = {
  'file uploads': () => { require('../../src/lib/fileUpload'); },
  'signed links': () => { require('../../src/lib/signedUrls').signUrl('https://b.s3.ap-south-2.amazonaws.com/kyc/x.pdf'); },
};

describe.each(Object.entries(loaders))('%s', (_name, load) => {
  test('without static keys the client is built with no credentials option (the IAM role is used)', () => {
    withEnv({});
    load();
    expect(mockS3).toHaveBeenCalled();
    expect(mockS3.mock.calls[0][0]).not.toHaveProperty('credentials');
    expect(mockS3.mock.calls[0][0].region).toBe('ap-south-2');
  });
  test('with both static keys they are passed through (local development)', () => {
    withEnv({ AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK' });
    load();
    expect(mockS3.mock.calls[0][0].credentials).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' });
  });
  test('with only half a key pair no credentials are passed (never a broken pair)', () => {
    withEnv({ AWS_ACCESS_KEY_ID: 'AK' });
    load();
    expect(mockS3.mock.calls[0][0]).not.toHaveProperty('credentials');
  });
});
