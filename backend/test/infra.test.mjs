// Phase 3, infrastructure security: readiness, lockdown, error/log hygiene, the database-error vs bad-session split,
// and fail-closed virus scanning with quarantine and rescans (a fake clamd stands in for ClamAV).
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sql, log, baseRules, start, call, tokenFor, USERS } from './harness.mjs';
import { startFakeClamd } from './fake-clamd.mjs';
import { flagSuspicious } from '../src/security.js';
import { verifyTotpKeyCheck, totpKeyCheckState, resetTotpKeyCheckForTests, keyCheckValue } from '../src/totp-key-check.js';
import { sealSecret } from '../src/secret-box.js';
import { authenticator } from 'otplib';

const BASE = () => `http://localhost:${process.env.PORT}/api`;
const UPLOADS = new URL('../uploads/', import.meta.url);
const QID = '9a000000-0000-0000-0000-0000000000e1';
const ATT = '9e000000-0000-0000-0000-0000000000e1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let clam = null;
before(start);
after(async () => { if (clam) await clam.close(); setTimeout(() => process.exit(0), 50).unref(); });
beforeEach(async () => {
  baseRules();
  process.env.CLAMD_HOST = ''; process.env.CLAMD_PORT = '';
  if (clam) { await clam.close(); clam = null; }
});
const audits = () => log.filter((l) => /INSERT INTO audit_log/.test(l.text)).map((l) => l.params[2]);
const rm = (rel) => { try { fs.unlinkSync(new URL(rel, UPLOADS)); } catch { /* not there */ } };

// ---------------------------------------------------------------- health
test('health: live is process-only; ready reports checks and active protections; legacy /api/health unchanged', async () => {
  const live = await fetch(`${BASE()}/health/live`);
  assert.equal(live.status, 200); assert.deepEqual(await live.json(), { status: 'ok' });
  let r = await fetch(`${BASE()}/health/ready`); let b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.status, 'degraded');
  assert.deepEqual(b.checks, { database: 'ok', rate_limit_store: 'ok', clamav: 'not_configured', otp_delivery: 'ok', totp_encryption_key: 'ok' });
  assert.match(b.protections.rate_limiting, /per-process/); assert.match(b.protections.upload_scanning, /quarantined/);
  assert.deepEqual(b.failing, []); assert.match(r.headers.get('cache-control'), /no-store/);
  clam = await startFakeClamd(); clam.env();
  b = await (await fetch(`${BASE()}/health/ready`)).json();
  assert.equal(b.checks.clamav, 'ok'); assert.equal(b.status, 'ready'); assert.equal(b.protections.upload_scanning, 'active (ClamAV)');
  await clam.close(); clam = null;
  r = await fetch(`${BASE()}/health/ready`); b = await r.json();
  assert.equal(b.checks.clamav, 'unavailable'); assert.equal(r.status, 200, 'a scanner outage degrades, it does not pull the pod');
  const legacy = await (await fetch(`${BASE()}/health`)).json();
  assert.deepEqual(legacy, { ok: true, db: 'connected' });
});

test('health: a database failure gives 503 with fixed tokens only (no error text, hosts or credentials)', async () => {
  sql(/^SELECT 1$/, () => { throw Object.assign(new Error('password authentication failed for user "examportal" at 10.0.0.5'), { code: '28P01' }); });
  const r = await fetch(`${BASE()}/health/ready`); const text = await r.text();
  assert.equal(r.status, 503); assert.equal(JSON.parse(text).failing[0], 'database');
  assert.equal(/password|10\.0\.0\.5|examportal/.test(text), false, text);
  const legacy = await fetch(`${BASE()}/health`);
  assert.equal(legacy.status, 503);
});

test('health: in production an anonymous caller gets only the status; the admin gets the full report', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const r = await fetch(`${BASE()}/health/ready`);
    assert.deepEqual(Object.keys(await r.json()), ['status'], 'no checks, protections or failing list for anonymous callers');
    assert.ok([200, 503].includes(r.status), 'the code still carries the verdict for probes');
  } finally { process.env.NODE_ENV = prev; }
  sql(/FROM users GROUP BY role/i, []); sql(/FROM questions GROUP BY question_status/i, []); sql(/FROM exam_papers GROUP BY paper_status/i, []);
  sql(/FROM schema_migrations/i, [{ n: 40 }]); sql(/FROM authorization_log/i, []); sql(/FROM admin_overrides/i, []);
  sql(/FROM question_attachments GROUP BY 1/i, []);
  const sys = await call('GET', '/admin/system', null, 'admin');
  assert.equal(sys.status, 200); assert.ok(sys.data.readiness.checks && sys.data.readiness.protections, 'the admin view keeps the details');
});

test('TOTP key check: a key that differs from the stored check is refused (readiness, step-up, enrolment), never downgraded; an explicit rotation clears secrets, audited', async () => {
  const other = keyCheckValue(Buffer.alloc(32, 9));
  sql(/^SELECT value FROM system_state WHERE key = \$1/i, [{ value: other }]);
  resetTotpKeyCheckForTests();
  try {
    assert.equal(await verifyTotpKeyCheck(), 'mismatch'); assert.equal(totpKeyCheckState(), 'mismatch');
    const r = await (await fetch(`${BASE()}/health/ready`)).json();
    assert.equal(r.checks.totp_encryption_key, 'mismatch'); assert.match(r.protections.totp_secrets, /does not match/);
    const SECRET = authenticator.generateSecret();
    sql(/SELECT totp_secret, totp_enabled FROM users/i, [{ totp_secret: sealSecret(SECRET, `totp:${USERS.coe.id}`), totp_enabled: true }]);
    sql(/FROM exam_papers ep JOIN examinations e/i, [{ id: 'p1', paper_status: 'VALIDATED', campus_id: USERS.coe.campus_id, program_id: null, department_id: null, exam_offering_id: null }]);
    sql(/FROM paper_validator_assignments WHERE paper_id = \$1 AND is_active = true/i, [{ total: 4, approved: 4 }]);
    log.length = 0;
    const step = await call('POST', '/coe/papers/9d000000-0000-0000-0000-0000000000a1/coe-approve', { totp_code: authenticator.generate(SECRET) }, 'coe');
    assert.equal(step.status, 503); assert.match(step.data.error, /server key/);
    assert.equal(log.some((l) => /totp_reenroll_required = TRUE/.test(l.text)), false, 'nobody is downgraded to password re-enrolment');
    const enrol = await call('POST', '/auth/totp/setup', { current_password: 'x' }, 'coe');
    assert.equal(enrol.status, 503);
    // Explicit rotation: the new check is stored, every stored secret is cleared (owners re-enrol), audited.
    process.env.TOTP_KEY_ROTATE = 'yes';
    sql(/^UPDATE system_state SET value = \$2/i, []);
    sql(/^UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_pending_secret = NULL/i, [{ id: USERS.coe.id }, { id: USERS.v1.id }]);
    log.length = 0;
    assert.equal(await verifyTotpKeyCheck(), 'rotated'); assert.equal(totpKeyCheckState(), 'ok');
    assert.equal(log.find((l) => /^UPDATE system_state SET value = \$2/.test(l.text)).params[1], keyCheckValue());
    assert.match(log.find((l) => /^UPDATE users SET totp_secret = NULL/.test(l.text)).text, /totp_reenroll_required = TRUE/);
    assert.equal(log.filter((l) => /INSERT INTO notifications/.test(l.text)).length, 2);
    assert.ok(audits().includes('totp_key_rotated'));
  } finally {
    delete process.env.TOTP_KEY_ROTATE;
    resetTotpKeyCheckForTests();
  }
  // First start: the check is recorded; the same key matches afterwards.
  baseRules();
  assert.equal(await verifyTotpKeyCheck(), 'initialised');
  sql(/^SELECT value FROM system_state WHERE key = \$1/i, [{ value: keyCheckValue() }]);
  assert.equal(await verifyTotpKeyCheck(), 'ok');
});

test('health probes are not logged as suspicious and do not touch the IP blocklist', async () => {
  log.length = 0;
  for (let i = 0; i < 25; i++) assert.equal((await fetch(`${BASE()}/health/ready`)).status, 200);
  assert.equal(log.some((l) => /suspicious_activity|blocked_ips/.test(l.text)), false);
});

// ---------------------------------------------------------------- lockdown
test('lockdown: non-admin changes paused (503), reads, sign-out and admin work; it expires after an hour', async () => {
  let row = { value: '1', updated_at: new Date().toISOString() };
  sql(/FROM system_state WHERE key = 'lockdown_mode'/i, () => [row]);
  sql(/^UPDATE system_state SET value = '0'/i, []);
  sql(/^UPDATE users SET token_version = token_version \+ 1 WHERE id = \$1$/i, []);
  log.length = 0;
  const w = await call('POST', '/questions/draft', { question_type: 'descriptive', question_text: 'Explain heaps', difficulty: 'easy', marks: 2 }, 'teacher');
  assert.equal(w.status, 503); assert.equal(w.data.lockdown, true);
  assert.equal(log.some((l) => /INSERT INTO questions/.test(l.text)), false);
  assert.equal((await call('GET', '/auth/me', null, 'teacher')).status, 200, 'reads still work');
  assert.equal((await call('POST', '/auth/logout', null, 'teacher')).status, 200, 'sign-out still works');
  assert.equal((await call('POST', '/admin/attachments/rescan', { limit: 0 }, 'admin')).status, 400, 'admin is not refused by lockdown');
  for (const who of ['hod', 'coe', 'v1']) assert.equal((await call('POST', '/notifications/read-all', null, who)).status, 503, who);
  row = { value: '1', updated_at: new Date(Date.now() - 2 * 3600000).toISOString() };
  const after2h = await call('POST', '/questions/draft', { question_type: 'essay' }, 'teacher');
  assert.notEqual(after2h.status, 503, 'auto-expired'); assert.ok(audits().includes('system_lockdown_auto_expired'));
});

test('lockdown is triggered only by authenticated attacks (never 404 scans or failed logins); the loopback address is never auto-blocked', async () => {
  sql(/FROM suspicious_activity/i, [{ c: 50 }]);
  sql(/^INSERT INTO blocked_ips/i, (p) => [{ ip: p[0] }]);
  sql(/COUNT\(DISTINCT ip\)::int as c FROM blocked_ips/i, [{ c: 9 }]);
  sql(/^INSERT INTO system_state/i, []);
  log.length = 0;
  await flagSuspicious({ ip: '10.9.9.9' }, 'not_found_scan', { path: '/wp-admin' });
  assert.ok(log.some((l) => /^INSERT INTO blocked_ips/.test(l.text)), 'the scanner itself is blocked');
  assert.equal(log.some((l) => /INSERT INTO system_state/.test(l.text)), false, 'but no lockdown (spec §37.4)');
  // Review issue: 3 addresses x 8 bad logins with random emails froze every non-admin write for an hour.
  log.length = 0;
  for (const ip of ['10.9.9.1', '10.9.9.2', '10.9.9.3']) {
    for (let i = 0; i < 8; i++) await flagSuspicious({ ip }, 'failed_login', { reason: 'unknown_account' });
  }
  assert.ok(log.some((l) => /^INSERT INTO blocked_ips/.test(l.text)), 'the guessing addresses are blocked for a while');
  assert.equal(log.some((l) => /COUNT\(DISTINCT ip\)/.test(l.text)), false, 'failed logins never count toward lockdown');
  assert.equal(log.some((l) => /INSERT INTO system_state/.test(l.text)), false, 'no global write freeze from unauthenticated noise');
  for (const t of ['invalid_otp', 'invalid_reset_token', 'malformed_request']) await flagSuspicious({ ip: '10.9.9.4' }, t, {});
  assert.equal(log.some((l) => /INSERT INTO system_state/.test(l.text)), false, 'OTP, reset-code and malformed-request noise never freezes writes either');
  // Wrong authenticator codes from signed-in sessions on several addresses: that is lockdown material.
  log.length = 0;
  await flagSuspicious({ ip: '10.9.9.8' }, 'invalid_totp', {});
  const count = log.find((l) => /COUNT\(DISTINCT ip\)/.test(l.text));
  assert.match(count.text, /auto_blocked AND reason ~/); assert.equal(count.params[0], 'invalid_totp|invalid_dual_control');
  assert.ok(log.some((l) => /INSERT INTO system_state/.test(l.text)), 'authenticated attacks still trigger it');
  log.length = 0;
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) await flagSuspicious({ ip }, 'invalid_totp', {});
  assert.equal(log.some((l) => /INSERT INTO blocked_ips/.test(l.text)), false);
});

test('automatic IP blocks expire: the block carries an expiry, the blocklist ignores expired rows, an active block is not renewed', async () => {
  sql(/FROM suspicious_activity/i, [{ c: 50 }]);
  let renewed = [];
  sql(/^INSERT INTO blocked_ips/i, () => renewed);
  log.length = 0;
  await flagSuspicious({ ip: '10.7.7.7' }, 'failed_login', {});
  const ins = log.find((l) => /^INSERT INTO blocked_ips/.test(l.text));
  assert.match(ins.text, /expires_at\) VALUES \(\$1, \$2, now\(\), TRUE, now\(\) \+ make_interval\(mins => \$3\)\)/);
  assert.equal(ins.params[2], 60, 'one hour by default');
  assert.match(ins.text, /WHERE blocked_ips.expires_at IS NOT NULL AND blocked_ips.expires_at <= now\(\)/, 'only an expired automatic block is renewed; manual blocks are kept');
  assert.equal(audits().includes('ip_auto_blocked'), false, 'still blocked: no duplicate audit');
  renewed = [{ ip: '10.7.7.7' }];
  await flagSuspicious({ ip: '10.7.7.7' }, 'failed_login', {});
  assert.ok(audits().includes('ip_auto_blocked'));
  // The request-time check: an expired row no longer blocks.
  log.length = 0;
  await fetch(`${BASE()}/health`);
  await call('GET', '/auth/me', null, 'teacher');
  const check = log.find((l) => /FROM blocked_ips WHERE ip = \$1/.test(l.text));
  assert.match(check.text, /AND \(expires_at IS NULL OR expires_at > now\(\)\)/);
});

// ---------------------------------------------------------------- errors and sessions
test('errors: malformed JSON is a 400 with a request id; a database outage is 503, never a dead session', async () => {
  const r = await fetch(`${BASE()}/auth/login/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email": ' });
  const b = await r.json();
  assert.equal(r.status, 400); assert.equal(b.error, 'Malformed JSON body'); assert.equal(b.request_id, r.headers.get('x-request-id'));
  assert.ok(log.some((l) => /INSERT INTO suspicious_activity/.test(l.text) && l.params[1] === 'malformed_request'));
  sql(/FROM users WHERE id = \$1$/i, () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }); });
  const out = []; const orig = console.error; console.error = (...a) => out.push(a.join(' '));
  let me;
  try { me = await call('GET', '/auth/me', null, 'teacher'); } finally { console.error = orig; }
  assert.equal(me.status, 503); assert.equal(me.data.session_invalid, undefined, 'the frontend keeps the session');
  assert.equal(me.data.error, 'Service temporarily unavailable'); assert.ok(me.data.request_id);
  const line = JSON.parse(out.find((o) => o.startsWith('{')));
  assert.equal(line.error.code, 'ECONNREFUSED'); assert.equal(line.request_id, me.data.request_id);
  const bad = await fetch(`${BASE()}/auth/me`, { headers: { Authorization: 'Bearer not.a.jwt' } });
  assert.equal(bad.status, 401); assert.equal((await bad.json()).session_invalid, true);
});

test('errors: an unexpected database error reaches the client as a generic message; pg row details never reach the log', async () => {
  sql(/^SELECT \* FROM notifications WHERE user_id/i, () => { throw Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'),
    { code: '23505', constraint: 'users_email_key', detail: 'Key (email)=(secret.person@t.edu) already exists.' }); });
  const out = []; const orig = console.error; console.error = (...a) => out.push(a.join(' '));
  let r;
  try { r = await call('GET', '/notifications', null, 'teacher'); } finally { console.error = orig; }
  assert.equal(r.status, 409); assert.equal(r.data.error, 'A record with these details already exists');
  assert.equal(out.join('\n').includes('secret.person@t.edu'), false); assert.ok(out.join('\n').includes('users_email_key'));
});

// ---------------------------------------------------------------- attachments: scan, quarantine, rescan
function attRow(over = {}) {
  return { id: ATT, question_id: QID, file_path: `quarantine/${ATT}.png`, scan_status: 'failed', uploaded_by: USERS.teacher.id,
    last_scanned_at: new Date(Date.now() - 600000).toISOString(), question_owner: USERS.teacher.id, ...over };
}
async function upload() {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'd.png');
  const r = await fetch(`${BASE()}/attachments/${QID}`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor('teacher')}` }, body: fd });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
function scriptUpload() {
  sql(/SELECT id, question_status, question_type FROM questions WHERE id = \$1 AND submitted_by/i, [{ id: QID, question_status: 'DRAFT' }]);
  sql(/COUNT\(\*\)::int as c FROM question_attachments/i, [{ c: 0 }]);
  sql(/INSERT INTO question_attachments/i, [{ id: ATT }]);
  sql(/^UPDATE question_attachments SET (file_path|scan_detail)/i, []);
}

test('upload: a clean file is stored and usable; an infected one is never written; the clamd INSTREAM framing is exact', async () => {
  clam = await startFakeClamd(); clam.env(); scriptUpload();
  try {
    const r = await upload();
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.scan_status, 'clean');
    assert.ok(clam.state.received[0].equals(PNG), 'the scanner received exactly the uploaded bytes');
    assert.equal(log.find((l) => /^UPDATE question_attachments SET file_path/.test(l.text)).params[0], `${ATT}.png`);
    assert.ok(fs.existsSync(new URL(`${ATT}.png`, UPLOADS)));
    rm(`${ATT}.png`);
    clam.state.reply = () => 'stream: Eicar-Test-Signature FOUND'; log.length = 0;
    const inf = await upload();
    assert.equal(inf.status, 400); assert.equal(inf.data.scan_status, 'infected');
    assert.equal(fs.existsSync(new URL(`${ATT}.png`, UPLOADS)) || fs.existsSync(new URL(`quarantine/${ATT}.png`, UPLOADS)), false, 'never written');
    assert.equal(log.find((l) => /^UPDATE question_attachments SET scan_detail/.test(l.text)).params[0], 'Eicar-Test-Signature');
    assert.ok(audits().includes('attachment_infected'));
  } finally { rm(`${ATT}.png`); rm(`quarantine/${ATT}.png`); }
});

test('rescan by the author: a quarantined file that scans clean moves out of quarantine (conditional update, audited)', async () => {
  clam = await startFakeClamd(); clam.env();
  fs.writeFileSync(new URL(`quarantine/${ATT}.png`, UPLOADS), PNG);
  sql(/FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id/i, () => [attRow()]);
  sql(/^UPDATE question_attachments SET scan_status = 'clean'/i, [{ id: ATT }]);
  try {
    const r = await call('POST', `/attachments/${ATT}/rescan`, null, 'teacher');
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.scan_status, 'clean');
    const upd = log.find((l) => /^UPDATE question_attachments SET scan_status = 'clean'/.test(l.text));
    assert.match(upd.text, /scan_status IN \('failed', 'pending'\)/); assert.deepEqual(upd.params, [ATT, `${ATT}.png`]);
    assert.ok(fs.existsSync(new URL(`${ATT}.png`, UPLOADS)) && !fs.existsSync(new URL(`quarantine/${ATT}.png`, UPLOADS)));
    assert.ok(audits().includes('attachment_rescanned'));
  } finally { rm(`${ATT}.png`); rm(`quarantine/${ATT}.png`); }
});

test('rescan: infected -> file removed, row cleared, uploader notified; refusals for clean, too soon, other teachers and other roles', async () => {
  clam = await startFakeClamd({ reply: () => 'stream: Win.Test.EICAR_HDB-1 FOUND' }); clam.env();
  fs.writeFileSync(new URL(`quarantine/${ATT}.png`, UPLOADS), PNG);
  let row = attRow();
  sql(/FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id/i, () => [row]);
  sql(/^UPDATE question_attachments SET scan_status = 'infected'/i, [{ id: ATT }]);
  try {
    const r = await call('POST', `/attachments/${ATT}/rescan`, null, 'teacher');
    assert.equal(r.status, 200); assert.equal(r.data.scan_status, 'infected');
    assert.equal(fs.existsSync(new URL(`quarantine/${ATT}.png`, UPLOADS)), false, 'deleted');
    assert.match(log.find((l) => /SET scan_status = 'infected'/.test(l.text)).text, /file_path = ''/);
    assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.teacher.id && l.params[1] === 'attachment_infected'));
    assert.ok(audits().includes('attachment_rescan_infected'));
    row = attRow({ scan_status: 'clean', file_path: `${ATT}.png` });
    assert.equal((await call('POST', `/attachments/${ATT}/rescan`, null, 'teacher')).status, 409);
    row = attRow({ last_scanned_at: new Date().toISOString() });
    assert.equal((await call('POST', `/attachments/${ATT}/rescan`, null, 'teacher')).status, 429);
    row = attRow();
    assert.equal((await call('POST', `/attachments/${ATT}/rescan`, null, 'teacherA2')).status, 404, 'another teacher');
    for (const who of ['reviewer', 'hod', 'admin']) assert.equal((await call('POST', `/attachments/${ATT}/rescan`, null, who)).status, 403, who);
    assert.equal((await call('POST', '/attachments/nope/rescan', null, 'teacher')).status, 404);
  } finally { rm(`quarantine/${ATT}.png`); }
});

test('rescan while the scanner is still down: the file stays quarantined and the attempt is recorded', async () => {
  fs.writeFileSync(new URL(`quarantine/${ATT}.png`, UPLOADS), PNG);
  sql(/FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id/i, () => [attRow()]);
  sql(/^UPDATE question_attachments SET scan_detail = \$2/i, []);
  try {
    const r = await call('POST', `/attachments/${ATT}/rescan`, null, 'teacher');
    assert.equal(r.status, 200); assert.equal(r.data.scan_status, 'failed'); assert.match(r.data.warning, /still unavailable/);
    assert.deepEqual(log.find((l) => /^UPDATE question_attachments SET scan_detail = \$2/.test(l.text)).params, [ATT, 'scanner_not_configured']);
    assert.ok(fs.existsSync(new URL(`quarantine/${ATT}.png`, UPLOADS)));
  } finally { rm(`quarantine/${ATT}.png`); }
});

test('admin batch rescan: counts only, audited; 503 without a scanner; bounded; admin only', async () => {
  assert.equal((await call('POST', '/admin/attachments/rescan', { limit: 10 }, 'admin')).status, 503, 'no scanner');
  for (const limit of [0, 101, 'x']) assert.equal((await call('POST', '/admin/attachments/rescan', { limit }, 'admin')).status, 400, String(limit));
  for (const who of ['teacher', 'hod', 'coe']) assert.equal((await call('POST', '/admin/attachments/rescan', {}, who)).status, 403, who);
  clam = await startFakeClamd(); clam.env();
  fs.writeFileSync(new URL(`quarantine/${ATT}.png`, UPLOADS), PNG);
  sql(/^UPDATE question_attachments SET last_scanned_at = now\(\)\s+WHERE id IN/i, [attRow()]);
  sql(/^UPDATE question_attachments SET scan_status = 'clean'/i, [{ id: ATT }]);
  try {
    const r = await call('POST', '/admin/attachments/rescan', { limit: 10 }, 'admin');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { scanned: 1, clean: 1, infected: 0, failed: 0, missing: 0, conflict: 0 });
    assert.ok(Object.values(r.data).every((v) => typeof v === 'number'), 'no names or ids');
    const claim = log.find((l) => /WHERE id IN/.test(l.text));
    assert.match(claim.text, /FOR UPDATE SKIP LOCKED/); assert.deepEqual(claim.params, [10, null], 'admin batch has no attempt cap');
    assert.ok(audits().includes('attachment_rescan_batch'));
  } finally { rm(`${ATT}.png`); rm(`quarantine/${ATT}.png`); }
});
