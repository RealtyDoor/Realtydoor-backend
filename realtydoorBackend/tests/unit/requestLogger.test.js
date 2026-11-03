// What the request logger writes. In production these lines go to CloudWatch, where developers are given read access, so they must not
// contain tokens, bank or tax identifiers, personal data in query strings, or the body of every successful response.
const { EventEmitter } = require('events');

const loadLogger = (nodeEnv) => {
  let mod; const logs = [];
  jest.isolateModules(() => {
    process.env.NODE_ENV = nodeEnv;
    jest.doMock('../../src/lib/logger', () => {
      const push = (level) => (msg, meta) => logs.push({ level, msg, meta });
      return { info: push('info'), warn: push('warn'), error: push('error') };
    });
    mod = require('../../src/middleware/requestLogger');
  });
  return { ...mod, logs };
};

const run = ({ nodeEnv = 'production', method = 'POST', url = '/api/x', query = {}, body = {}, status = 200, payload = { success: true } }) => {
  const m = loadLogger(nodeEnv);
  const req = { method, originalUrl: url, query, body, headers: { 'user-agent': 'jest', authorization: 'Bearer SECRET', cookie: 'a=b' }, ip: '1.2.3.4', socket: {} };
  const res = new EventEmitter();
  res.statusCode = status; res.setHeader = () => {}; res.getHeader = () => null; res.getHeaders = () => ({ 'set-cookie': 'x=y' });
  res.json = (p) => p;
  m.requestLogger(req, res, () => {});
  res.json(payload);
  res.emit('finish');
  return { ...m, req: m.logs.find((l) => l.msg.includes('Incoming')).meta, res: m.logs.find((l) => l.msg.includes('Response')).meta };
};

const ENV = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = ENV; jest.resetModules(); });

describe('request bodies', () => {
  test.each([
    'panNumber', 'pan', 'gstin', 'accountNumber', 'bankAccountNo', 'bankHolderName', 'bankIfsc', 'ifsc', 'upiId',
  ])('hides %s, also when nested', (key) => {
    const { req } = run({ body: { [key]: 'SENSITIVE-VALUE', partner: { nested: { [key]: 'SENSITIVE-VALUE' } }, title: 'Plot in Hoskote' } });
    expect(JSON.stringify(req.body)).not.toContain('SENSITIVE-VALUE');
    expect(req.body.title).toBe('Plot in Hoskote');
  });

  test('hides the text of a message typed by a visitor (contact, NRI and reply forms)', () => {
    const { req } = run({ body: { message: 'Call me on 9845012345, my PAN is ABCDE1234F', body: 'reply text', subject: 'Visit' } });
    expect(JSON.stringify(req.body)).not.toMatch(/9845012345|ABCDE1234F|reply text/);
    expect(req.body.subject).toBe('Visit');
  });

  test('still hides what it always hid', () => {
    const { req } = run({ body: { password: 'p', otp: '123456', email: 'a@b.in', phone: '9845012345', token: 't' } });
    expect(JSON.stringify(req.body)).not.toMatch(/123456|a@b\.in|9845012345/);
  });

  test('never logs the authorization or cookie headers', () => {
    const { req } = run({});
    expect(JSON.stringify(req)).not.toContain('SECRET');
  });
});

describe('query strings', () => {
  test('values of sensitive parameters are hidden in the url and in the query field', () => {
    const { req, res } = run({ method: 'GET', url: '/api/admin/users?search=9845012345&phone=9845012345&email=a%40b.in&page=2', query: { search: '9845012345', phone: '9845012345', email: 'a@b.in', page: '2' } });
    for (const line of [req, res]) expect(JSON.stringify(line)).not.toMatch(/9845012345|a%40b|a@b\.in/);
    expect(req.url).toContain('page=2');
    expect(req.url.startsWith('/api/admin/users?')).toBe(true);
    expect(req.query.page).toBe('2');
  });

  test('a url without a query string is unchanged', () => {
    const { redactUrl } = loadLogger('production');
    expect(redactUrl('/api/properties/some-slug')).toBe('/api/properties/some-slug');
    expect(redactUrl('/api/properties?city=Bengaluru&limit=12')).toBe('/api/properties?city=Bengaluru&limit=12');
  });
});

describe('response bodies', () => {
  test('in production a successful response body is not logged at all', () => {
    const { res } = run({ nodeEnv: 'production', status: 200, payload: { success: true, data: { name: 'x', panNumber: 'ABCDE1234F', anything: 'else' } } });
    expect(res.body).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  test('an error response body is logged, with the standard message kept and sensitive fields hidden', () => {
    const { res } = run({ nodeEnv: 'production', status: 400, payload: { success: false, message: 'Invalid token', data: { code: 'X', panNumber: 'ABCDE1234F' } } });
    expect(res.body.message).toBe('Invalid token');
    expect(JSON.stringify(res.body)).not.toContain('ABCDE1234F');
  });
});
