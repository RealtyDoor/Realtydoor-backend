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

