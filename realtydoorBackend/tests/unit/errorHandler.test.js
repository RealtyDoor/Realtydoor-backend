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
