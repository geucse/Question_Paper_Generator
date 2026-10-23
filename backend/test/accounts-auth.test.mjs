// Phase 3, accounts and authentication: login hardening, OTP, sessions, password reset, TOTP enrolment, account
// provisioning (all roles, scopes, out-of-band invitation), deactivation, reactivation and role change.
// Implementation prompt §2 (security), §5 criterion 6; PIVOT_SPEC_V2 §2, §4, §5, §35, §37.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { authenticator } from 'otplib';
import { sql, log, baseRules, start, call, tokenFor, USERS, IDS, installWorld, mail, mailControl } from './harness.mjs';
import { hashPassword, hashCode, signJwt } from '../src/auth.js';
import { sealSecret } from '../src/secret-box.js';

const PW = 'Correct#Pass1';
let HASH;
const OTP_ID = '0c000000-0000-0000-0000-000000000001';
const NEW_ID = '0e000000-0000-0000-0000-000000000001';
const ADMIN2 = { ...USERS.admin, id: 'ad000002-0000-0000-0000-000000000000', email: 'admin2@t.edu' };

before(async () => { HASH = await hashPassword(PW); await start(); });
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => {
  baseRules();
  for (const u of Object.values(USERS)) Object.assign(u, { password_hash: HASH, failed_login_attempts: 0, locked_until: null, is_active: true, must_change_password: false, access_deadline: null, token_version: 0, totp_enabled: false });
  USERS.admin2 = ADMIN2;
  sql(/FROM users WHERE lower\(email\) = \$1/i, (p) => Object.values(USERS).filter((u) => u.email.toLowerCase() === p[0]));
  scriptPasswordBudget();
});

// Stateful emulation of the per-account password budget (src/password-attempts.js) on the USERS rows: the
// conditional reservation, and the reset that clears only a lock the attempt's own reservation set.
const reservations = [];
function scriptPasswordBudget() {
  reservations.length = 0;
  sql(/^UPDATE users SET failed_login_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= now\(\) THEN 1/i, (p) => {
    const u = Object.values(USERS).find((x) => x.id === p[0]);
    const now = Date.now();
    if (!u || (u.locked_until && new Date(u.locked_until).getTime() > now)) { reservations.push(null); return []; }
    const expired = !!u.locked_until;
    const attempt = expired ? 1 : (u.failed_login_attempts || 0) + 1;
    u.failed_login_attempts = attempt;
    u.locked_until = attempt >= p[1] ? new Date(now + p[2] * 60000).toISOString() : expired ? null : u.locked_until;
    reservations.push(attempt);
    return [{ attempt, locks: !!u.locked_until }];
  });
  sql(/^UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = \$1 AND \(locked_until IS NULL OR failed_login_attempts = \$2\) RETURNING id/i, (p) => {
    const u = Object.values(USERS).find((x) => x.id === p[0]);
    if (!u || !(u.locked_until == null || u.failed_login_attempts === p[1])) return [];
    Object.assign(u, { failed_login_attempts: 0, locked_until: null });
    return [{ id: u.id }];
  });
}

const audits = () => log.filter((l) => /INSERT INTO audit_log/.test(l.text)).map((l) => l.params[2]);
const auditDetails = (action) => JSON.parse(log.filter((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === action).pop().params[4]);
const has = (re) => log.some((l) => re.test(l.text));
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
async function captureConsole(fn) {
  const out = []; const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { out.push(a.map(String).join(' ')); };
  try { return { result: await fn(), out: out.join('\n') }; } finally { Object.assign(console, orig); }
}
function scriptLoginOk({ recent = 0 } = {}) {
  sql(/FROM otp_codes WHERE user_id = \$1 AND purpose = 'login' AND created_at/i, [{ n: recent }]);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE user_id = \$1 AND purpose = 'login'/i, []);
  sql(/^INSERT INTO otp_codes .*'login'/i, [{ id: OTP_ID }]);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE id = \$1$/i, []);
}

// ---------------------------------------------------------------- login
test('login: unknown email, wrong password and a locked account answer with byte-identical bodies; the lock is never a password oracle', async () => {
  const unknown = await call('POST', '/auth/login/password', { email: 'nobody@t.edu', password: PW });
  const wrong = await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: 'wrong-password' });
  assert.equal(unknown.status, 401); assert.equal(wrong.status, 401);
  assert.equal(JSON.stringify(unknown.data), JSON.stringify(wrong.data));
  assert.match(unknown.data.error, /After 5 failed attempts sign-in is paused for 15 minutes/);
  log.length = 0;
  USERS.teacher.locked_until = new Date(Date.now() + 600000).toISOString();
  const locked = await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW });
  assert.equal(locked.status, 401, 'locked + correct password'); assert.equal(JSON.stringify(locked.data), JSON.stringify(wrong.data));
  assert.equal(has(/INSERT INTO otp_codes/), false);
  const reserve = log.find((l) => /^UPDATE users SET failed_login_attempts = CASE/.test(l.text));
  assert.match(reserve.text, /WHERE id = \$1 AND \(locked_until IS NULL OR locked_until <= now\(\)\)/, 'the reservation itself refuses a locked account');
  assert.equal(has(/^UPDATE users SET failed_login_attempts = 0/), false, 'a correct password never clears a lock it did not set');
  assert.ok(audits().includes('login_refused_locked'));
});

test('login: inactive account says so only after the correct password; email is case-insensitive', async () => {
  USERS.teacher.is_active = false;
  const wrong = await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: 'nope-nope-1A' });
  assert.equal(wrong.status, 401); assert.doesNotMatch(wrong.data.error, /inactive/);
  const right = await call('POST', '/auth/login/password', { email: `  ${USERS.teacher.email.toUpperCase()} `, password: PW });
  assert.equal(right.status, 403); assert.match(right.data.error, /inactive/);
  assert.equal(log.filter((l) => /FROM users WHERE lower\(email\)/.test(l.text)).pop().params[0], USERS.teacher.email);
  assert.equal(has(/INSERT INTO otp_codes/), false);
});

test('login: the attempt is reserved before the password is checked; the 5th failure locks in that same statement, audited', async () => {
  for (let i = 1; i <= 5; i++) {
    const r = await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: 'wrong-password' });
    assert.equal(r.status, 401);
  }
  const upd = log.find((l) => /failed_login_attempts = CASE/.test(l.text));
  assert.deepEqual(upd.params, [USERS.teacher.id, 5, 15]);
  assert.equal(audits().filter((a) => a === 'login_failed_password').length, 5);
  assert.equal(audits().filter((a) => a === 'account_locked').length, 1); assert.ok(USERS.teacher.locked_until);
  assert.ok(has(/INSERT INTO suspicious_activity/));
  scriptLoginOk();
  const right = await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW });
  assert.equal(right.status, 401, 'the right password is refused while locked'); assert.equal(has(/INSERT INTO otp_codes/), false);
  // A lock that has expired starts a fresh budget, and the right password then works.
  USERS.teacher.locked_until = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW })).status, 200);
  assert.equal(USERS.teacher.failed_login_attempts, 0); assert.equal(USERS.teacher.locked_until, null);
});

test('login: concurrent guesses from many requests evaluate at most 5 passwords; a correct guess racing them cannot clear the lock', async () => {
  scriptLoginOk();
  const guesses = Array.from({ length: 30 }, (_, i) => call('POST', '/auth/login/password', { email: USERS.teacher.email, password: `wrong-${i}` }));
  const results = await Promise.all([...guesses, call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW })]);
  assert.ok(results.slice(0, 30).every((r) => r.status === 401));
  assert.equal(reservations.filter((r) => r !== null).length, 5, 'only 5 attempts won a reservation');
  assert.ok(audits().filter((a) => a === 'login_failed_password').length <= 5, 'at most 5 passwords evaluated');
  assert.ok(USERS.teacher.locked_until, 'still locked afterwards');
  const correct = results[30];
  if (correct.status === 200) {
    // It reserved inside the budget (one of the 5) before the lock: then it consumed one evaluation, nothing more.
    assert.ok(audits().filter((a) => a === 'login_failed_password').length <= 4);
  } else {
    assert.equal(correct.status, 401); assert.equal(has(/INSERT INTO otp_codes/), false);
  }
  // A 5th reservation that is the right password clears only the lock it set itself.
  Object.assign(USERS.teacher, { failed_login_attempts: 4, locked_until: null });
  assert.equal((await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW })).status, 200);
  assert.equal(USERS.teacher.locked_until, null);
});

test('login: the code is emailed, never returned or logged; a newer code replaces older ones', async () => {
  scriptLoginOk();
  const { result: r, out } = await captureConsole(() => call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW }));
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.otp_pending_for, USERS.teacher.id);
  assert.equal(mail.length, 1); assert.equal(mail[0].to, USERS.teacher.email);
  const code = /\b(\d{6})\b/.exec(mail[0].text)[1];
  assert.equal(JSON.stringify(r.data).includes(code), false, 'not in the response');
  assert.equal(out.includes(code), false, 'not in any log line');
  const ins = log.find((l) => /^INSERT INTO otp_codes/.test(l.text));
  assert.equal(ins.params[1], hashCode(code), 'stored hashed');
  assert.ok(log.findIndex((l) => /purpose = 'login' AND used = FALSE/.test(l.text) && /^UPDATE/.test(l.text)) < log.indexOf(ins), 'older codes burned first');
});

test('login: delivery failure answers 503, burns the code and is audited; a 6th code within 15 minutes is refused', async () => {
  scriptLoginOk();
  mailControl.fail = true;
  const { result: r, out } = await captureConsole(() => call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW }));
  assert.equal(r.status, 503); assert.match(r.data.error, /could not send/);
  assert.deepEqual(log.find((l) => /^UPDATE otp_codes SET used = TRUE WHERE id = \$1$/.test(l.text)).params, [OTP_ID]);
  assert.deepEqual(auditDetails('otp_delivery_failed'), { purpose: 'login', kind: 'send_failed' });
  assert.equal(out.includes(USERS.teacher.email), false, 'the address is masked in the failure log');
  mailControl.fail = false;
  baseRules(); USERS.admin2 = ADMIN2; scriptPasswordBudget();
  sql(/FROM users WHERE lower\(email\) = \$1/i, (p) => Object.values(USERS).filter((u) => u.email === p[0]));
  scriptLoginOk({ recent: 5 });
  const capped = await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW });
  assert.equal(capped.status, 429); assert.equal(has(/INSERT INTO otp_codes/), false); assert.equal(mail.length, 0);
});

// ---------------------------------------------------------------- OTP
test('OTP: malformed input never reaches SQL; wrong, exhausted, replayed and inactive cases all 401', async () => {
  log.length = 0;
  assert.equal((await call('POST', '/auth/login/otp', { userId: 'not-a-uuid', code: '123456' })).status, 401);
  assert.equal((await call('POST', '/auth/login/otp', { userId: USERS.teacher.id, code: '12345' })).status, 401);
  assert.equal((await call('POST', '/auth/login/otp', { userId: USERS.teacher.id, code: { $ne: 1 } })).status, 401);
  assert.deepEqual(log.filter((l) => !/FROM blocked_ips/.test(l.text)), [], 'no SQL for malformed input (beyond the IP blocklist)');

  let rec = [{ id: OTP_ID, code_hash: hashCode('123456'), attempts: 1 }];
  sql(/^UPDATE otp_codes SET attempts = attempts \+ 1/i, () => rec);
  let consumed = [{ id: OTP_ID }];
  sql(/^UPDATE otp_codes SET used = TRUE WHERE id = \$1 AND used = FALSE/i, () => consumed);
  const wrong = await call('POST', '/auth/login/otp', { userId: USERS.teacher.id, code: '654321' });
  assert.equal(wrong.status, 401); assert.match(wrong.data.error, /2 attempt/);
  const inc = log.find((l) => /attempts = attempts \+ 1/.test(l.text));
  assert.match(inc.text, /AND attempts < \$2 AND expires_at > now\(\)/, 'counted atomically before comparing');
  assert.ok(audits().includes('otp_failed')); assert.ok(has(/INSERT INTO suspicious_activity/));
  rec = [];
  assert.equal((await call('POST', '/auth/login/otp', { userId: USERS.teacher.id, code: '123456' })).status, 401, 'exhausted or expired');
  rec = [{ id: OTP_ID, code_hash: hashCode('123456'), attempts: 1 }]; consumed = [];
  assert.equal((await call('POST', '/auth/login/otp', { userId: USERS.teacher.id, code: '123456' })).status, 401, 'consumed concurrently');
  consumed = [{ id: OTP_ID }]; USERS.teacher.is_active = false;
  assert.equal((await call('POST', '/auth/login/otp', { userId: USERS.teacher.id, code: '123456' })).status, 401, 'inactive account');
});

test('OTP: the session never outlives access_deadline; a passed deadline gets no session', async () => {
  sql(/^UPDATE otp_codes SET attempts = attempts \+ 1/i, [{ id: OTP_ID, code_hash: hashCode('123456'), attempts: 1 }]);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE id = \$1 AND used = FALSE/i, [{ id: OTP_ID }]);
  const deadline = Date.now() + 3600000;
  USERS.teacher.access_deadline = new Date(deadline).toISOString();
  const r = await call('POST', '/auth/login/otp', { userId: USERS.teacher.id, code: '123456' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { exp } = decode(r.data.token);
  assert.ok(exp * 1000 <= deadline && exp * 1000 >= deadline - 5000, `${exp * 1000} vs ${deadline}`);
  assert.equal(r.data.user.password_hash, undefined, 'public fields only');
  USERS.coe.access_deadline = new Date(Date.now() + 1800000).toISOString(); // any role with a deadline
  const c = await call('POST', '/auth/login/otp', { userId: USERS.coe.id, code: '123456' });
  assert.ok(decode(c.data.token).exp * 1000 <= Date.now() + 1800000);
  USERS.teacher.access_deadline = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call('POST', '/auth/login/otp', { userId: USERS.teacher.id, code: '123456' })).status, 403);
});

// ---------------------------------------------------------------- sessions
test('session: forced password change still allows sign-out and /me; stale token_version is refused; deadline applies to every role', async () => {
  USERS.teacher.must_change_password = true;
  sql(/^UPDATE users SET token_version = token_version \+ 1 WHERE id = \$1$/i, []);
  assert.equal((await call('GET', '/auth/me', null, 'teacher')).status, 200);
  assert.equal((await call('POST', '/auth/logout', null, 'teacher')).status, 200);
  assert.ok(has(/^UPDATE users SET token_version = token_version \+ 1/));
  const blocked = await call('GET', '/notifications', null, 'teacher');
  assert.equal(blocked.status, 403); assert.equal(blocked.data.must_change_password, true);
  USERS.teacher.must_change_password = false;
  USERS.teacher.token_version = 1;
  const stale = await call('GET', '/auth/me', null, 'teacher');
  assert.equal(stale.status, 401); assert.equal(stale.data.session_invalid, true);
  USERS.teacher.token_version = 0;
  USERS.hod.access_deadline = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call('GET', '/auth/me', null, 'hod')).status, 403, 'deadline is not teacher-only');
});

test('change-password: the new token is capped by the deadline; a security notice goes out; a wrong password is flagged', async () => {
  sql(/^UPDATE users SET password_hash = \$1, must_change_password = FALSE, token_version = \$2/i, []);
  const deadline = Date.now() + 1200000;
  USERS.teacher.access_deadline = new Date(deadline).toISOString();
  const bad = await call('POST', '/auth/change-password', { current_password: 'wrong', new_password: 'Another#Pass2' }, 'teacher');
  assert.equal(bad.status, 401); assert.ok(has(/INSERT INTO suspicious_activity/));
  assert.ok(has(/^UPDATE users SET failed_login_attempts = CASE/), 'counted against the account, not only the address');
  const r = await call('POST', '/auth/change-password', { current_password: PW, new_password: 'Another#Pass2' }, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(decode(r.data.token).exp * 1000 <= deadline); assert.equal(decode(r.data.token).tv, 1);
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[1] === 'security_password_changed'));
  assert.equal(mail.length, 1); assert.match(mail[0].subject, /password was changed/); assert.equal(mail[0].text.includes('Another#Pass2'), false);
});

test('change-password with a stolen session: 5 wrong current passwords lock the account, end every session and notify; then even the right one fails', async () => {
  sql(/^UPDATE users SET token_version = token_version \+ 1 WHERE id = \$1$/i, []);
  sql(/^UPDATE users SET password_hash = \$1, must_change_password = FALSE, token_version = \$2/i, []);
  for (let i = 1; i <= 4; i++) {
    const r = await call('POST', '/auth/change-password', { current_password: `guess-${i}`, new_password: 'Another#Pass2' }, 'teacher');
    assert.equal(r.status, 401); assert.match(r.data.error, /Current password is incorrect/); assert.equal(r.data.session_invalid, undefined);
  }
  assert.equal(has(/^UPDATE users SET token_version = token_version \+ 1/), false);
  const fifth = await call('POST', '/auth/change-password', { current_password: 'guess-5', new_password: 'Another#Pass2' }, 'teacher');
  assert.equal(fifth.status, 401); assert.equal(fifth.data.session_invalid, true, 'the frontend drops the session');
  assert.ok(log.some((l) => /^UPDATE users SET token_version = token_version \+ 1 WHERE id = \$1$/.test(l.text) && l.params[0] === USERS.teacher.id), 'every session ends');
  assert.ok(audits().includes('account_locked_sessions_revoked'));
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[1] === 'security_account_locked'));
  assert.ok(mail.some((m) => /account was locked/.test(m.subject)));
  const right = await call('POST', '/auth/change-password', { current_password: PW, new_password: 'Another#Pass2' }, 'teacher');
  assert.equal(right.status, 429, 'locked: the right password does not work either');
  assert.equal(has(/^UPDATE users SET password_hash/), false, 'the password never changed');
  // Login is locked too (one budget for every password check of the account).
  scriptLoginOk();
  assert.equal((await call('POST', '/auth/login/password', { email: USERS.teacher.email, password: PW })).status, 401);
});

// ---------------------------------------------------------------- password reset / account setup
function scriptReset({ recent = 0 } = {}) {
  sql(/FROM otp_codes WHERE user_id = \$1 AND purpose = 'password_reset' AND created_at/i, [{ n: recent }]);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE user_id = \$1 AND purpose = 'password_reset'/i, []);
  sql(/^INSERT INTO otp_codes .*'password_reset'/i, [{ id: OTP_ID }]);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE id = \$1$/i, []);
}
test('reset request: identical answer for unknown, inactive, throttled and active accounts; only the active one gets mail', async () => {
  scriptReset();
  USERS.reviewer.is_active = false;
  const bodies = [];
  for (const email of ['nobody@t.edu', USERS.reviewer.email]) bodies.push(JSON.stringify((await call('POST', '/auth/password-reset/request', { email })).data));
  await wait(); assert.equal(mail.length, 0);
  const ok = await call('POST', '/auth/password-reset/request', { email: USERS.teacher.email.toUpperCase() });
  bodies.push(JSON.stringify(ok.data));
  await wait();
  assert.equal(mail.length, 1); assert.match(mail[0].text, /\b[0-9a-f]{64}\b/); assert.equal(JSON.stringify(ok.data).includes(mail[0].text.match(/[0-9a-f]{64}/)[0]), false);
  scriptReset({ recent: 3 }); mail.length = 0;
  bodies.push(JSON.stringify((await call('POST', '/auth/password-reset/request', { email: USERS.teacher.email })).data));
  await wait(); assert.equal(mail.length, 0, 'throttled: no mail'); assert.ok(audits().includes('password_reset_throttled'));
  scriptReset(); mailControl.fail = true; log.length = 0;
  bodies.push(JSON.stringify((await call('POST', '/auth/password-reset/request', { email: USERS.teacher.email })).data));
  await wait();
  assert.ok(log.some((l) => /^UPDATE otp_codes SET used = TRUE WHERE id = \$1$/.test(l.text) && l.params[0] === OTP_ID), 'undelivered code burned');
  assert.ok(audits().includes('otp_delivery_failed'));
  assert.equal(new Set(bodies).size, 1, 'every answer is the same');
});

test('reset confirm: malformed, unknown, inactive, expired, exhausted, weak; success ends sessions and clears the forced change', async () => {
  const token = 'ab'.repeat(32);
  let rec = { id: OTP_ID, user_id: USERS.teacher.id, purpose: 'password_reset', attempts: 0, expires_at: new Date(Date.now() + 600000).toISOString() };
  sql(/FROM otp_codes WHERE purpose IN \('password_reset', 'account_setup'\) AND used = FALSE AND code_hash = \$1/i, (p) => (p[0] === hashCode(token) ? [rec] : []));
  sql(/^UPDATE otp_codes SET attempts = attempts \+ 1 WHERE id = \$1/i, []);
  let consumed = [{ id: OTP_ID }];
  sql(/^UPDATE otp_codes SET used = TRUE WHERE id = \$1 AND used = FALSE/i, () => consumed);
  sql(/^UPDATE users SET password_hash = \$1, failed_login_attempts = 0/i, []);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE user_id = \$1 AND purpose IN/i, []);
  const confirm = (body) => call('POST', '/auth/password-reset/confirm', body);
  const bad = await confirm({ token: 'xyz', new_password: 'Good#Pass123' });
  assert.equal(bad.status, 400); assert.ok(log.some((l) => /INSERT INTO suspicious_activity/.test(l.text) && l.params[1] === 'invalid_reset_token'));
  assert.equal((await confirm({ token: 'cd'.repeat(32), new_password: 'Good#Pass123' })).status, 400, 'unknown');
  USERS.teacher.is_active = false;
  assert.equal((await confirm({ token, new_password: 'Good#Pass123' })).status, 400, 'inactive account');
  USERS.teacher.is_active = true;
  rec = { ...rec, expires_at: new Date(Date.now() - 1000).toISOString() };
  assert.equal((await confirm({ token, new_password: 'Good#Pass123' })).status, 400, 'expired');
  rec = { ...rec, expires_at: new Date(Date.now() + 600000).toISOString(), attempts: 5 };
  assert.equal((await confirm({ token, new_password: 'Good#Pass123' })).status, 429);
  rec = { ...rec, attempts: 0 }; log.length = 0;
  assert.equal((await confirm({ token, new_password: 'weak' })).status, 400);
  assert.ok(has(/^UPDATE otp_codes SET attempts = attempts \+ 1 WHERE id = \$1/), 'a weak password spends an attempt');
  consumed = [];
  assert.equal((await confirm({ token, new_password: 'Good#Pass123' })).status, 400, 'consumed concurrently');
  consumed = [{ id: OTP_ID }]; log.length = 0; mail.length = 0;
  const ok = await confirm({ token: token.toUpperCase(), new_password: 'Good#Pass123' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(log.find((l) => /^UPDATE users SET password_hash/.test(l.text)).text, /must_change_password = FALSE, token_version = token_version \+ 1/);
  assert.ok(has(/purpose IN \('password_reset', 'account_setup'\) AND used = FALSE/), 'other pending codes burned');
  assert.ok(audits().includes('password_reset_completed')); assert.equal(mail.length, 1, 'security notice');
  rec = { ...rec, purpose: 'account_setup' }; log.length = 0; mail.length = 0;
  assert.equal((await confirm({ token, new_password: 'Good#Pass123' })).status, 200);
  assert.ok(audits().includes('account_setup_completed')); assert.equal(mail.length, 0);
});

// ---------------------------------------------------------------- TOTP enrolment
test('TOTP setup: re-authentication required; the new secret is only pending (sealed) and the active one is untouched', async () => {
  const none = await call('POST', '/auth/totp/setup', {}, 'coe');
  assert.equal(none.status, 401);
  assert.equal((await call('POST', '/auth/totp/setup', { current_password: 'wrong' }, 'coe')).status, 401);
  assert.ok(audits().includes('totp_setup_reauth_failed'));
  assert.ok(has(/^UPDATE users SET failed_login_attempts = CASE/), 'the password check spends the account budget');
  sql(/^UPDATE users SET totp_pending_secret = \$2/i, []);
  log.length = 0;
  const res = await fetch(`http://localhost:${process.env.PORT}/api/auth/totp/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor('coe')}` }, body: JSON.stringify({ current_password: PW }) });
  const r = await res.json();
  assert.equal(res.status, 200); assert.match(res.headers.get('cache-control'), /no-store/);
  const upd = log.find((l) => /^UPDATE users SET totp_pending_secret/.test(l.text));
  assert.match(upd.params[1], /^v1\./); assert.equal(upd.params[1].includes(r.secret), false);
  assert.equal(log.some((l) => /totp_secret\s*=|totp_enabled\s*=/.test(l.text)), false, 'active factor untouched');
  assert.deepEqual(auditDetails('totp_setup_initiated'), { reenroll: false, reauth: 'password' });
});

test('TOTP: an enabled authenticator is never replaced with the password alone; after an admin reset (or a re-enrol flag) the password is enough', async () => {
  const ACTIVE = authenticator.generateSecret();
  USERS.coe.totp_enabled = true; USERS.coe.totp_reenroll_required = false;
  sql(/SELECT totp_secret, totp_enabled FROM users/i, [{ totp_secret: sealSecret(ACTIVE, `totp:${USERS.coe.id}`), totp_enabled: true }]);
  sql(/^UPDATE users SET totp_pending_secret = \$2/i, []);
  log.length = 0;
  const pwOnly = await call('POST', '/auth/totp/setup', { current_password: PW }, 'coe');
  assert.equal(pwOnly.status, 401); assert.equal(pwOnly.data.needs_current_totp, true); assert.match(pwOnly.data.error, /administrator to reset/);
  assert.equal(has(/^UPDATE users SET totp_pending_secret/), false, 'nothing enrolled');
  assert.deepEqual(auditDetails('totp_setup_reauth_failed'), { reenroll: true, reason: 'current_code_missing' });
  assert.equal((await call('POST', '/auth/totp/setup', { current_password: PW, current_totp: '000000' }, 'coe')).status, 401, 'a wrong code fails even with the right password');
  assert.equal(has(/^UPDATE users SET totp_pending_secret/), false);
  assert.equal((await call('POST', '/auth/totp/setup', { current_totp: authenticator.generate(ACTIVE) }, 'coe')).status, 200, 'a current code works');
  // Flagged for re-enrolment (040 upgrade, unreadable secret, key rotation, admin reset): the password suffices.
  USERS.coe.totp_reenroll_required = true; log.length = 0;
  assert.equal((await call('POST', '/auth/totp/setup', { current_password: PW }, 'coe')).status, 200);
  assert.deepEqual(auditDetails('totp_setup_initiated'), { reenroll: true, reauth: 'password' });
  USERS.coe.totp_enabled = false; USERS.coe.totp_reenroll_required = false;
});

test('TOTP setup with a stolen session: 5 wrong passwords lock the account and end every session', async () => {
  sql(/^UPDATE users SET token_version = token_version \+ 1 WHERE id = \$1$/i, []);
  for (let i = 1; i <= 4; i++) assert.equal((await call('POST', '/auth/totp/setup', { current_password: `guess-${i}` }, 'reviewer')).status, 401);
  const fifth = await call('POST', '/auth/totp/setup', { current_password: 'guess-5' }, 'reviewer');
  assert.equal(fifth.status, 401); assert.equal(fifth.data.session_invalid, true);
  assert.ok(audits().includes('account_locked_sessions_revoked'));
  assert.equal((await call('POST', '/auth/totp/setup', { current_password: PW }, 'reviewer')).status, 429, 'locked');
});

test('admin resets an authenticator: reason required, sessions end, re-enrolment flag set, owner notified, audited; never their own; HOD cannot', async () => {
  USERS.coe.totp_enabled = true;
  const url = `/academic/users/${USERS.coe.id}/reset-authenticator`;
  sql(/^UPDATE users SET totp_secret = NULL, totp_enabled = FALSE/i, [{ id: USERS.coe.id }]);
  assert.equal((await call('POST', url, { reason: 'lost' }, 'admin')).status, 400, 'reason too short');
  assert.equal((await call('POST', url, { reason: 'Phone lost, verified in person' }, 'hod')).status, 403, 'HOD cannot');
  assert.equal((await call('POST', `/academic/users/${USERS.admin.id}/reset-authenticator`, { reason: 'Phone lost, verified in person' }, 'admin')).status, 400, 'not your own');
  log.length = 0; mail.length = 0;
  const r = await call('POST', url, { reason: 'Phone lost, verified in person' }, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.notice_sent, true);
  const upd = log.find((l) => /^UPDATE users SET totp_secret = NULL/.test(l.text));
  assert.match(upd.text, /totp_reenroll_required = TRUE, token_version = token_version \+ 1/);
  assert.deepEqual(auditDetails('totp_reset_by_admin'), { reason: 'Phone lost, verified in person', role: 'coe' });
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.coe.id && l.params[1] === 'security_totp_reset'));
  assert.equal(mail.length, 1); assert.match(mail[0].subject, /authenticator was reset/);
  USERS.coe.totp_enabled = false;
  assert.equal((await call('POST', url, { reason: 'Phone lost, verified in person' }, 'admin')).status, 409, 'nothing to reset');
});

test('TOTP re-enrolment: a current code also works (once); confirm swaps atomically, logs, notifies, emails no secret', async () => {
  const ACTIVE = authenticator.generateSecret(); const NEXT = authenticator.generateSecret();
  USERS.coe.totp_enabled = true;
  sql(/SELECT totp_secret, totp_enabled FROM users/i, [{ totp_secret: sealSecret(ACTIVE, `totp:${USERS.coe.id}`), totp_enabled: true }]);
  sql(/^UPDATE users SET totp_pending_secret = \$2/i, []);
  assert.equal((await call('POST', '/auth/totp/setup', { current_totp: authenticator.generate(ACTIVE) }, 'coe')).status, 200);
  sql(/^UPDATE users SET totp_last_used_step/i, []);
  const replay = await call('POST', '/auth/totp/setup', { current_totp: authenticator.generate(ACTIVE) }, 'coe');
  assert.equal(replay.status, 401, 'a used code is refused');
  assert.equal((await call('POST', '/auth/totp/setup', { current_totp: '000000' }, 'coe')).status, 401);

  let pending = { totp_pending_secret: sealSecret(NEXT, `totp:${USERS.coe.id}`), totp_enabled: true, pending_valid: true };
  sql(/SELECT totp_pending_secret, totp_enabled/i, () => [pending]);
  sql(/^UPDATE users SET totp_secret = totp_pending_secret/i, [{ id: USERS.coe.id }]);
  assert.equal((await call('POST', '/auth/totp/confirm', { code: authenticator.generate(ACTIVE) }, 'coe')).status, 401, 'a code of the old secret does not confirm');
  log.length = 0; mail.length = 0;
  const ok = await call('POST', '/auth/totp/confirm', { code: authenticator.generate(NEXT) }, 'coe');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const swap = log.find((l) => /^UPDATE users SET totp_secret = totp_pending_secret/.test(l.text));
  assert.match(swap.text, /totp_pending_secret IS NOT NULL/); assert.ok(Number.isInteger(swap.params[1]), 'step recorded');
  assert.ok(log.some((l) => /INSERT INTO step_up_auth_log/.test(l.text) && l.params[1] === 'totp_enrol_confirm' && l.params[3] === true));
  assert.ok(audits().includes('totp_reenrolled'));
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[1] === 'security_totp_changed'));
  assert.equal(mail.length, 1); assert.equal(mail[0].text.includes(NEXT), false);
  pending = { ...pending, pending_valid: false };
  assert.equal((await call('POST', '/auth/totp/confirm', { code: authenticator.generate(NEXT) }, 'coe')).status, 400, 'expired setup');
});

// ---------------------------------------------------------------- provisioning
function scriptProvisioning() {
  sql(/FROM campuses WHERE id = \$1 AND is_active/i, (p) => ({ [IDS.campusA]: [{ id: IDS.campusA, institution_id: 'i0000000-0000-0000-0000-000000000001' }], [IDS.campusB]: [{ id: IDS.campusB, institution_id: 'i0000000-0000-0000-0000-000000000001' }] }[p[0]] || []));
  sql(/FROM departments WHERE id = \$1 AND is_active/i, (p) => ({ [IDS.dept]: [{ id: IDS.dept, campus_id: IDS.campusA }], [IDS.deptB]: [{ id: IDS.deptB, campus_id: IDS.campusB }] }[p[0]] || []));
  sql(/FROM programs WHERE id = \$1 AND is_active/i, (p) => ({ [IDS.prog]: [{ id: IDS.prog, department_id: IDS.dept, campus_id: IDS.campusA }], [IDS.progB]: [{ id: IDS.progB, department_id: IDS.deptB, campus_id: IDS.campusB }] }[p[0]] || []));
  sql(/^INSERT INTO users/i, (p) => [{ id: NEW_ID, email: p[0], full_name: p[1], employee_id: p[2], role: p[4], department_id: p[5], campus_id: p[7], access_deadline: p[8], created_at: new Date().toISOString() }]);
  sql(/^SELECT id FROM user_scopes\s+WHERE user_id = \$1 AND role = \$2 AND is_active/i, []);
  sql(/^INSERT INTO user_scopes/i, [{ id: '5c000000-0000-0000-0000-00000000000a' }]);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE user_id = \$1 AND purpose = 'account_setup'/i, []);
  sql(/^INSERT INTO otp_codes .*'account_setup'/i, []);
}
const person = (over = {}) => ({ email: 'New.Person@T.edu', full_name: 'New Person', employee_id: 'EMP-900', ...over });

test('provisioning: admin creates a COE with explicit scopes in one transaction; the code is emailed, never returned', async () => {
  scriptProvisioning();
  const r = await call('POST', '/academic/users', person({ role: 'coe', campus_id: IDS.campusA, scopes: [{ campus_id: IDS.campusA, program_id: IDS.prog }] }), 'admin');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const ins = log.find((l) => /^INSERT INTO users/.test(l.text));
  assert.deepEqual([ins.params[0], ins.params[1], ins.params[2], ins.params[4], ins.params[6], ins.params[7], ins.params[9]],
    ['new.person@t.edu', 'New Person', 'EMP-900', 'coe', 'i0000000-0000-0000-0000-000000000001', IDS.campusA, USERS.admin.id]);
  assert.match(ins.text, /must_change_password, created_by/); assert.match(ins.params[3], /^\$argon2id\$/, 'an unusable random password');
  const sc = log.find((l) => /^INSERT INTO user_scopes/.test(l.text));
  assert.deepEqual(sc.params, [NEW_ID, 'coe', IDS.campusA, null, IDS.prog, null, USERS.admin.id]);
  const otp = log.find((l) => /^INSERT INTO otp_codes/.test(l.text));
  const lastAudit = log.map((l, i) => [l, i]).filter(([l]) => /INSERT INTO audit_log/.test(l.text)).pop();
  assert.equal(lastAudit[0].params[2], 'user_created'); assert.ok(log.indexOf(otp) < lastAudit[1] && log.indexOf(sc) < lastAudit[1], 'audit is the last write');
  assert.equal(mail.length, 1); assert.equal(mail[0].to, 'new.person@t.edu');
  const token = mail[0].text.match(/\b[0-9a-f]{64}\b/)[0];
  assert.equal(otp.params[1], hashCode(token), 'stored hashed');
  assert.equal(JSON.stringify(r.data).includes(token), false); assert.equal(r.data.dev_setup_token, undefined);
  assert.equal(Object.keys(r.data).some((k) => /password/.test(k)), false);
  assert.equal(r.data.invite_delivered, true); assert.equal(r.data.scopes.length, 1);
});

test('provisioning: validator defaults to the campus; teacher gets no scope; hierarchy and identity are validated; duplicates 409', async () => {
  scriptProvisioning();
  assert.equal((await call('POST', '/academic/users', person({ role: 'validator', campus_id: IDS.campusA }), 'admin')).status, 201);
  assert.deepEqual(log.find((l) => /^INSERT INTO user_scopes/.test(l.text)).params.slice(1, 5), ['validator', IDS.campusA, null, null]);
  log.length = 0;
  const t = await call('POST', '/academic/users', person({ role: 'teacher', campus_id: IDS.campusA, department_id: IDS.dept, access_deadline: new Date(Date.now() + 86400000).toISOString() }), 'admin');
  assert.equal(t.status, 201); assert.equal(has(/^INSERT INTO user_scopes/), false, 'teacher scopes come from assignments');
  const bad = [
    [person({ role: 'coe', campus_id: IDS.campusA, scopes: [{ campus_id: IDS.campusA, program_id: IDS.progB }] }), 'program of another campus'],
    [person({ role: 'hod', campus_id: IDS.campusA, department_id: IDS.deptB }), 'department of another campus'],
    [person({ role: 'reviewer', campus_id: IDS.campusA }), 'reviewer needs a department'],
    [person({ role: 'teacher', campus_id: IDS.campusA, department_id: IDS.dept, access_deadline: '2001-01-01' }), 'past deadline'],
    [person({ role: 'validator', campus_id: IDS.campusA, employee_id: '' }), 'employee id'],
    [person({ role: 'validator', campus_id: IDS.campusA, full_name: ' ' }), 'full name'],
    [person({ role: 'validator', campus_id: IDS.campusA, email: 'not-an-email' }), 'email'],
    [person({ role: 'superuser', campus_id: IDS.campusA }), 'role'],
    [person({ role: 'coe', campus_id: IDS.campusA, scopes: Array.from({ length: 21 }, () => ({ campus_id: IDS.campusA })) }), 'too many rows'],
  ];
  for (const [body, why] of bad) assert.equal((await call('POST', '/academic/users', body, 'admin')).status, 400, why);
  sql(/^INSERT INTO users/i, () => { throw Object.assign(new Error('dup'), { code: '23505', constraint: 'idx_users_employee_id' }); });
  const dup = await call('POST', '/academic/users', person({ role: 'validator', campus_id: IDS.campusA }), 'admin');
  assert.equal(dup.status, 409); assert.match(dup.data.error, /employee ID/);
  sql(/^INSERT INTO users/i, () => { throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_users_email_lower' }); });
  assert.match((await call('POST', '/academic/users', person({ role: 'validator', campus_id: IDS.campusA }), 'admin')).data.error, /email already exists/);
});

test('provisioning by an HOD: teacher/reviewer only, inside its own scope; the department comes from scope, not the request', async () => {
  scriptProvisioning(); installWorld();
  sql(/^INSERT INTO users/i, (p) => [{ id: NEW_ID, email: p[0], role: p[4], department_id: p[5], campus_id: p[7] }]);
  assert.equal((await call('POST', '/academic/users', person({ role: 'coe' }), 'hod')).status, 403);
  assert.equal((await call('POST', '/academic/users', person({ role: 'admin' }), 'hod')).status, 403);
  assert.equal((await call('POST', '/academic/users', person({ role: 'teacher', department_id: IDS.deptA2 }), 'hod')).status, 403, 'department outside the HOD scope');
  assert.equal((await call('POST', '/academic/users', person({ role: 'teacher', department_id: IDS.dept }), 'hodB')).status, 403, 'another campus');
  assert.equal(has(/^INSERT INTO users/), false);
  const r = await call('POST', '/academic/users', person({ role: 'reviewer', campus_id: IDS.campusB }), 'hod');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const ins = log.find((l) => /^INSERT INTO users/.test(l.text));
  assert.deepEqual([ins.params[5], ins.params[7]], [IDS.dept, IDS.campusA], 'the HOD\'s own department and its campus, whatever the body says');
});

test('provisioning: mail failure keeps the account and reports it; resend burns old codes; the dev flag exposes the code only outside production', async () => {
  scriptProvisioning();
  mailControl.fail = true;
  const r = await call('POST', '/academic/users', person({ role: 'validator', campus_id: IDS.campusA }), 'admin');
  assert.equal(r.status, 201); assert.equal(r.data.invite_delivered, false);
  assert.deepEqual(auditDetails('account_invite_delivery_failed'), { kind: 'send_failed' });
  mailControl.fail = false;
  USERS.v2.must_change_password = true; log.length = 0;
  const re = await call('POST', `/academic/users/${USERS.v2.id}/resend-invite`, null, 'admin');
  assert.equal(re.status, 200); assert.equal(re.data.invite_delivered, true); assert.equal(re.data.dev_setup_token, undefined);
  assert.ok(log.findIndex((l) => /purpose = 'account_setup' AND used = FALSE/.test(l.text)) < log.findIndex((l) => /^INSERT INTO otp_codes/.test(l.text)));
  assert.ok(audits().includes('account_invite_reissued'));
  USERS.v2.must_change_password = false;
  assert.equal((await call('POST', `/academic/users/${USERS.v2.id}/resend-invite`, null, 'admin')).status, 409, 'already set up');
  process.env.DEV_EXPOSE_ACCOUNT_SETUP_TOKEN = 'true';
  try {
    mail.length = 0;
    const dev = await call('POST', '/academic/users', person({ role: 'validator', campus_id: IDS.campusA }), 'admin');
    assert.equal(dev.data.dev_setup_token, mail[0].text.match(/\b[0-9a-f]{64}\b/)[0]);
  } finally { process.env.DEV_EXPOSE_ACCOUNT_SETUP_TOKEN = 'false'; }
});

// ---------------------------------------------------------------- deactivate / reactivate / role change
function scriptLifecycle() {
  sql(/^UPDATE users SET is_active = FALSE, token_version = token_version \+ 1/i, (p) => [{ id: p[0] }]);
  sql(/^UPDATE user_scopes SET is_active = FALSE, revoked_at = now\(\), revoked_by = \$2/i, (p) => [{ id: '5c000000-0000-0000-0000-0000000000b1', role: 'validator', campus_id: IDS.campusA, user_id: p[0] }]);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE user_id = \$1 AND used = FALSE/i, []);
  sql(/FROM paper_validator_assignments pva JOIN exam_papers ep ON ep.id = pva.paper_id JOIN examinations e/i, []);
  sql(/^SELECT id FROM user_scopes\s+WHERE user_id = \$1 AND role = \$2 AND is_active/i, []);
  sql(/^INSERT INTO user_scopes/i, [{ id: '5c000000-0000-0000-0000-0000000000c1' }]);
}
test('deactivation: one transaction revokes scopes (who/why), ends sessions and burns codes; validators trigger replacement', async () => {
  scriptLifecycle();
  const r = await call('POST', `/academic/users/${USERS.v1.id}/deactivate`, { reason: 'left the institution' }, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.revoked_scopes, 1);
  const upd = log.find((l) => /^UPDATE users SET is_active = FALSE/.test(l.text));
  assert.match(upd.text, /token_version = token_version \+ 1/); assert.match(upd.text, /WHERE id = \$1 AND is_active/);
  assert.deepEqual(log.find((l) => /^UPDATE user_scopes SET is_active = FALSE, revoked_at/.test(l.text)).params, [USERS.v1.id, USERS.admin.id, 'account_deactivated']);
  assert.ok(has(/^UPDATE otp_codes SET used = TRUE WHERE user_id = \$1 AND used = FALSE/));
  const d = auditDetails('user_deactivated');
  assert.equal(d.reason, 'left the institution'); assert.equal(d.revoked_scopes.length, 1);
  assert.ok(has(/FROM paper_validator_assignments pva JOIN exam_papers ep/), 'COEs told to replace the validator');
  assert.equal((await call('POST', `/academic/users/${USERS.admin.id}/deactivate`, null, 'admin')).status, 400, 'self');
  sql(/SELECT COUNT\(\*\)::int AS n FROM users WHERE role = 'admin' AND is_active AND id <> \$1/i, [{ n: 0 }]);
  assert.equal((await call('POST', `/academic/users/${ADMIN2.id}/deactivate`, null, 'admin')).status, 409, 'last active admin');
  sql(/^UPDATE users SET is_active = FALSE, token_version = token_version \+ 1/i, []);
  assert.equal((await call('POST', `/academic/users/${USERS.v2.id}/deactivate`, null, 'admin')).status, 409, 'already inactive');
  installWorld(); log.length = 0;
  assert.equal((await call('POST', `/academic/users/${USERS.reviewerA2.id}/deactivate`, null, 'hod')).status, 403, 'other department');
  assert.equal((await call('POST', `/academic/users/${USERS.v3.id}/deactivate`, null, 'hod')).status, 403, 'not a teacher/reviewer');
  assert.equal(has(/^UPDATE users/), false);
});

test('reactivation re-grants only derivable scopes; COE/validator need an explicit grant', async () => {
  scriptLifecycle();
  sql(/^UPDATE users SET is_active = TRUE/i, (p) => [Object.values(USERS).find((u) => u.id === p[0])]);
  let r = await call('POST', `/academic/users/${USERS.reviewer.id}/reactivate`, null, 'admin');
  assert.equal(r.status, 200); assert.equal(r.data.restored_scopes, 1); assert.equal(r.data.needs_scope_grant, false);
  assert.deepEqual(log.find((l) => /^INSERT INTO user_scopes/.test(l.text)).params, [USERS.reviewer.id, 'reviewer', IDS.campusA, IDS.dept, null, null, USERS.admin.id]);
  log.length = 0;
  sql(/FROM teacher_course_assignments t JOIN course_offerings co ON co.id = t.course_offering_id JOIN programs p/i,
    [{ campus_id: IDS.campusA, department_id: IDS.dept, program_id: IDS.prog, course_offering_id: IDS.off }]);
  r = await call('POST', `/academic/users/${USERS.teacher.id}/reactivate`, null, 'admin');
  assert.equal(r.data.restored_scopes, 1);
  assert.deepEqual(log.find((l) => /^INSERT INTO user_scopes/.test(l.text)).params.slice(1, 6), ['teacher', IDS.campusA, IDS.dept, IDS.prog, IDS.off], 'one offering scope per active assignment');
  log.length = 0;
  r = await call('POST', `/academic/users/${USERS.v1.id}/reactivate`, null, 'admin');
  assert.equal(r.data.needs_scope_grant, true); assert.equal(has(/^INSERT INTO user_scopes/), false);
  assert.ok(audits().includes('user_reactivated'));
});

test('role change: admin only with a reason; old scopes and assignments end, new scopes granted, sessions end, audited', async () => {
  scriptLifecycle(); scriptProvisioning();
  sql(/^UPDATE reviewer_assignments SET is_active = FALSE WHERE reviewer_id = \$1/i, []);
  sql(/^UPDATE users SET role = \$2/i, (p) => [{ id: p[0], role: p[1] }]);
  sql(/FROM user_scopes WHERE user_id = \$1 AND is_active ORDER BY created_at/i, [{ id: 's', role: 'validator', campus_id: IDS.campusA }]);
  const url = `/academic/users/${USERS.reviewer.id}/role`;
  assert.equal((await call('POST', url, { role: 'validator', reason: 'moved to the exam cell' }, 'hod')).status, 403);
  assert.equal((await call('POST', url, { role: 'validator' }, 'admin')).status, 400, 'reason required');
  assert.equal((await call('POST', url, { role: 'reviewer', reason: 'moved to the exam cell' }, 'admin')).status, 400, 'same role');
  log.length = 0;
  const r = await call('POST', url, { role: 'validator', campus_id: IDS.campusA, reason: 'moved to the exam cell' }, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const at = (re) => log.findIndex((l) => re.test(l.text));
  assert.ok(at(/^UPDATE user_scopes SET is_active = FALSE, revoked_at/) < at(/^UPDATE users SET role/));
  assert.ok(at(/^UPDATE reviewer_assignments SET is_active = FALSE/) > -1, 'reviewer assignments end');
  const role = log[at(/^UPDATE users SET role/)];
  assert.match(role.text, /token_version = token_version \+ 1/); assert.match(role.text, /AND role = \$6/);
  assert.ok(at(/^INSERT INTO user_scopes/) > at(/^UPDATE users SET role/));
  const d = auditDetails('user_role_changed');
  assert.equal(d.old_role, 'reviewer'); assert.equal(d.new_role, 'validator'); assert.equal(d.reason, 'moved to the exam cell');
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[1] === 'account_role_changed'));
  assert.equal((await call('POST', `/academic/users/${USERS.admin.id}/role`, { role: 'hod', reason: 'moved to the exam cell' }, 'admin')).status, 400, 'own role');
});

test('a token signed for a deactivated account stops working at once', async () => {
  const token = signJwt({ sub: USERS.teacher.id, tv: 0 }, '1h');
  USERS.teacher.is_active = false;
  const res = await fetch(`http://localhost:${process.env.PORT}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401); assert.equal((await res.json()).session_invalid, true);
});
