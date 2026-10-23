const { errorHandler, isMalformedObjectIdError } = require('../../src/middleware/errorHandler');

function run(err) {
  const res = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn() };
  errorHandler(err, { method: 'GET', originalUrl: '/x' }, res, jest.fn());
  return res;
}

describe('malformed ObjectId handling (B128)', () => {
  test('recognises the Prisma P2023 code and the message form', () => {
    expect(isMalformedObjectIdError({ code: 'P2023', message: 'x' })).toBe(true);
    expect(isMalformedObjectIdError(new Error('Inconsistent column data: Malformed ObjectID: invalid character')))
      .toBe(true);
    expect(isMalformedObjectIdError(new Error('connection refused'))).toBe(false);
    expect(isMalformedObjectIdError(null)).toBe(false);
  });

  test('answers 400 INVALID_ID instead of 500', () => {
    const res = run({ code: 'P2023', message: 'Malformed ObjectID' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].data.code).toBe('INVALID_ID');
  });

  test('other errors are still 500', () => {
    const res = run(new Error('boom'));
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('body parser failures are the client\'s mistake', () => {
  test('a body that is not valid JSON is a 400 INVALID_JSON, not a 500', () => {
    const res = run(Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 }));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].data.code).toBe('INVALID_JSON');
  });

  test('a body over the size limit is a 413 BODY_TOO_LARGE', () => {
    const res = run(Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 }));
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json.mock.calls[0][0].data.code).toBe('BODY_TOO_LARGE');
  });

  test('neither leaks internals', () => {
    const res = run(Object.assign(new SyntaxError('Unexpected token < in JSON at position 0'), { type: 'entity.parse.failed' }));
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/position|stack|Unexpected/);
  });
});


describe('the stack trace never reaches the client by default (BUG-006)', () => {
  const OLD = { NODE_ENV: process.env.NODE_ENV, EXPOSE: process.env.EXPOSE_ERROR_STACK };
  afterEach(() => { process.env.NODE_ENV = OLD.NODE_ENV; if (OLD.EXPOSE === undefined) delete process.env.EXPOSE_ERROR_STACK; else process.env.EXPOSE_ERROR_STACK = OLD.EXPOSE; });
  const body = () => run(new Error('boom /Users/x/secret/file.js:12')).json.mock.calls[0][0];

  test.each(['development', 'test', 'production', undefined])('NODE_ENV=%s: no stack, no file path, only the generic message', (env) => {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
    delete process.env.EXPOSE_ERROR_STACK;
    const b = body();
    expect(b.stack).toBeUndefined();
    expect(JSON.stringify(b)).not.toMatch(/\/Users\/|secret|file\.js/);
    expect(b.message).toBe('Internal Server Error');
  });
  test('a client error (404, 400) has no stack either', () => {
    process.env.NODE_ENV = 'development';
    const ApiError = require('../../src/utils/ApiError');
    expect(run(new ApiError(404, 'Property not found')).json.mock.calls[0][0].stack).toBeUndefined();
  });
  test('a developer can switch it on explicitly on their own machine, but never in production', () => {
    process.env.EXPOSE_ERROR_STACK = 'true';
    process.env.NODE_ENV = 'development';
    expect(body().stack).toContain('boom');
    process.env.NODE_ENV = 'production';
    expect(body().stack).toBeUndefined();
  });
});
