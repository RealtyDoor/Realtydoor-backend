// BUG-013: GET /api/properties?city=%00 crashed the database driver (HTTP 500 plus a query dump). A NUL character is now a clean 400.
const express = require('express');
const request = require('supertest');
const { rejectNullBytes, hasNul } = require('../../src/middleware/rejectNullBytes');
const { errorHandler } = require('../../src/middleware/errorHandler');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rejectNullBytes);
app.all('/echo/:id', (req, res) => res.json({ ok: true }));
app.use(errorHandler);

describe('rejectNullBytes', () => {
  test('a NUL character in the query string is a 400 INVALID_CHARACTER', async () => {
    for (const q of ['city=%00', 'city=Beng%00aluru', 'a[b]=%00', 'x=1&city=%00']) {
      const r = await request(app).get('/echo/1?' + q);
      expect(r.status).toBe(400);
      expect(r.body.data.code).toBe('INVALID_CHARACTER');
      expect(r.body.stack).toBeUndefined();
    }
  });
  test('in the route parameter and in a JSON body (also nested) too', async () => {
    expect((await request(app).get('/echo/ab%00cd')).status).toBe(400);
    expect((await request(app).post('/echo/1').send({ note: 'a\u0000b' })).status).toBe(400);
    expect((await request(app).post('/echo/1').send({ a: { b: [{ c: '\u0000' }] } })).status).toBe(400);
    expect((await request(app).post('/echo/1').type('form').send('note=a%00b')).status).toBe(400);
  });
  test('normal requests, including accents and Kannada, pass untouched', async () => {
    expect((await request(app).get('/echo/1?city=Bengaluru&q=' + encodeURIComponent('ಯಲಹಂಕ café'))).status).toBe(200);
    expect((await request(app).post('/echo/1').send({ note: 'ಯಲಹಂಕ ₹50,000 <b>x</b>', n: 5, ok: true, none: null })).status).toBe(200);
  });
  test('hasNul reads nested values and stops on very deep objects', () => {
    expect(hasNul({ a: ['x', { b: 'y\u0000' }] })).toBe(true);
    expect(hasNul({ a: ['x', { b: 'y' }] })).toBe(false);
    let deep = {}; let cur = deep; for (let i = 0; i < 20; i += 1) { cur.n = {}; cur = cur.n; } cur.v = '\u0000';
    expect(hasNul(deep)).toBe(false); // deeper than the guard looks: left to the validators
  });
});
