// Unit tests: TOTP secret sealing, OTP delivery configuration and masking, constant-time comparison, session length.
// Run: node --test test-auth-security.mjs (no database, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'u'.repeat(40);
process.env.TOTP_ENCRYPTION_KEY = '22'.repeat(32);
const box = await import('./src/secret-box.js');
const otp = await import('./src/otp-delivery.js');
const auth = await import('./src/auth.js');
const { AUTH_LIMITED_PATHS } = await import('./src/security.js');

test('sealSecret/openSecret: round trip; tampering, another account or another key all fail', () => {
  const sealed = box.sealSecret('JBSWY3DPEHPK3PXP', 'totp:u1');
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
  assert.equal(box.openSecret(sealed, 'totp:u1'), 'JBSWY3DPEHPK3PXP');
  assert.notEqual(box.sealSecret('JBSWY3DPEHPK3PXP', 'totp:u1'), sealed, 'fresh IV each time');
  const parts = sealed.split('.');
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  assert.throws(() => box.openSecret([parts[0], parts[1], parts[2], flip(parts[3])].join('.'), 'totp:u1'), box.SecretBoxError);
  assert.throws(() => box.openSecret(sealed, 'totp:u2'), box.SecretBoxError, 'bound to the account');
  assert.throws(() => box.openSecret(sealed, 'totp:u1', Buffer.alloc(32, 9)), box.SecretBoxError, 'another key');
  assert.throws(() => box.openSecret('JBSWY3DPEHPK3PXP', 'totp:u1'), box.SecretBoxError, 'plaintext is not accepted');
});

test('TOTP key: hex or base64 of exactly 32 bytes; required in production; a development key is derived otherwise', () => {
  assert.throws(() => box.loadTotpKey({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) }), /TOTP_ENCRYPTION_KEY is required in production/);
  assert.throws(() => box.loadTotpKey({ TOTP_ENCRYPTION_KEY: crypto.randomBytes(31).toString('hex') }), /exactly 32 bytes/);
  assert.equal(box.loadTotpKey({ TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') }).length, 32);
  assert.equal(box.loadTotpKey({ TOTP_ENCRYPTION_KEY: 'ab'.repeat(32) }).length, 32);
  const dev = box.loadTotpKey({ NODE_ENV: 'development', JWT_SECRET: 'y'.repeat(40) });
  assert.equal(dev.length, 32); assert.deepEqual(dev, box.loadTotpKey({ NODE_ENV: 'development', JWT_SECRET: 'y'.repeat(40) }), 'stable');
  assert.deepEqual(box.totpKeyProblems({ NODE_ENV: 'production' }).length, 1);
  assert.deepEqual(box.totpKeyProblems({ NODE_ENV: 'development' }), []);
  assert.equal(box.totpKeyProblems({ TOTP_ENCRYPTION_KEY: 'short' }).length, 1);
});

const SMTP = { OTP_DELIVERY_PROVIDER: 'smtp', SMTP_HOST: 'mail.example.edu', SMTP_PORT: '587', SMTP_FROM: 'noreply@example.edu', SMTP_USER: 'u', SMTP_PASS: 's3cret-pass' };
test('OTP delivery configuration: production needs complete SMTP and no dev flags; development needs an explicit console flag', () => {
  const prod = (e) => otp.otpDeliveryProblems({ NODE_ENV: 'production', ...e });
  assert.deepEqual(prod(SMTP), []);
  assert.deepEqual(prod({ ...SMTP, SMTP_USER: '', SMTP_PASS: '' }), [], 'unauthenticated relay is allowed');
  assert.ok(prod({ ...SMTP, OTP_DELIVERY_PROVIDER: 'console' }).some((p) => /OTP_DELIVERY_PROVIDER/.test(p)));
  assert.ok(prod({ ...SMTP, SMTP_FROM: '' }).some((p) => /SMTP_FROM/.test(p)));
  assert.ok(prod({ ...SMTP, SMTP_PASS: '' }).some((p) => /SMTP_USER and SMTP_PASS/.test(p)));
  assert.ok(prod({ ...SMTP, SMTP_PORT: 'abc' }).some((p) => /SMTP_PORT/.test(p)));
  assert.ok(prod({ ...SMTP, DEV_OTP_CONSOLE: 'reveal' }).some((p) => /DEV_OTP_CONSOLE/.test(p)));
  assert.ok(prod({ ...SMTP, DEV_EXPOSE_ACCOUNT_SETUP_TOKEN: 'true' }).some((p) => /DEV_EXPOSE_ACCOUNT_SETUP_TOKEN/.test(p)));
  assert.ok(prod({}).length > 0, 'unset provider means smtp in production, which then needs SMTP_*');
  for (const p of prod({ ...SMTP, SMTP_FROM: '' })) assert.equal(p.includes('s3cret-pass'), false, 'never a value');
  assert.ok(otp.otpDeliveryProblems({ NODE_ENV: 'development', OTP_DELIVERY_PROVIDER: 'console' }).length > 0, 'console needs the flag');
  assert.deepEqual(otp.otpDeliveryProblems({ NODE_ENV: 'development', DEV_OTP_CONSOLE: 'masked' }), []);
  assert.ok(otp.otpDeliveryProblems({ NODE_ENV: 'development' }).some((p) => /No code delivery configured/.test(p)));
  assert.deepEqual(otp.otpDeliveryStatus({ NODE_ENV: 'development' }), { provider: 'none', configured: false });
  assert.throws(() => otp.assertOtpDeliveryConfig({ NODE_ENV: 'production', OTP_DELIVERY_PROVIDER: 'console' }), /OTP_DELIVERY_PROVIDER/);
  assert.equal(otp.devSecretsExposed({ NODE_ENV: 'production', DEV_EXPOSE_ACCOUNT_SETUP_TOKEN: 'true' }), false);
  assert.equal(otp.devSecretsExposed({ NODE_ENV: 'development', DEV_EXPOSE_ACCOUNT_SETUP_TOKEN: 'true' }), true);
  assert.equal(otp.resolveDeliveryConfig({ NODE_ENV: 'production', DEV_OTP_CONSOLE: 'reveal' }).consoleMode, null, 'the flag is ignored in production');
});

async function captureConsole(fn) {
  const out = []; const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { out.push(a.map(String).join(' ')); };
  try { return { result: await fn().catch((e) => e), out: out.join('\n') }; } finally { Object.assign(console, orig); }
}
test('deliverCode: console masks unless reveal; SMTP failures throw a code-free OtpDeliveryError; nothing configured is not_configured', async () => {
  const dest = 'kartik.example@geu.ac.in';
  let c = await captureConsole(() => otp.deliverCode(dest, '123456', 'login', { NODE_ENV: 'development', DEV_OTP_CONSOLE: 'masked' }));
  assert.match(c.out, /code=12\*\*\*\*/); assert.equal(c.out.includes('123456'), false); assert.equal(c.out.includes(dest), false);
  assert.match(c.out, /to=k\*\*\*@geu\.ac\.in/);
  c = await captureConsole(() => otp.deliverCode(dest, '123456', 'login', { NODE_ENV: 'development', DEV_OTP_CONSOLE: 'reveal' }));
  assert.match(c.out, /code=123456/);
  const token = 'ab'.repeat(32);
  c = await captureConsole(() => otp.deliverCode(dest, token, 'account_setup', { NODE_ENV: 'development', DEV_OTP_CONSOLE: 'masked' }));
  assert.match(c.out, /code=abab…/); assert.equal(c.out.includes(token), false);
  c = await captureConsole(() => otp.deliverCode(dest, '123456', 'login', { NODE_ENV: 'production', DEV_OTP_CONSOLE: 'reveal', OTP_DELIVERY_PROVIDER: 'console' }));
  assert.ok(c.result instanceof otp.OtpDeliveryError && c.result.kind === 'not_configured', 'console is refused in production');
  assert.equal(c.out.includes('123456'), false);
  otp.setTransportForTests({ sendMail: async () => { throw Object.assign(new Error(`550 rejected ${dest} 123456`), { responseCode: 550 }); } });
  try {
    c = await captureConsole(() => otp.deliverCode(dest, '123456', 'login', { NODE_ENV: 'test', ...SMTP }));
    assert.ok(c.result instanceof otp.OtpDeliveryError); assert.equal(c.result.kind, 'send_failed');
    assert.equal(`${c.result.message}${c.out}`.includes('123456'), false); assert.equal(`${c.result.message}${c.out}`.includes(dest), false);
    assert.match(c.out, /err=550/);
    assert.equal(await otp.deliverNotice(dest, 'password_changed', { NODE_ENV: 'test', ...SMTP }), false, 'a notice never throws');
    const sent = [];
    otp.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
    await otp.deliverCode(dest, token, 'account_setup', { NODE_ENV: 'test', ...SMTP, ACCOUNT_INVITE_TTL_HOURS: '48', PORTAL_URL: 'https://exam.geu.ac.in' });
    assert.match(sent[0].text, new RegExp(token)); assert.match(sent[0].text, /48 hours/); assert.match(sent[0].text, /https:\/\/exam\.geu\.ac\.in/);
  } finally { otp.setTransportForTests(null); }
  c = await captureConsole(() => otp.deliverCode(dest, '123456', 'login', { NODE_ENV: 'development' }));
  assert.equal(c.result.kind, 'not_configured');
});

test('safeEqualHex, TOTP delta and session lifetime', async () => {
  assert.equal(auth.safeEqualHex('ab'.repeat(32), 'ab'.repeat(32)), true);
  assert.equal(auth.safeEqualHex('ab'.repeat(32), 'ac'.repeat(32)), false);
  assert.equal(auth.safeEqualHex('abab', 'ab'), false); assert.equal(auth.safeEqualHex(null, 'ab'), false); assert.equal(auth.safeEqualHex('zz', 'zz'), false);
  assert.equal(auth.sessionLifetimeSeconds({}), 28800);
  const now = Date.now();
  assert.ok(Math.abs(auth.sessionLifetimeSeconds({ access_deadline: new Date(now + 3600000).toISOString() }, now) - 3600) <= 1);
  assert.equal(auth.sessionLifetimeSeconds({ access_deadline: new Date(now + 30 * 3600000).toISOString() }, now), 28800);
  assert.equal(auth.sessionLifetimeSeconds({ access_deadline: new Date(now - 1000).toISOString() }, now), 0);
  assert.equal(auth.issueSession({ id: 'u', role: 'teacher', token_version: 0, access_deadline: new Date(now - 1000).toISOString() }), null);
  const secret = auth.generateTotpSecret();
  assert.equal(auth.totpDelta(secret, '12345'), null); assert.equal(auth.totpDelta(secret, 123456), null);
  const { authenticator } = await import('otplib');
  assert.equal(auth.totpDelta(secret, authenticator.generate(secret)), 0, 'a current code is step offset 0');
  assert.equal(authenticator.options.window, undefined, 'the global authenticator options are never mutated');
  assert.equal(auth.currentTotpStep(90000), 3);
  assert.equal(typeof auth.generateTempPassword, 'undefined', 'temporary passwords are gone');
});

test('every password or code path has the strict per-IP limiter', () => {
  for (const p of ['/api/auth/login', '/api/auth/password-reset', '/api/auth/totp', '/api/auth/change-password', '/api/coe/papers/:paperId/coe-approve']) {
    assert.ok(AUTH_LIMITED_PATHS.includes(p), p);
  }
});
