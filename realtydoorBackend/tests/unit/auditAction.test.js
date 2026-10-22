jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn(() => Promise.resolve()) }));
const { createAuditLog } = require('../../src/lib/auditLog');
const { auditAction } = require('../../src/middleware/auditAction');

function run(action, req, statusCode = 200) {
  const handlers = {};
  const res = { statusCode, on: (e, fn) => { handlers[e] = fn; } };
  auditAction(action, 'Vendor')({ user: { id: 'a1' }, params: { id: 'v1' }, ip: '1.2.3.4', ...req }, res, () => {});
  handlers.finish();
}

beforeEach(() => createAuditLog.mockClear());

describe('auditAction with a function name (T45)', () => {
  const name = (req) => (req.body?.isActive === false ? 'VENDOR_DEACTIVATED' : req.body?.isActive === true ? 'VENDOR_REACTIVATED' : 'VENDOR_UPDATED');
  it('logs the action chosen from the request', () => {
    run(name, { body: { isActive: true } });
    expect(createAuditLog.mock.calls[0][0]).toMatchObject({ action: 'VENDOR_REACTIVATED', targetId: 'v1', ipAddress: '1.2.3.4' });
    run(name, { body: { city: 'x' } });
    expect(createAuditLog.mock.calls[1][0].action).toBe('VENDOR_UPDATED');
  });
  it('still accepts a plain string and skips failed requests', () => {
    run('VENDOR_DEACTIVATED', { body: {} });
    expect(createAuditLog.mock.calls[0][0].action).toBe('VENDOR_DEACTIVATED');
    run('X', { body: {} }, 500);
    expect(createAuditLog).toHaveBeenCalledTimes(1);
  });
});
