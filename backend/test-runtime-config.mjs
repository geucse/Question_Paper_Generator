// Unit tests: production configuration refusals and readiness evaluation (pure, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { productionConfigProblems, parseTrustProxy, parseKey32, evaluateReadiness, parseAllowedOrigins } from './src/runtime-config.js';

const GOOD = {
  NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://exam.example.edu,https://staging.example.edu',
  OTP_DELIVERY_PROVIDER: 'smtp', SMTP_HOST: 'mail.example.edu', SMTP_PORT: '587', SMTP_FROM: 'noreply@example.edu', SMTP_USER: 'mailer', SMTP_PASS: 'smtp-s3cret',
  TOTP_ENCRYPTION_KEY: '0f'.repeat(32), CLAMD_HOST: 'clamav', CLAMD_PORT: '3310', TRUST_PROXY: '2', RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'Zq8'.repeat(16), DATABASE_URL: 'postgres://u:p@db/x',
};
const problems = (over) => productionConfigProblems({ ...GOOD, ...over });

test('outside production there is nothing to refuse; a complete production configuration passes', () => {
  assert.deepEqual(productionConfigProblems({}), []);
  assert.deepEqual(productionConfigProblems({ NODE_ENV: 'development' }), []);
  assert.deepEqual(problems({}), []);
  assert.deepEqual(problems({ RATE_LIMIT_STORE: 'memory', REDIS_URL: '' }), [], 'explicit single replica');
  assert.deepEqual(problems({ CLAMD_HOST: '', CLAMD_SOCKET: '/run/clamd.sock' }), []);
});

test('each production misconfiguration is one problem naming the variable, never its value', () => {
  const cases = [
    [{ CORS_ALLOWED_ORIGINS: '' }, /CORS_ALLOWED_ORIGINS/], [{ CORS_ALLOWED_ORIGINS: '*' }, /CORS_ALLOWED_ORIGINS/],
    [{ CORS_ALLOWED_ORIGINS: 'https://a.edu/x' }, /CORS_ALLOWED_ORIGINS/], [{ CORS_ALLOWED_ORIGINS: 'https://a.edu/' }, /CORS_ALLOWED_ORIGINS/],
    [{ OTP_DELIVERY_PROVIDER: 'console' }, /OTP_DELIVERY_PROVIDER/], [{ SMTP_PASS: '' }, /SMTP_USER and SMTP_PASS/],
    [{ TOTP_ENCRYPTION_KEY: '' }, /TOTP_ENCRYPTION_KEY is required/], [{ TOTP_ENCRYPTION_KEY: 'aa'.repeat(16) }, /exactly 32 bytes/],
    [{ CLAMD_HOST: '' }, /CLAMD_HOST/], [{ CLAMD_HOST: '', CLAMD_CONFIG_PATH: '/app/deploy/clamd-client.conf' }, /CLAMD_CONFIG_PATH is no longer used.*CLAMD_HOST/],
    [{ TRUST_PROXY: 'true' }, /TRUST_PROXY/], [{ RATE_LIMIT_STORE: 'bogus' }, /RATE_LIMIT_STORE/], [{ REDIS_URL: '' }, /REDIS_URL/],
    [{ JWT_SECRET: 'replace-with-a-long-random-string-0123456789' }, /JWT_SECRET/], [{ DATABASE_URL: '' }, /DATABASE_URL/],
  ];
  for (const [over, re] of cases) {
    const p = problems(over);
    assert.equal(p.length, 1, `${JSON.stringify(over)} -> ${JSON.stringify(p)}`); assert.match(p[0], re);
  }
  const all = productionConfigProblems({ NODE_ENV: 'production', SMTP_PASS: 'smtp-s3cret', JWT_SECRET: 'replace-with-it-0123456789012345678901', OTP_DELIVERY_PROVIDER: 'smtp', SMTP_HOST: 'h', SMTP_PORT: '25' }).join(' ');
  assert.equal(/smtp-s3cret|replace-with-it/.test(all), false, 'no values in messages');
});

test('parsers', () => {
  assert.equal(parseTrustProxy('2'), 2); assert.equal(parseTrustProxy(''), 1); assert.equal(parseTrustProxy(undefined), 1);
  assert.equal(parseTrustProxy('false'), false); assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
  assert.equal(parseKey32(Buffer.alloc(32, 1).toString('base64')).length, 32); assert.equal(parseKey32('ab'.repeat(32)).length, 32);
  assert.equal(parseKey32(Buffer.alloc(31, 1).toString('base64')), null); assert.equal(parseKey32('not a key!'), null); assert.equal(parseKey32(undefined), null);
  assert.deepEqual(parseAllowedOrigins(' https://a.edu , ,https://b.edu'), ['https://a.edu', 'https://b.edu']);
});

const OK = { database: 'ok', rateLimit: { kind: 'redis', ok: true }, clamav: 'ok', otp: { provider: 'smtp', configured: true }, totpKey: true };
test('readiness: 503 only when a required check fails; a ClamAV outage degrades; bodies hold fixed tokens only', () => {
  let r = evaluateReadiness(OK, { production: true });
  assert.equal(r.httpStatus, 200); assert.equal(r.body.status, 'ready'); assert.equal(r.body.protections.rate_limiting, 'shared (Redis)');
  r = evaluateReadiness({ ...OK, clamav: 'unavailable' }, { production: true });
  assert.equal(r.httpStatus, 200); assert.equal(r.body.status, 'degraded'); assert.deepEqual(r.body.failing, []);
  for (const [over, name] of [[{ rateLimit: { kind: 'redis', ok: false } }, 'rate_limit_store'], [{ otp: { provider: 'console', configured: true } }, 'otp_delivery'],
    [{ otp: { provider: 'none', configured: false } }, 'otp_delivery'], [{ totpKey: false }, 'totp_encryption_key'], [{ clamav: 'not_configured' }, 'clamav'], [{ database: 'fail' }, 'database']]) {
    r = evaluateReadiness({ ...OK, ...over }, { production: true });
    assert.equal(r.httpStatus, 503, name); assert.equal(r.body.status, 'not_ready'); assert.ok(r.body.failing.includes(name), name);
  }
  r = evaluateReadiness({ ...OK, rateLimit: { kind: 'memory', ok: true }, clamav: 'not_configured', otp: { provider: 'none', configured: false } }, { production: false });
  assert.equal(r.httpStatus, 200); assert.equal(r.body.status, 'degraded');
  assert.equal(evaluateReadiness({ ...OK, database: 'fail' }, { production: false }).httpStatus, 503);
  assert.equal(/"(error|message)"/.test(JSON.stringify(r.body)), false);
});
