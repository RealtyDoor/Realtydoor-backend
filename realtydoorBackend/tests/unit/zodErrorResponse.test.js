// With zod 4 a validation failure must still answer 400 with the first message and the field list (zod 4 renamed ZodError.errors to .issues).
const { z } = require('zod');
const { errorHandler } = require('../../src/middleware/errorHandler');

const res = () => { const r = { headersSent: false, status: jest.fn(() => r), json: jest.fn(() => r) }; return r; };

test('a real ZodError becomes a 400 VALIDATION_ERROR with the field and message', () => {
  let err;
  try { z.object({ buyerName: z.string().min(2, 'Name is too short'), phone: z.string() }).parse({ buyerName: 'A' }); } catch (e) { err = e; }
  const r = res();
  errorHandler(err, {}, r, jest.fn());
  expect(r.status).toHaveBeenCalledWith(400);
  const body = r.json.mock.calls[0][0];
  expect(body).toMatchObject({ success: false, message: 'Name is too short', data: { code: 'VALIDATION_ERROR' } });
  expect(body.errors.map((e) => e.field).sort()).toEqual(['buyerName', 'phone']);
});

test('nested paths are joined with dots', () => {
  let err;
  try { z.object({ a: z.object({ b: z.number() }) }).parse({ a: { b: 'x' } }); } catch (e) { err = e; }
  const r = res();
  errorHandler(err, {}, r, jest.fn());
  expect(r.json.mock.calls[0][0].errors[0].field).toBe('a.b');
});

test('object defaults still fill in their inner defaults, and the slug reserved-word message names the word', () => {
  const { collectCommissionSchema } = require('../../src/modules/commission/commission.validator');
  expect(collectCommissionSchema.parse(undefined)).toEqual({ tdsDeductedRupees: 0 });
  const { slugSchema } = require('../../src/modules/microsites/microsite.validator');
  const r = slugSchema.safeParse('Admin');
  expect(r.success).toBe(false);
  expect(r.error.issues[0].message).toBe('"admin" is a reserved word and can\'t be used as a slug');
});
