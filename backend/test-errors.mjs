// Unit tests: the central error handler maps errors to generic answers and logs one redacted line.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'e'.repeat(40);
const { errorHandler, redactUrl, describeError } = await import('./src/errors.js');

function fake(err) {
  const req = { id: 'req-1', method: 'POST', path: '/api/x', ip: '10.1.1.1', user: { id: 'u1' } };
  const res = { headersSent: false, code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  return { req, res, run: async () => {
    const out = []; const orig = console.error; console.error = (...a) => out.push(a.join(' '));
    try { await errorHandler(err, req, res, () => {}); } finally { console.error = orig; }
    return out.join('\n');
  } };
}
const pg = (code, extra = {}) => Object.assign(new Error(`pg error ${code}`), { code, ...extra });

test('database and transport errors map to generic statuses with the request id', async () => {
  const cases = [
    [pg('22P02'), 400], [pg('23505'), 409], [pg('23503'), 409], [pg('P0001', { message: 'Some trigger said internal things' }), 409], [pg('40P01'), 409],
    [pg('57014'), 503], [Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 503], [Object.assign(new Error('x'), { code: 'RATE_LIMIT_STORE_UNAVAILABLE' }), 503],
    [pg('08006'), 503], [Object.assign(new Error('x'), { type: 'entity.too.large' }), 413], [new Error('boom'), 500],
  ];
  for (const [err, status] of cases) {
    const f = fake(err); await f.run();
    assert.equal(f.res.code, status, `${err.code || err.type || err.message}`);
    assert.equal(f.res.body.request_id, 'req-1');
    assert.equal(/trigger said|pg error|boom/.test(f.res.body.error), false, 'generic text only');
  }
});

test('logs never contain pg row details or credentials; the stack only for 5xx', async () => {
  const err = pg('23505', { constraint: 'users_email_key', detail: 'Key (email)=(a@b.edu) already exists.', where: 'SQL statement "x"', message: 'connect postgres://u:pw@h/db' });
  let f = fake(err); let out = await f.run();
  assert.equal(out.includes('a@b.edu'), false); assert.equal(out.includes(':pw@'), false); assert.ok(out.includes('users_email_key'));
  assert.equal(JSON.parse(out).error.stack, undefined);
  f = fake(new Error('boom at postgres://x:secretpw@db:5432/app')); out = await f.run();
  assert.ok(JSON.parse(out).error.stack, '5xx carries a stack'); assert.equal(out.includes('secretpw'), false);
  assert.equal(redactUrl('redis://:pw@h:6379').includes('pw'), false);
  assert.equal(redactUrl('nonsense'), '[unparseable url]');
  assert.deepEqual(Object.keys(describeError(err)).sort(), ['code', 'constraint', 'message', 'name', 'table']);
});
