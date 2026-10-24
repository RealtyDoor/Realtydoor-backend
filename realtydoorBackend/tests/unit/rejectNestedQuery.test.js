// A query string such as ?status[not]=CLOSED becomes an OBJECT in req.query, which several list endpoints hand to the database as a
// filter, so the caller would choose the query operator. No endpoint of ours takes a nested query value; refuse them all with a 400.
const { rejectNestedQuery } = require('../../src/middleware/rejectNestedQuery');

const run = (query) => { let err; rejectNestedQuery({ query }, {}, (e) => { err = e; }); return err; };

test.each([
  [{ status: 'OPEN' }], [{}], [{ page: '2', limit: '20' }], [{ tag: ['a', 'b'] }], [{ q: '' }],
])('plain query %j passes', (q) => expect(run(q)).toBeUndefined());

test.each([
  [{ status: { not: 'CLOSED' } }], [{ id: { $ne: 'x' } }], [{ a: { b: { c: 1 } } }], [{ tag: [{ in: 'x' }] }], [{ tag: ['ok', { gt: '1' }] }], [{ x: [['nested']] }],
])('nested query %j is a 400 INVALID_QUERY', (q) => {
  const err = run(q);
  expect(err).toMatchObject({ statusCode: 400, data: { code: 'INVALID_QUERY' } });
});

test('a missing query object does not crash', () => expect(run(undefined)).toBeUndefined());
