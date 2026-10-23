import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { authenticator } from 'otplib';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { sql, log, baseRules, start, call, tokenFor, USERS, IDS, installWorld, PLACEMENT } from './harness.mjs';
import { SCOPE_SQL } from '../src/scopes.js';
import { normalizeQuestionHash } from '../src/auth.js';
import { sealSecret } from '../src/secret-box.js';

const PAPER = '99000000-0000-0000-0000-000000000001';
const SECRET = authenticator.generateSecret();
let paper, approvals, openIssues;

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => { baseRules(); paper = { id: PAPER, paper_status: 'VALIDATED', campus_id: IDS.campusA, program_id: IDS.prog, coe_approved_by: null, examination_id: 'ex1' }; approvals = { approved: 4, total: 4 }; openIssues = 0;
  sql(/FROM exam_papers ep JOIN course_offerings co/i, () => [paper]);
  // Secrets are stored sealed (secret-box.js), bound to the account.
  sql(/SELECT totp_secret, totp_enabled FROM users/i, [{ totp_secret: sealSecret(SECRET, `totp:${USERS.coe.id}`), totp_enabled: true }]);
  sql(/COUNT\(\*\)(::int)? (as|AS) (approved|total)/i, () => [approvals]);
  sql(/UPDATE exam_papers/i, () => [{ id: PAPER }]);
  sql(/SELECT \* FROM exam_papers WHERE id/i, () => [paper]);
  sql(/FROM paper_issues WHERE paper_id = \$1 AND status = 'open'/i, () => [{ n: openIssues }]);
  sql(/FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id (JOIN programs pr ON pr.id = e.program_id )?WHERE ep.id/i, () => [paper]);
  sql(/SELECT DISTINCT validator_id FROM paper_validator_assignments WHERE paper_id = \$1 AND deactivation_reason/i, []);
  // Row lock taken by print-ready / send-back; a validator's paper access re-runs the eligibility rules.
  sql(/SELECT id, paper_status FROM exam_papers WHERE id = \$1 FOR UPDATE/i, () => [paper]);
  sql(/paper_question_authors/i, []);
  sql(/AND is_active AND decision = 'CHANGES_REQUIRED'/i, [{ n: 0 }]);
  sql(/WHERE examination_id = \$3 AND paper_status = 'PRINT_READY' AND id <> \$4/i, []);
});
// A COE whose scope does not cover the paper's examination (other campus, or other program of the same campus).
const coeOutOfScope = () => sql(/user_has_scope/i, (p, t) => [{ has_scope: !(p[1] === 'coe' || /user_has_scope\(\$1, 'coe'/.test(t)) }]);

test('COE approval: needs TOTP, VALIDATED status and 4/4 approvals', async () => {
  const url = `/coe/papers/${PAPER}/coe-approve`;
  assert.equal((await call('POST', url, {}, 'coe')).status, 400);
  assert.equal((await call('POST', url, { totp_code: '000000' }, 'coe')).status, 401);
  approvals = { approved: 3, total: 4 };
  assert.equal((await call('POST', url, { totp_code: authenticator.generate(SECRET) }, 'coe')).status, 403);
  approvals = { approved: 4, total: 4 }; paper.paper_status = 'VALIDATION_PENDING';
  assert.equal((await call('POST', url, { totp_code: authenticator.generate(SECRET) }, 'coe')).status, 400);
  paper.paper_status = 'VALIDATED';
  const ok = await call('POST', url, { totp_code: authenticator.generate(SECRET) }, 'coe');
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.paper_status, 'COE_APPROVED');
});
test('COE approval: only the COE (not admin/HOD/validator)', async () => {
  for (const who of ['admin', 'hod', 'v1', 'reviewer']) assert.equal((await call('POST', `/coe/papers/${PAPER}/coe-approve`, { totp_code: authenticator.generate(SECRET) }, who)).status, 403, who);
});
test('PRINT_READY only after COE_APPROVED, by the approving COE', async () => {
  const url = `/coe/papers/${PAPER}/print-ready`;
  assert.equal((await call('POST', url, {}, 'coe')).status, 400);
  paper = { ...paper, paper_status: 'COE_APPROVED', coe_approved_by: 'someone-else' };
  assert.equal((await call('POST', url, {}, 'coe')).status, 403);
  paper.coe_approved_by = USERS.coe.id;
  assert.equal((await call('POST', url, {}, 'coe')).status, 200);
  assert.equal((await call('POST', url, {}, 'admin')).status, 403);
});
test('PRINT_READY of a revision archives the previously printed paper in the same transaction (one printed paper per examination)', async () => {
  paper = { ...paper, paper_status: 'COE_APPROVED', coe_approved_by: USERS.coe.id, paper_version: 2 };
  sql(/WHERE examination_id = \$3 AND paper_status = 'PRINT_READY' AND id <> \$4/i, [{ id: 'printed-v1', paper_version: 1 }]);
  log.length = 0;
  const r = await call('POST', `/coe/papers/${PAPER}/print-ready`, {}, 'coe');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.archived_printed_papers, ['printed-v1']);
  const at = (re) => log.findIndex((l) => re.test(l.text));
  const arch = log[at(/SET paper_status = 'ARCHIVED'/)];
  assert.deepEqual(arch.params, [USERS.coe.id, 'Replaced by printed revision v2', 'ex1', PAPER]);
  const audits = log.filter((l) => /INSERT INTO audit_log/.test(l.text)).map((l) => [l.params[2], l.params[3]]);
  assert.deepEqual(audits, [['paper_archived', 'printed-v1'], ['paper_print_ready', PAPER]]);
  assert.ok(at(/FOR UPDATE/) < at(/SET paper_status = 'ARCHIVED'/) && at(/SET paper_status = 'ARCHIVED'/) < at(/SET paper_status = 'PRINT_READY'/)
    && at(/SET paper_status = 'PRINT_READY'/) < at(/INSERT INTO audit_log/), 'lock, archive the old print, print the revision, then audit (one transaction)');
  sql(/SELECT id, paper_status FROM exam_papers WHERE id = \$1 FOR UPDATE/i, () => [{ ...paper, paper_status: 'PRINT_READY' }]);
  assert.equal((await call('POST', `/coe/papers/${PAPER}/print-ready`, {}, 'coe')).status, 409, 'status re-checked under the row lock');
});

test('COE approval: blocked while validator issues are open; status reports blockers', async () => {
  openIssues = 2;
  const r = await call('POST', `/coe/papers/${PAPER}/coe-approve`, { totp_code: authenticator.generate(SECRET) }, 'coe');
  assert.equal(r.status, 409, JSON.stringify(r.data)); assert.match(r.data.reasons.join(' '), /2 validator issue/);
  assert.equal(log.some((l) => /UPDATE exam_papers/.test(l.text)), false, 'nothing written');
  const st = await call('GET', `/coe/papers/${PAPER}/coe-status`, null, 'coe');
  assert.equal(st.status, 200); assert.equal(st.data.ready_for_coe_approval, false); assert.equal(st.data.open_issues, 2);
});
test('COE approval: a 3-of-4 paper passes with 3 approvals; the approval UPDATE is conditional on VALIDATED', async () => {
  paper.required_approvals = 3; approvals = { approved: 3, total: 4 };
  const r = await call('POST', `/coe/papers/${PAPER}/coe-approve`, { totp_code: authenticator.generate(SECRET) }, 'coe');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(log.some((l) => /UPDATE exam_papers .* WHERE id = \$2 AND paper_status = 'VALIDATED'/.test(l.text)));
});
test('COE approval: TOTP not set up gives a clear hint', async () => {
  sql(/SELECT totp_secret, totp_enabled FROM users/i, [{ totp_secret: null, totp_enabled: false }]);
  const r = await call('POST', `/coe/papers/${PAPER}/coe-approve`, { totp_code: '123456' }, 'coe');
  assert.equal(r.status, 400); assert.equal(r.data.needs_totp_setup, true);
});
test('COE approval step-up: a code is accepted once, every attempt is logged, repeated failures lock, a foreign-key secret is refused', async () => {
  const url = `/coe/papers/${PAPER}/coe-approve`;
  sql(/^UPDATE users SET totp_last_used_step/i, []);
  let r = await call('POST', url, { totp_code: authenticator.generate(SECRET) }, 'coe');
  assert.equal(r.status, 401); assert.match(r.data.error, /already used/);
  assert.equal(log.some((l) => /^UPDATE exam_papers/.test(l.text)), false, 'nothing approved');
  const replayLog = log.filter((l) => /INSERT INTO step_up_auth_log/.test(l.text)).pop();
  assert.deepEqual([replayLog.params[0], replayLog.params[1], replayLog.params[2], replayLog.params[3], replayLog.params[4]], [USERS.coe.id, 'coe_approval', PAPER, false, 'replayed']);
  sql(/^UPDATE users SET totp_last_used_step/i, [{ id: USERS.coe.id }]);
  log.length = 0;
  r = await call('POST', url, { totp_code: '000000' }, 'coe');
  assert.equal(r.status, 401);
  assert.equal(log.filter((l) => /INSERT INTO step_up_auth_log/.test(l.text)).pop().params[4], 'invalid_code');
  assert.ok(log.some((l) => /INSERT INTO suspicious_activity/.test(l.text) && l.params[1] === 'invalid_totp'));
  // Review issue: lockout check, verification and failure record were not serialised per user. They now run in one
  // transaction under a per-user advisory lock taken before the failure count is read.
  const lockAt = log.findIndex((l) => /pg_advisory_xact_lock\(hashtextextended\('totp-step-up:' \|\| \$1::text, 0\)\)/.test(l.text) && l.params[0] === USERS.coe.id);
  const countAt = log.findIndex((l) => /FROM step_up_auth_log/.test(l.text) && /NOT success/.test(l.text));
  const failAt = log.findIndex((l) => /INSERT INTO step_up_auth_log/.test(l.text));
  assert.ok(lockAt >= 0 && lockAt < countAt && countAt < failAt, `lock ${lockAt} < count ${countAt} < record ${failAt}`);
  sql(/FROM step_up_auth_log/i, [{ n: 5 }]); log.length = 0;
  r = await call('POST', url, { totp_code: authenticator.generate(SECRET) }, 'coe');
  assert.equal(r.status, 429); assert.equal(log.some((l) => /SELECT totp_secret/.test(l.text)), false, 'locked before the secret is read');
  sql(/FROM step_up_auth_log/i, [{ n: 0 }]);
  const otherKey = Buffer.alloc(32, 7);
  sql(/SELECT totp_secret, totp_enabled FROM users/i, [{ totp_secret: sealSecret(SECRET, `totp:${USERS.coe.id}`, otherKey), totp_enabled: true }]);
  const out = []; const orig = console.error; console.error = (...a) => out.push(a.join(' '));
  try { r = await call('POST', url, { totp_code: authenticator.generate(SECRET) }, 'coe'); } finally { console.error = orig; }
  assert.equal(r.status, 409); assert.match(r.data.error, /set up again/); assert.equal(out.join('\n').includes(SECRET), false);
  // The key itself matches the stored key check, so only this secret is damaged: re-enrolment with the password
  // is allowed for this account (and only this one), and the event is audited.
  assert.ok(log.some((l) => /^UPDATE users SET totp_reenroll_required = TRUE WHERE id = \$1/.test(l.text) && l.params[0] === USERS.coe.id));
  assert.ok(log.some((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'totp_secret_unreadable'));
  sql(/SELECT totp_secret, totp_enabled FROM users/i, [{ totp_secret: sealSecret(SECRET, `totp:${USERS.v1.id}`), totp_enabled: true }]);
  assert.equal((await call('POST', url, { totp_code: authenticator.generate(SECRET) }, 'coe')).status, 409, 'a secret sealed for another account does not open');
});
test('coe-status is scoped: unassigned validator, admin and other campuses denied', async () => {
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id/i, (p) => (p[1] === USERS.v1.id ? [{ x: 1 }] : []));
  assert.equal((await call('GET', `/coe/papers/${PAPER}/coe-status`, null, 'v1')).status, 200);
  for (const who of ['v2', 'admin', 'hod']) assert.equal((await call('GET', `/coe/papers/${PAPER}/coe-status`, null, who)).status, 403, who);
  coeOutOfScope();
  assert.equal((await call('GET', `/coe/papers/${PAPER}/coe-status`, null, 'coe')).status, 403);
});
test('coe-status: a validator who lost scope (or became inactive) after assignment is denied with the reason', async () => {
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id/i, (p) => (p[1] === USERS.v1.id ? [{ id: 'a1', assigned_by: USERS.coe.id }] : []));
  sql(/user_has_scope/i, (p) => [{ has_scope: p[0] !== USERS.v1.id }]);
  const r = await call('GET', `/coe/papers/${PAPER}/coe-status`, null, 'v1');
  assert.equal(r.status, 403); assert.match(r.data.error || '', /Not allowed/);
});

// ---- program-limited COE scope (review fix): every paper action checks campus, department, program and offering ----
test('a COE whose scope covers another program of the same campus cannot approve, send back, print, archive or read the paper', async () => {
  coeOutOfScope();
  paper = { ...paper, department_id: IDS.dept, exam_offering_id: IDS.off };
  const approve = await call('POST', `/coe/papers/${PAPER}/coe-approve`, { totp_code: authenticator.generate(SECRET) }, 'coe');
  assert.equal(approve.status, 403, JSON.stringify(approve.data)); assert.match(approve.data.error, /No COE scope for this examination/);
  // Review issue: the paper's status was told to an out-of-scope COE before the scope check, and not logged.
  const pending = { ...paper }; paper = { ...paper, paper_status: 'VALIDATION_PENDING' };
  log.length = 0;
  const early = await call('POST', `/coe/papers/${PAPER}/coe-approve`, { totp_code: '123456' }, 'coe');
  assert.equal(early.status, 403); assert.doesNotMatch(JSON.stringify(early.data), /VALIDATION_PENDING|VALIDATED/);
  assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[1] === 'approve_paper_coe' && l.params[4] === 'deny'), 'denial logged');
  assert.equal(log.some((l) => /step_up_auth_log/.test(l.text)), false, 'no step-up attempt for an out-of-scope COE');
  paper = pending;
  const authz = log.filter((l) => /SELECT user_has_scope/.test(l.text) && l.params[1] === 'coe').pop();
  assert.deepEqual(authz.params.slice(2), [IDS.campusA, IDS.dept, IDS.prog, IDS.off], 'approval checks the whole context, not only the campus');
  assert.equal((await call('POST', `/coe/papers/${PAPER}/send-back`, { reason: 'Q3 has a wrong model answer' }, 'coe')).status, 403);
  assert.equal((await call('POST', `/coe/papers/${PAPER}/archive`, { reason: 'end of exam cycle 2026' }, 'coe')).status, 403);
  paper = { ...paper, paper_status: 'COE_APPROVED', coe_approved_by: USERS.coe.id };
  assert.equal((await call('POST', `/coe/papers/${PAPER}/print-ready`, {}, 'coe')).status, 403, 'print-ready is scope-checked too');
  assert.equal(log.some((l) => /^UPDATE exam_papers|INSERT INTO paper_send_backs/.test(l.text)), false, 'nothing written');
});
test('archive: COE only, reason required, only from archivable states', async () => {
  const url = `/coe/papers/${PAPER}/archive`;
  paper.paper_status = 'PRINT_READY';
  assert.equal((await call('POST', url, { reason: 'short' }, 'coe')).status, 400);
  assert.equal((await call('POST', url, { reason: 'end of exam cycle 2026' }, 'admin')).status, 403);
  const ok = await call('POST', url, { reason: 'end of exam cycle 2026' }, 'coe');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const upd = log.find((l) => /UPDATE exam_papers SET paper_status = 'ARCHIVED'/.test(l.text));
  assert.equal(upd.params[3], 'PRINT_READY', 'conditional on the status that was checked');
  for (const st of ['VALIDATION_PENDING', 'VALIDATED', 'COE_APPROVED', 'ARCHIVED']) {
    paper.paper_status = st;
    assert.equal((await call('POST', url, { reason: 'end of exam cycle 2026' }, 'coe')).status, 409, st);
  }
});

// ---- legacy HOD/Admin paper workflow is retired ----
test('legacy approval, candidate selection and paper editing return 410', async () => {
  assert.equal((await call('POST', '/review/papers/x/hod-approve', { hod_password: 'x' }, 'hod')).status, 410);
  assert.equal((await call('POST', '/review/papers/x/admin-approve', { admin_password: 'x', totp_code: '1' }, 'admin')).status, 410);
  assert.equal((await call('POST', '/review/papers/x/lock', null, 'admin')).status, 410);
  assert.equal((await call('POST', '/papers/candidates/x/select', {}, 'hod')).status, 410);
  assert.equal((await call('POST', '/papers/blueprints', {}, 'hod')).status, 410);
  assert.equal((await call('PATCH', '/papers/x', { instructions: 'x' }, 'hod')).status, 410);
});
test('legacy paper reads: HOD in scope (user_scopes) only, from snapshots, never examination papers, never admin', async () => {
  installWorld();
  const P1 = '9d000000-0000-0000-0000-0000000000a1';
  let row = { id: P1, examination_id: null, campus_id: IDS.campusA, department_id: IDS.dept, status: 'locked' };
  sql(/FROM exam_papers ep\s+LEFT JOIN course_offerings co/i, () => [row]);
  sql(/FROM paper_questions pq LEFT JOIN questions q ON q.id = pq.question_id WHERE pq.paper_id/i, [
    { question_id: 'q1', question_text_snapshot: 'Snapshot wording', marks_snapshot: 5, metadata_snapshot: { question_type: 'short_answer', difficulty: 'easy', reconstructed: true, reconstructed_at: '2026-10-22T00:00:00Z' } },
    { question_id: 'q2', question_text_snapshot: null, marks_snapshot: null, metadata_snapshot: null }]);
  const r = await call('GET', `/papers/${P1}`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.questions[0].question_text, 'Snapshot wording'); assert.equal(r.data.questions[0].reconstructed, true);
  assert.equal(r.data.questions[1].snapshot_missing, true);
  const q = log.find((l) => /FROM paper_questions pq/.test(l.text));
  assert.doesNotMatch(q.text, /(?<![a-z])q\.(question_text|option_|correct_answer|marks|model_answer)/, 'no live question content is read');
  for (const who of ['hodA2', 'hodB']) assert.equal((await call('GET', `/papers/${P1}`, null, who)).status, 404, who);
  assert.equal((await call('GET', `/papers/${P1}/pdf`, null, 'hodB')).status, 404);
  row = { ...row, department_id: IDS.deptA2 };
  assert.equal((await call('GET', `/papers/${P1}`, null, 'hod')).status, 404, 'another department of the same campus');
  assert.equal((await call('GET', `/papers/${P1}`, null, 'hodA2')).status, 200);
  row = { ...row, department_id: IDS.dept, examination_id: 'ex1' };
  assert.equal((await call('GET', `/papers/${P1}`, null, 'hod')).status, 404, 'examination papers belong to the COE');
  assert.equal((await call('GET', '/papers/not-a-uuid', null, 'hod')).status, 404);
  for (const who of ['admin', 'coe', 'teacher']) assert.equal((await call('GET', `/papers/${P1}`, null, who)).status, 403, who);
  sql(/FROM exam_papers ep JOIN course_offerings co ON co.id = ep.course_offering_id JOIN programs p/i, []);
  assert.equal((await call('GET', '/papers', null, 'hod')).status, 200);
  const list = log.findLast((l) => /FROM exam_papers ep JOIN course_offerings co ON co.id = ep.course_offering_id/.test(l.text));
  assert.ok(list.text.includes(SCOPE_SQL.replace(/\s+/g, ' ').trim())); assert.deepEqual(list.params, [USERS.hod.id, 'hod']);
  assert.doesNotMatch(list.text, /department_id = \$1/);
});

// ---- validation policy (spec §27 configurable) ----
test('validation policy: admin-only, 3..4, reason required, audited with old/new', async () => {
  sql(/INSERT INTO system_state/i, []);
  const url = '/admin/settings/validation-policy';
  assert.equal((await call('GET', url, null, 'admin')).data.required_approvals, 4);
  assert.equal((await call('PUT', url, { required_approvals: 2, reason: 'policy decision 2026' }, 'admin')).status, 400);
  assert.equal((await call('PUT', url, { required_approvals: 3 }, 'admin')).status, 400);
  assert.equal((await call('PUT', url, { required_approvals: 3, reason: 'policy decision 2026' }, 'coe')).status, 403);
  assert.equal((await call('PUT', url, { required_approvals: 3, reason: 'policy decision 2026' }, 'admin')).status, 200);
});

// ---- admin ----
test('admin: technical overview, scopes and override; others denied', async () => {
  sql(/FROM users GROUP BY role/i, [{ role: 'coe', n: 1, active: 1 }]);
  sql(/FROM questions GROUP BY question_status/i, []); sql(/FROM exam_papers GROUP BY paper_status/i, []);
  sql(/FROM schema_migrations/i, [{ n: 36 }]); sql(/FROM authorization_log/i, []); sql(/FROM admin_overrides/i, []);
  sql(/SELECT scan_status, COUNT\(\*\)::int AS n FROM question_attachments GROUP BY 1/i, [{ scan_status: 'clean', n: 3 }, { scan_status: 'failed', n: 1 }]);
  const sys = await call('GET', '/admin/system', null, 'admin');
  assert.equal(sys.status, 200);
  assert.deepEqual(sys.data.attachments, [{ scan_status: 'clean', n: 3 }, { scan_status: 'failed', n: 1 }], 'upload scan counts (no names)');
  assert.equal(sys.data.readiness.checks.database, 'ok'); assert.ok(sys.data.readiness.protections.upload_scanning);
  for (const who of ['hod', 'coe', 'reviewer', 'teacher', 'v1']) assert.equal((await call('GET', '/admin/system', null, who)).status, 403, who);

  sql(/INSERT INTO user_scopes/i, [{ id: 's1' }]); sql(/FROM user_scopes\s+WHERE user_id/i, []);
  sql(/FROM campuses WHERE id = \$1 AND is_active/i, (p) => ([IDS.campusA, IDS.campusB].includes(p[0]) ? [{ id: p[0] }] : []));
  sql(/FROM departments WHERE id = \$1 AND is_active/i, (p) => (p[0] === IDS.dept ? [{ id: IDS.dept, campus_id: IDS.campusA }] : p[0] === IDS.deptB ? [{ id: IDS.deptB, campus_id: IDS.campusB }] : []));
  sql(/FROM programs WHERE id = \$1 AND is_active/i, (p) => (p[0] === IDS.prog ? [{ id: IDS.prog, department_id: IDS.dept, campus_id: IDS.campusA }] : []));
  const body = { user_id: USERS.coe.id, role: 'coe', campus_id: IDS.campusA, program_id: IDS.prog };
  assert.equal((await call('POST', '/admin/scopes', body, 'admin')).status, 200);
  const ins = log.filter((l) => /^INSERT INTO user_scopes/.test(l.text)).pop();
  assert.equal(ins.params[6], USERS.admin.id, 'granted_by recorded');
  assert.equal((await call('POST', '/admin/scopes', { ...body, role: 'hod' }, 'admin')).status, 400, 'role must match user role');
  assert.equal((await call('POST', '/admin/scopes', { ...body, campus_id: undefined }, 'admin')).status, 400);
  assert.equal((await call('POST', '/admin/scopes', { ...body, campus_id: IDS.campusB }, 'admin')).status, 400, 'program of another campus');
  assert.equal((await call('POST', '/admin/scopes', { ...body, department_id: IDS.deptB, program_id: undefined }, 'admin')).status, 400, 'department of another campus');
  assert.equal((await call('POST', '/admin/scopes', { user_id: USERS.teacher.id, role: 'teacher', campus_id: IDS.campusA, department_id: IDS.dept }, 'admin')).status, 400,
    'teacher scopes come only from assignments');
  assert.equal((await call('POST', '/admin/scopes', body, 'hod')).status, 403);
  // Review issue: a program-limited HOD scope was accepted but every HOD check matches the whole department.
  log.length = 0;
  const hodProg = await call('POST', '/admin/scopes', { user_id: USERS.hod.id, role: 'hod', campus_id: IDS.campusA, department_id: IDS.dept, program_id: IDS.prog }, 'admin');
  assert.equal(hodProg.status, 400); assert.match(hodProg.data.error, /whole department/);
  assert.equal(log.some((l) => /^INSERT INTO user_scopes/.test(l.text)), false);
  assert.equal((await call('POST', '/admin/scopes', { user_id: USERS.hod.id, role: 'hod', campus_id: IDS.campusA, department_id: IDS.dept }, 'admin')).status, 200, 'department-level HOD scope');
  USERS.coe.is_active = false;
  try { assert.equal((await call('POST', '/admin/scopes', body, 'admin')).status, 409, 'inactive account'); } finally { USERS.coe.is_active = true; }

  const S1 = '5c000000-0000-0000-0000-0000000000f1';
  sql(/SELECT \* FROM user_scopes WHERE id = \$1/i, (p) => (p[0] === S1 ? [{ id: S1, user_id: USERS.coe.id, role: 'coe' }] : []));
  sql(/^UPDATE user_scopes SET is_active = FALSE, revoked_at/i, (p) => [{ id: p[0] }]);
  const del = await fetch(`http://localhost:${process.env.PORT}/api/admin/scopes/${S1}`, { method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor('admin')}` }, body: JSON.stringify({ reason: 'left the exam cell' }) });
  assert.equal(del.status, 200);
  const rev = log.filter((l) => /^UPDATE user_scopes SET is_active = FALSE, revoked_at/.test(l.text)).pop();
  assert.deepEqual(rev.params, [S1, USERS.admin.id, 'left the exam cell'], 'revoked_by and reason recorded');
  const audit = log.filter((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'scope_revoked').pop();
  assert.equal(JSON.parse(audit.params[4]).reason, 'left the exam cell');
  assert.equal((await call('DELETE', '/admin/scopes/nope', null, 'admin')).status, 404);
  // Review issue: revoking a teacher scope replied ok while the teacher kept working (teacher access comes from the
  // HOD's assignments). Refused with the real path; nothing revoked, nothing audited as revoked.
  const T1 = '5c000000-0000-0000-0000-0000000000f2';
  sql(/SELECT \* FROM user_scopes WHERE id = \$1/i, (p) => (p[0] === T1 ? [{ id: T1, user_id: USERS.teacher.id, role: 'teacher', course_offering_id: IDS.off }] : []));
  log.length = 0;
  const t = await call('DELETE', `/admin/scopes/${T1}`, null, 'admin');
  assert.equal(t.status, 409); assert.match(t.data.error, /course assignments/);
  assert.equal(log.some((l) => /^UPDATE user_scopes/.test(l.text)), false);
  assert.equal(log.some((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'scope_revoked'), false);
});
test('admin override: reason required, never touches PRINT_READY, ends the round instead of deleting, audited', async () => {
  const st = { s: 'VALIDATION_PENDING', locked: 'VALIDATION_PENDING' };
  sql(/SELECT id, paper_status FROM exam_papers WHERE id = \$1$/i, () => [{ id: PAPER, paper_status: st.s }]);
  sql(/SELECT id, paper_status FROM exam_papers WHERE id = \$1 FOR UPDATE/i, () => [{ id: PAPER, paper_status: st.locked }]);
  const ended = [{ id: 'a1', validator_id: USERS.v1.id, validator_number: 1, decision: 'APPROVE', validation_round: 1 }];
  sql(/UPDATE paper_validator_assignments SET is_active = FALSE/i, () => ended);
  sql(/INSERT INTO admin_overrides/i, []); sql(/set_config\('app.paper_override'/i, []);
  sql(/SELECT ep.paper_version, e.exam_type, s.subject_code/i, [{ paper_version: 1, exam_type: 'end_term', subject_code: 'CS101' }]);
  sql(/SELECT DISTINCT u.id FROM users u JOIN exam_papers ep/i, [{ id: USERS.coe.id }]);
  const url = '/admin/overrides/reset-paper';
  assert.equal((await call('POST', url, { paper_id: PAPER, reason: 'short' }, 'admin')).status, 400);
  assert.equal((await call('POST', url, { paper_id: PAPER, reason: 'validators left the university' }, 'coe')).status, 403);
  const ok = await call('POST', url, { paper_id: PAPER, reason: 'validators left the university' }, 'admin');
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.paper_status, 'GENERATED');
  assert.equal(log.some((l) => /DELETE FROM paper_validator_assignments/.test(l.text)), false, 'decisions are history, never deleted');
  const end = log.find((l) => /UPDATE paper_validator_assignments SET is_active = FALSE/.test(l.text));
  assert.match(end.text, /deactivation_reason = 'paper_reset'/); assert.equal(end.params[2], 'validators left the university');
  const at = (re) => log.findIndex((l) => re.test(l.text));
  assert.ok(at(/set_config/) < at(/FOR UPDATE/) && at(/FOR UPDATE/) < at(/UPDATE paper_validator_assignments/) && at(/UPDATE paper_validator_assignments/) < at(/UPDATE exam_papers SET paper_status = 'GENERATED'/),
    'override flag, status re-check under the row lock, end the round, then reset');
  const ov = log.find((l) => /INSERT INTO admin_overrides/.test(l.text));
  assert.equal(JSON.parse(ov.params[3]).paper_status, 'VALIDATION_PENDING');
  assert.deepEqual(JSON.parse(ov.params[3]).ended_assignments.map((a) => a.id), ['a1']);
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.v1.id && l.params[1] === 'validation_ended'));
  st.s = 'PRINT_READY';
  assert.equal((await call('POST', url, { paper_id: PAPER, reason: 'validators left the university' }, 'admin')).status, 409);
  st.s = 'VALIDATED'; st.locked = 'PRINT_READY'; log.length = 0; // printed by a concurrent COE action
  assert.equal((await call('POST', url, { paper_id: PAPER, reason: 'validators left the university' }, 'admin')).status, 409, 'status re-checked inside the transaction');
  assert.equal(log.some((l) => /UPDATE exam_papers SET paper_status = 'GENERATED'|INSERT INTO admin_overrides/.test(l.text)), false);
});

// ---- COE send-back (039) ----
test('send-back: VALIDATED / VALIDATION_PENDING -> CHANGES_REQUIRED with a recorded reason; validators told', async () => {
  const url = `/coe/papers/${PAPER}/send-back`;
  let locked = 'VALIDATED';
  sql(/SELECT id, paper_status FROM exam_papers WHERE id = \$1 FOR UPDATE/i, () => [{ id: PAPER, paper_status: locked }]);
  sql(/SELECT id FROM paper_issues WHERE paper_id = \$1 AND status = 'open'/i, [{ id: 'i1' }]);
  sql(/INSERT INTO paper_send_backs/i, []);
  sql(/SELECT validator_id FROM paper_validator_assignments WHERE paper_id = \$1 AND is_active/i, [{ validator_id: USERS.v1.id }, { validator_id: USERS.v2.id }]);
  sql(/SELECT ep.paper_version, e.exam_type, s.subject_code/i, [{ paper_version: 1, exam_type: 'end_term', subject_code: 'CS101' }]);
  assert.equal((await call('POST', url, { reason: 'short' }, 'coe')).status, 400);
  for (const who of ['v1', 'hod', 'admin']) assert.equal((await call('POST', url, { reason: 'Q3 has a wrong model answer' }, who)).status, 403, who);
  for (const st of ['VALIDATED', 'VALIDATION_PENDING']) {
    locked = st; log.length = 0;
    const r = await call('POST', url, { reason: 'Q3 has a wrong model answer' }, 'coe');
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.paper_status, 'CHANGES_REQUIRED');
    const at = (re) => log.findIndex((l) => re.test(l.text));
    assert.ok(at(/FOR UPDATE/) < at(/INSERT INTO paper_send_backs/) && at(/INSERT INTO paper_send_backs/) < at(/UPDATE exam_papers SET paper_status = 'CHANGES_REQUIRED' WHERE id = \$1 AND paper_status = \$2/), 'record first, then the conditional update');
    const ins = log.find((l) => /INSERT INTO paper_send_backs/.test(l.text));
    assert.deepEqual(ins.params, [PAPER, st, 'Q3 has a wrong model answer', ['i1'], USERS.coe.id]);
    const a = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'paper_sent_back');
    assert.deepEqual(JSON.parse(a.params[4]), { from: st, to: 'CHANGES_REQUIRED', reason: 'Q3 has a wrong model answer', open_issue_ids: ['i1'] });
    assert.ok(at(/UPDATE exam_papers SET paper_status = 'CHANGES_REQUIRED'/) < log.indexOf(a) && log.indexOf(a) < at(/INSERT INTO notifications/),
      'audited inside the transaction, after the change, before the notifications');
    assert.equal(log.filter((l) => /INSERT INTO notifications/.test(l.text) && l.params[1] === 'paper_sent_back').length, 2);
  }
  for (const st of ['COE_APPROVED', 'GENERATED', 'PRINT_READY']) {
    locked = st;
    assert.equal((await call('POST', url, { reason: 'Q3 has a wrong model answer' }, 'coe')).status, 409, st);
  }
  locked = 'VALIDATED';
  sql(/UPDATE exam_papers/i, () => []);
  assert.equal((await call('POST', url, { reason: 'Q3 has a wrong model answer' }, 'coe')).status, 409, 'stale status');
  sql(/UPDATE exam_papers/i, () => { throw new Error('A VALIDATED paper returns to CHANGES_REQUIRED only through a recorded COE send-back with a reason'); });
  const db = await call('POST', url, { reason: 'Q3 has a wrong model answer' }, 'coe');
  assert.equal(db.status, 400); assert.match(db.data.error, /recorded COE send-back/);
});
test('COE approval: the DB refusal for open issues reaches the COE readably', async () => {
  sql(/UPDATE exam_papers/i, () => { throw new Error('Open validator issues must be resolved before COE approval'); });
  const r = await call('POST', `/coe/papers/${PAPER}/coe-approve`, { totp_code: authenticator.generate(SECRET) }, 'coe');
  assert.equal(r.status, 400); assert.match(r.data.error, /Open validator issues/);
});
test('archive: an archived pre-print revision tells its ended validators', async () => {
  paper.paper_status = 'CHANGES_REQUIRED';
  sql(/SELECT DISTINCT validator_id FROM paper_validator_assignments WHERE paper_id = \$1 AND deactivation_reason = \$2/i, (p) => (p[1] === 'paper_archived' ? [{ validator_id: USERS.v3.id }] : []));
  sql(/SELECT ep.paper_version, e.exam_type, s.subject_code/i, [{ paper_version: 2, exam_type: 'end_term', subject_code: 'CS101' }]);
  const r = await call('POST', `/coe/papers/${PAPER}/archive`, { reason: 'superseded by a new exam plan' }, 'coe');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.v3.id && l.params[1] === 'validation_ended'));
});

test('analytics: HOD and reviewer, each within their own scope (SCOPE_SQL; a reviewer only for assigned offerings)', async () => {
  installWorld();
  sql(/FROM questions q JOIN course_offerings co/i, []);
  sql(/COUNT\(\*\) FILTER \(WHERE q.times_used = 0\)/i, [{ never_used: 2, used_last_180_days: 1, active_total: 3 }]);
  sql(/pending_candidates/i, [{ pending_candidates: 0 }]);
  const ok = await call('GET', '/question-bank/analytics', null, 'hod');
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.usage.never_used, 2);
  assert.deepEqual(ok.data.scope, { role: 'hod', course_offering_id: null });
  const qs = log.filter((l) => /FROM questions q JOIN course_offerings co/.test(l.text));
  assert.equal(qs.length, 13);
  // CO, unit and topic figures and both matrices are grouped by offering (equal codes of two offerings never merge).
  for (const l of qs.filter((x) => /oc.code|su.code|st.title/.test(x.text))) assert.match(l.text, /co.id AS offering_id, co.offering_code/, l.text);
  assert.ok(qs.some((l) => /qco.verified_by IS NOT NULL/.test(l.text)) && qs.some((l) => /cq.verified_bloom_level IS NOT NULL/.test(l.text)), 'verified vs unverified');
  // 042: subtopic coverage (verified / unverified), generation readiness, and CO rows of the question's own version only.
  assert.ok(qs.some((l) => /cq.verified_syllabus_subtopic_id IS NULL/.test(l.text) && /LEFT JOIN syllabus_subtopics qst ON qst.id = q.subtopic_id/.test(l.text)), 'subtopic coverage');
  assert.ok(qs.some((l) => /question_has_verified_mapping\(q.id\) AND q.syllabus_version_id = co.syllabus_version_id\)::int AS generation_eligible/.test(l.text)), 'generation readiness');
  for (const l of qs.filter((x) => /JOIN question_course_outcomes qco/.test(x.text))) assert.match(l.text, /oc.syllabus_version_id = q.syllabus_version_id/);
  assert.ok(Array.isArray(ok.data.active_by_subtopic) && ok.data.generation_readiness, 'response keys');
  for (const l of qs) {
    assert.ok(l.text.includes(SCOPE_SQL.replace(/\s+/g, ' ').trim()), l.text); assert.doesNotMatch(l.text, /campus_id = ANY/);
    assert.deepEqual(l.params, [USERS.hod.id, 'hod', null]);
  }
  log.length = 0;
  assert.equal((await call('GET', '/question-bank/analytics', null, 'reviewer')).status, 200);
  for (const l of log.filter((x) => /FROM questions q JOIN course_offerings co/.test(x.text))) {
    assert.match(l.text, /EXISTS \(SELECT 1 FROM reviewer_assignments ra WHERE ra.reviewer_id = \$1 AND ra.course_offering_id = q.course_offering_id AND ra.is_active\)/);
  }
  const q = (who, off) => call('GET', `/question-bank/analytics?course_offering_id=${off}`, null, who).then((x) => x.status);
  assert.equal(await q('hod', IDS.off), 200);
  assert.equal(await q('hod', IDS.offA2), 403, 'another department of the same campus');
  assert.equal(await q('hodA2', IDS.offA2), 200);
  assert.equal(await q('hod', IDS.offB), 403, 'another campus');
  const deny = log.findLast((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[1] === 'view_analytics' && l.params[4] === 'deny');
  assert.ok(deny, 'out-of-scope analytics requests are logged');
  assert.equal(await q('reviewer', IDS.off), 200);
  assert.equal(await q('reviewerA2', IDS.off), 403, 'not assigned / out of scope');
  log.length = 0;
  assert.equal(await q('hod', 'not-a-uuid'), 400);
  assert.equal(log.some((l) => /FROM questions/.test(l.text)), false, 'no query for a malformed id');
  for (const who of ['teacher', 'coe', 'admin', 'v1']) assert.equal((await call('GET', '/question-bank/analytics', null, who)).status, 403, who);
  sql(/SELECT DISTINCT campus_id FROM user_scopes/i, []);
  assert.equal((await call('GET', '/question-bank/analytics', null, 'hod')).status, 403, 'no scope at all');
});

// ---- bulk upload ----
async function upload(rows) {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Q');
  const fd = new FormData();
  fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'q.xlsx'); fd.append('course_offering_id', IDS.off);
  const r = await fetch(`http://localhost:${process.env.PORT}/api/bulk-upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor('teacher')}` }, body: fd });
  return { status: r.status, data: await r.json() };
}
function scriptBulk() {
  sql(/FROM teacher_course_assignments tca/i, [{ course_offering_id: IDS.off, section_id: null, subject_id: IDS.subj }]);
  sql(/SELECT syllabus_version_id FROM course_offerings/i, [{ syllabus_version_id: IDS.sv }]);
  sql(/FROM course_outcomes/i, [{ code: 'CO1' }, { code: 'CO2' }]);
  sql(/FROM syllabus_topics/i, [{ title: 'Trees' }]);
  sql(/SELECT id FROM questions WHERE course_offering_id = \$1 AND question_hash/i, (p) => (p[1] === normalizeQuestionHash('a dupe of an existing one') ? [{ id: 'x' }] : []));
  sql(/INSERT INTO bulk_upload_batches/i, [{ id: 'batch1' }]);
  // classifyAgainstBank (dedup.js): exact-hash and nearest-embedding candidates
  sql(/FROM questions WHERE course_offering_id = \$1 AND question_hash = \$2 AND id != \$3/i, []);
  sql(/embedding <=> \$4::vector/i, []);
}
test('bulk upload: row-level errors (CO, Bloom, topic, MCQ, marks); nothing imported yet', async () => {
  scriptBulk();
  const good = { question_text: 'Explain AVL tree rotations in detail', difficulty: 'easy', marks: 2, bloom_level: 'apply', co: 'CO1', topic: 'Trees', model_answer: 'long enough answer' };
  const r = await upload([good,
    { ...good, question_text: 'Row invalid co', co: 'CO9' },
    { ...good, question_text: 'Row missing bloom', bloom_level: '' },
    { ...good, question_text: 'Row topic not in syllabus', topic: 'Quantum' },
    { ...good, question_text: 'Row mcq without options', question_type: 'objective' },
    { ...good, question_text: 'Row bad marks', marks: -1 }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.valid_rows, 1); assert.equal(r.data.error_rows, 5);
  const flat = JSON.stringify(r.data.errors);
  for (const m of [/invalid CO 'CO9'/, /missing bloom_level/, /not in syllabus/, /objective question needs/, /marks must be/]) assert.match(flat, m);
  assert.deepEqual(r.data.errors.map((e) => e.row), [3, 4, 5, 6, 7], 'row numbers match the spreadsheet');
  assert.equal(log.some((l) => /INSERT INTO questions/.test(l.text)), false);
  assert.equal(r.data.needs_confirmation, true);
});
test('bulk upload: duplicates within file and against the bank are flagged', async () => {
  scriptBulk();
  const base = { question_text: 'Same question text here', difficulty: 'easy', marks: 2, bloom_level: 'apply', co: 'CO1', topic: 'Trees', model_answer: 'long enough answer' };
  const r = await upload([base, base, { ...base, question_text: 'a dupe of an existing one' }]);
  const flat = JSON.stringify(r.data.errors);
  assert.match(flat, /duplicate question within this file/); assert.match(flat, /duplicate candidate/);
});
// Scripts a confirm of `rows` (payload rows as validation stores them) and returns a handle on the batch state.
function scriptConfirm(rows, { syllabus = IDS.sv, payloadSyllabus = IDS.sv, cos = [{ id: 'co1', code: 'co1' }, { id: 'co2', code: 'co2' }] } = {}) {
  const st = { status: 'validated', n: 0 };
  const payload = { section_id: null, subject_id: IDS.subj, syllabus_version_id: payloadSyllabus, rows };
  sql(/SELECT \* FROM bulk_upload_batches WHERE id/i, () => [{ id: 'batch1', status: st.status, course_offering_id: IDS.off, payload }]);
  sql(/FROM teacher_course_assignments tca/i, [{ course_offering_id: IDS.off, section_id: null, subject_id: IDS.subj }]);
  sql(/SELECT syllabus_version_id FROM course_offerings WHERE id/i, [{ syllabus_version_id: syllabus }]);
  sql(/UPDATE bulk_upload_batches SET status = 'confirmed'/i, () => (st.status === 'validated' ? (st.status = 'confirmed', [{}]) : []));
  sql(/lower\(code\) = ANY/i, (p) => cos.filter((c) => p[1].includes(c.code)));
  sql(/FROM questions WHERE course_offering_id = \$1 AND question_hash = \$2 AND id != \$3/i, []);
  sql(/embedding <=> \$4::vector/i, []);
  sql(/INSERT INTO questions/i, (p) => [{ id: `newq${++st.n}`, subject_id: p[0], course_offering_id: p[1], submitted_by: p[3], question_type: p[4],
    question_text: p[5], model_answer: p[11], marks: p[15], question_hash: p[16], embedding: p[17], answer_data: p[24] ? JSON.parse(p[24]) : null, subtopic: p[14] }]);
  sql(/INSERT INTO canonical_questions/i, () => [{ id: `cq${st.n}` }]);
  sql(/INSERT INTO question_versions/i, () => [{ id: `qv${st.n}` }]);
  sql(/UPDATE canonical_questions/i, []);
  sql(/INSERT INTO canonical_answers/i, []);
  sql(/INSERT INTO question_canonicalization_events/i, []);
  sql(/UPDATE questions SET canonical_question_id/i, []);
  sql(/DELETE FROM question_course_outcomes/i, []);
  sql(/INSERT INTO question_course_outcomes/i, []);
  sql(/INSERT INTO question_relationships/i, (p) => [{ id: 'rel1', source_question_id: p[0], target_question_id: p[1], status: 'pending', classification: p[5] }]);
  return st;
}
const payloadRow = (over = {}) => ({ question_text: 'Explain AVL tree rotations', difficulty: 'easy', marks: 2, topic: 'Trees', model_answer: 'long enough answer',
  __hash: `h-${Math.random()}`, __type: 'descriptive', __bloom: 'apply', __cos: ['CO1'], __row: 2, ...over });
const auditActions = () => log.filter((l) => /INSERT INTO audit_log/.test(l.text)).map((l) => l.params[2]);

test('bulk confirm: creates SUBMITTED questions once, with canonical + bulk CO mapping; second confirm refused', async () => {
  scriptConfirm([payloadRow()]);
  const r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.submitted, 1); assert.equal(r.data.drafted, 0);
  const ins = log.find((l) => /INSERT INTO questions/.test(l.text));
  assert.equal(ins.params[22], 'SUBMITTED'); assert.equal(ins.params[21], false); assert.doesNotMatch(ins.text, /'ACTIVE'/);
  assert.equal(ins.params[20], IDS.sv, 'syllabus version from the validated payload');
  assert.ok(ins.params[17], 'embedding stored');
  assert.ok(log.some((l) => /INSERT INTO canonical_questions/.test(l.text)));
  const qco = log.find((l) => /INSERT INTO question_course_outcomes/.test(l.text));
  assert.deepEqual([qco.params[1], qco.params[2], qco.params[3], qco.params[4]], ['co1', 'primary', 'bulk', null]);
  assert.equal((await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher')).status, 409);
  assert.equal((await call('POST', '/bulk-upload/batch1/confirm', {}, 'hod')).status, 403);
});
test('bulk confirm: the validated subtopic id is stored; a pre-042 batch resolves it in the same version, or is refused', async () => {
  const SUB = '33330000-0000-0000-0000-0000000000ab';
  scriptConfirm([payloadRow({ __subtopic: 'Rotations', __subtopic_id: SUB })]);
  let r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let ins = log.find((l) => /INSERT INTO questions/.test(l.text));
  assert.match(ins.text, /answer_data, subtopic_id\)/); assert.equal(ins.params[25], SUB);
  baseRules(); log.length = 0;
  scriptConfirm([payloadRow({ __subtopic: 'Rotations' })]); // validated before 042: title only
  r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ins = log.find((l) => /INSERT INTO questions/.test(l.text));
  assert.equal(ins.params[25], PLACEMENT.subtopic, 'resolved under the row\'s topic in the payload\'s version');
  baseRules(); log.length = 0;
  scriptConfirm([payloadRow({ __subtopic: 'Hashing' })]);
  r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 409); assert.match(r.data.error, /Row 2: .*Upload the file again/);
  assert.equal(log.some((l) => /INSERT INTO questions/.test(l.text)), false);
});
test('bulk confirm: a valid row of every non-diagram type reaches canonical + bulk CO mapping (primary + secondary)', async () => {
  const types = ['mcq', 'true_false', 'assertion_reason', 'numerical', 'fill_blank', 'programming', 'case_study', 'short_answer', 'long_answer', 'derivation', 'proof', 'descriptive'];
  scriptConfirm(types.map((t, i) => payloadRow({ __type: t, __row: i + 2, question_text: `row ${t}`, __cos: ['CO1', 'CO2'] })));
  const r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.submitted, 12); assert.equal(r.data.drafted, 0);
  assert.equal(log.filter((l) => /INSERT INTO canonical_questions/.test(l.text)).length, 12);
  const qcos = log.filter((l) => /INSERT INTO question_course_outcomes/.test(l.text));
  assert.equal(qcos.length, 24);
  assert.ok(qcos.every((l) => l.params[3] === 'bulk' && l.params[4] === null), 'unverified bulk suggestions');
  assert.deepEqual(qcos.slice(0, 2).map((l) => [l.params[1], l.params[2]]), [['co1', 'primary'], ['co2', 'secondary']]);
  assert.ok(log.filter((l) => /INSERT INTO questions/.test(l.text)).every((l) => l.params[22] === 'SUBMITTED' && l.params[17]));
  const acts = auditActions();
  assert.equal(acts.filter((a) => a === 'question_bulk_imported').length, 12);
  assert.equal(acts.filter((a) => a === 'question_final_submit').length, 12);
});
test('bulk confirm: a diagram row is imported as a DRAFT with no canonical (the diagram is attached later)', async () => {
  scriptConfirm([payloadRow({ __type: 'diagram', question_text: 'Label the diagram parts' })]);
  const r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.drafted, 1); assert.deepEqual(r.data.drafts[0].reasons, ['needs_diagram']);
  const ins = log.find((l) => /INSERT INTO questions/.test(l.text));
  assert.equal(ins.params[22], 'DRAFT'); assert.equal(ins.params[21], true);
  assert.equal(log.some((l) => /INSERT INTO canonical_questions|INSERT INTO question_course_outcomes/.test(l.text)), false);
  assert.equal(log.some((l) => /embedding <=> \$4::vector|question_hash = \$2 AND id != \$3/.test(l.text)), false, 'no duplicate check for a draft diagram');
});
test('bulk confirm: a likely duplicate at confirm time becomes a DRAFT and the candidate is persisted', async () => {
  scriptConfirm([payloadRow()]);
  sql(/embedding <=> \$4::vector/i, (p) => [{ id: 't1', question_hash: 'other', embedding: p[3], _similarity: 0.95, question_type: 'descriptive', marks: 2,
    question_text: 'Explain AVL tree rotations please', model_answer: null }]);
  const r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.drafts[0].reasons, ['duplicate_candidate']);
  assert.equal(log.find((l) => /INSERT INTO questions/.test(l.text)).params[22], 'DRAFT');
  const rel = log.find((l) => /INSERT INTO question_relationships/.test(l.text));
  assert.equal(rel.params[0], 'newq1'); assert.equal(rel.params[1], 't1');
  assert.equal(log.some((l) => /INSERT INTO canonical_questions/.test(l.text)), false);
});
test('bulk confirm: syllabus changed since validation -> 409, nothing imported, refusal audited', async () => {
  scriptConfirm([payloadRow()], { syllabus: 'b0000000-0000-0000-0000-0000000000ff' });
  const r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 409); assert.match(r.data.error, /syllabus changed/);
  assert.equal(log.some((l) => /UPDATE bulk_upload_batches|INSERT INTO questions/.test(l.text)), false);
  assert.ok(auditActions().includes('bulk_upload_confirm_refused'));
  scriptConfirm([payloadRow()], { payloadSyllabus: null });
  assert.equal((await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher')).status, 409, 'payload validated before this change has no syllabus id');
});
test('bulk confirm: a CO deactivated since validation -> 409', async () => {
  scriptConfirm([payloadRow({ __cos: ['CO1', 'CO2'] })], { cos: [{ id: 'co1', code: 'co1' }] });
  const r = await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher');
  assert.equal(r.status, 409); assert.match(r.data.error, /CO2/);
});
test('bulk confirm: a teacher no longer assigned -> 403 before the batch is claimed', async () => {
  scriptConfirm([payloadRow()]);
  sql(/FROM teacher_course_assignments tca/i, []);
  assert.equal((await call('POST', '/bulk-upload/batch1/confirm', {}, 'teacher')).status, 403);
  assert.equal(log.some((l) => /UPDATE bulk_upload_batches/.test(l.text)), false);
});
const goodRow = { question_text: 'Explain AVL tree rotations in detail', difficulty: 'easy', marks: 2, bloom_level: 'apply', co: 'CO1', topic: 'Trees', model_answer: 'long enough answer' };
test('bulk upload: subtopic validated against the topic\'s subtopics, stored with the syllabus spelling', async () => {
  scriptBulk();
  sql(/FROM syllabus_subtopics/i, [{ topic: 'Trees', title: 'Rotations', id: '33330000-0000-0000-0000-0000000000aa' }]);
  const r = await upload([{ ...goodRow, subtopic: 'rotations' }, { ...goodRow, question_text: 'Row bad subtopic', subtopic: 'Hashing' },
    { ...goodRow, question_text: 'Row bad topic and subtopic', topic: 'Quantum', subtopic: 'Rotations' },
    { ...goodRow, question_text: 'Row long subtopic', subtopic: 'x'.repeat(201) }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.valid_rows, 1);
  const flat = JSON.stringify(r.data.errors);
  assert.match(flat, /subtopic 'Hashing' is not under topic 'Trees'/); assert.match(flat, /exceeds 200/);
  const quantum = r.data.errors.find((e) => e.row === 4);
  assert.deepEqual(quantum.errors, ["topic 'Quantum' not in syllabus"], 'only the topic error when the topic is wrong');
  const batchIns = log.find((l) => /INSERT INTO bulk_upload_batches/.test(l.text));
  assert.equal(JSON.parse(batchIns.params[7]).rows[0].__subtopic, 'Rotations');
  assert.equal(JSON.parse(batchIns.params[7]).rows[0].__subtopic_id, '33330000-0000-0000-0000-0000000000aa', 'the subtopic id is kept for confirm (042)');
  assert.equal(JSON.parse(batchIns.params[7]).syllabus_version_id, IDS.sv);
  log.length = 0;
  await upload([goodRow]);
  assert.equal(log.some((l) => /FROM syllabus_subtopics/.test(l.text)), false, 'no subtopic query without a subtopic column');
});
test('bulk upload: malformed answer_data JSON is a row error', async () => {
  scriptBulk();
  const r = await upload([{ ...goodRow, answer_data: '{not json' }]);
  assert.match(JSON.stringify(r.data.errors), /answer_data is not a valid JSON object/);
});
test('bulk upload: diagram rows, activation gaps and likely duplicates are warnings, not errors', async () => {
  scriptBulk();
  sql(/embedding <=> \$4::vector/i, (p) => (p[0] === IDS.off ? [{ id: 't1', question_hash: 'other', embedding: p[3], _similarity: 0.95, question_type: 'mcq', marks: 2,
    question_text: 'similar', model_answer: null }] : []));
  const r = await upload([{ ...goodRow, question_type: 'diagram', question_text: 'Label the diagram parts', bloom_level: 'understand' },
    { ...goodRow, question_type: 'mcq', question_text: 'Which rotation fixes LL?', option_a: 'Right', option_b: 'Left', option_c: 'Both', option_d: 'None', correct_answer: 'A', model_answer: '' }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.valid_rows, 2, JSON.stringify(r.data.errors));
  const w = JSON.stringify(r.data.warnings);
  assert.match(w, /attach the diagram/i); assert.match(w, /before ACTIVE:.*model answer/); assert.match(w, /possible duplicate/);
});

// ---- reviewer assignment guard ----
test('reviewer assignment is HOD-only (admin and teacher denied)', async () => {
  const b = { reviewer_id: USERS.reviewer.id, course_offering_id: IDS.off };
  assert.equal((await call('POST', '/academic/assignments/reviewer', b, 'admin')).status, 403);
  assert.equal((await call('POST', '/academic/assignments/reviewer', b, 'teacher')).status, 403);
});

// ---- legacy question decisions are retired (spec §2, §7) ----
test('legacy HOD escalation decision is retired (410) for every role and writes nothing', async () => {
  for (const who of ['hod', 'admin', 'reviewer', 'teacher']) {
    const r = await call('POST', '/questions/q1/review', { decision: 'approved' }, who);
    assert.equal(r.status, 410, who); assert.match(r.data.error, /retired/);
  }
  assert.equal((await call('POST', '/question-bank/q1/review', { decision: 'rejected', reason: 'x' }, 'hod')).status, 410);
  // nothing scripted for questions: the mock throws on any unscripted SQL, so nothing was even read
  assert.equal(log.some((l) => /questions|INSERT INTO notifications/.test(l.text)), false);
  assert.equal((await call('POST', '/questions/q1/review', { decision: 'approved' })).status, 401);
});
test('legacy reviewer queue and verdict are retired (410)', async () => {
  assert.equal((await call('GET', '/questions/reviewer-queue', null, 'reviewer')).status, 410);
  assert.equal((await call('POST', '/questions/q1/reviewer-verdict', { verdict: 'needs_hod_attention', comment: 'x' }, 'reviewer')).status, 410);
  assert.equal(log.some((l) => /INSERT INTO reviewer_verdicts|UPDATE questions/.test(l.text)), false);
});

// ---- AI review is advisory (spec §39 inv. 10) ----
const aiRow = (over = {}) => ({ id: 'q1', submitted_by: USERS.teacher.id, question_status: 'SUBMITTED', question_type: 'descriptive',
  question_text: 'Explain  the binary search tree.', course_offering_id: IDS.off, topic: 'Trees', question_hash: 'h', embedding: null, ...over });
function scriptAi(row) {
  sql(/SELECT \* FROM questions WHERE id = \$1 AND submitted_by = \$2/i, () => (row ? [row] : []));
  sql(/question_hash = \$2 AND id != \$3/i, []);
  sql(/SELECT topic, COUNT/i, []);
  sql(/FROM question_attachments WHERE question_id = \$1/i, [{ attachment_count: 0, diagram_image_count: 0 }]);
  sql(/UPDATE questions SET ai_review_notes/i, () => [{ id: 'q1' }]);
}
const setClause = (text) => text.slice(text.indexOf(' SET '), text.indexOf(' WHERE '));
test('AI review stores findings only, never status', async () => {
  scriptAi(aiRow());
  const r = await call('POST', '/ai-review/q1', null, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.advisory, true); assert.equal(r.data.outcome, 'issues_found'); assert.equal('status' in r.data, false);
  const upd = log.find((l) => /UPDATE questions SET ai_review_notes/.test(l.text));
  assert.doesNotMatch(setClause(upd.text), /\bstatus\b|question_status|is_draft/);
  assert.match(upd.text, /question_status = \$4/); assert.equal(upd.params[3], 'SUBMITTED');
  assert.match(log.find((l) => /SELECT topic, COUNT/.test(l.text)).text, /question_status IN \('APPROVED','ACTIVE'\)/);
  assert.equal(log.some((l) => /UPDATE questions SET (status|question_status|is_draft)/.test(l.text)), false);
});
test('AI review is refused outside the author-side states; allowed in DRAFT, CHANGES_REQUESTED and RESUBMITTED', async () => {
  for (const st of ['UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'RETIRED', 'REJECTED']) {
    baseRules(); scriptAi(aiRow({ question_status: st }));
    const r = await call('POST', '/ai-review/q1', null, 'teacher');
    assert.equal(r.status, 409, st); assert.equal(r.data.question_status, st);
    assert.equal(log.some((l) => /UPDATE questions/.test(l.text)), false, `${st}: nothing written (an ACTIVE question stays ACTIVE and locked)`);
  }
  for (const st of ['DRAFT', 'CHANGES_REQUESTED', 'RESUBMITTED']) {
    baseRules(); scriptAi(aiRow({ question_status: st }));
    assert.equal((await call('POST', '/ai-review/q1', null, 'teacher')).status, 200, st);
  }
});
test('AI review: not own -> 404, other roles -> 403, concurrent transition -> 409 with no audit', async () => {
  scriptAi(null);
  assert.equal((await call('POST', '/ai-review/q1', null, 'teacher')).status, 404);
  for (const who of ['hod', 'reviewer', 'admin']) assert.equal((await call('POST', '/ai-review/q1', null, who)).status, 403, who);
  baseRules(); scriptAi(aiRow());
  sql(/UPDATE questions SET ai_review_notes/i, []);
  const r = await call('POST', '/ai-review/q1', null, 'teacher');
  assert.equal(r.status, 409); assert.match(r.data.error, /changed state/);
  assert.equal(auditActions().includes('ai_review_completed'), false);
});
function scriptDispute(row) {
  sql(/SELECT id, course_offering_id, question_status, ai_review_notes, ai_review_dispute FROM questions/i, () => (row ? [row] : []));
  sql(/UPDATE questions SET ai_review_dispute/i, () => [{ id: 'q1' }]);
  sql(/JOIN user_scopes s ON s.user_id = u.id AND s.role = 'hod'/i, [{ id: USERS.hod.id }]);
}
const disputeRow = (over = {}) => ({ id: 'q1', course_offering_id: IDS.off, question_status: 'SUBMITTED',
  ai_review_notes: JSON.stringify([{ type: 'clarity', detail: 'x' }]), ai_review_dispute: null, ...over });
test('AI dispute is advisory: a note + HOD notification, no status change', async () => {
  scriptDispute(disputeRow());
  const r = await call('POST', '/ai-review/q1/appeal', { reason: 'The wording is intentional' }, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.notified, 1);
  const upd = log.find((l) => /UPDATE questions SET ai_review_dispute/.test(l.text));
  assert.doesNotMatch(setClause(upd.text), /\bstatus\b|question_status|is_draft/);
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.hod.id));
  assert.ok(auditActions().includes('ai_review_disputed'));
});
test('AI dispute: reason, state, findings, once, ownership and role are all checked', async () => {
  scriptDispute(disputeRow());
  for (const body of [{}, { reason: 'ab' }, { reason: 'x'.repeat(2001) }]) {
    assert.equal((await call('POST', '/ai-review/q1/appeal', body, 'teacher')).status, 400);
  }
  assert.equal(log.some((l) => /FROM questions/.test(l.text)), false, 'no DB read for an invalid reason');
  for (const st of ['DRAFT', 'APPROVED', 'ACTIVE', 'CHANGES_REQUESTED']) {
    baseRules(); scriptDispute(disputeRow({ question_status: st }));
    assert.equal((await call('POST', '/ai-review/q1/appeal', { reason: 'I disagree' }, 'teacher')).status, 409, st);
  }
  for (const notes of ['[]', null, '{bad']) {
    baseRules(); scriptDispute(disputeRow({ ai_review_notes: notes }));
    assert.equal((await call('POST', '/ai-review/q1/appeal', { reason: 'I disagree' }, 'teacher')).status, 409, String(notes));
  }
  baseRules(); scriptDispute(disputeRow({ ai_review_dispute: 'earlier' }));
  assert.equal((await call('POST', '/ai-review/q1/appeal', { reason: 'I disagree' }, 'teacher')).status, 409);
  baseRules(); scriptDispute(disputeRow()); sql(/UPDATE questions SET ai_review_dispute/i, []);
  assert.equal((await call('POST', '/ai-review/q1/appeal', { reason: 'I disagree' }, 'teacher')).status, 409);
  baseRules(); scriptDispute(null);
  assert.equal((await call('POST', '/ai-review/q1/appeal', { reason: 'I disagree' }, 'teacher')).status, 404);
  for (const who of ['hod', 'reviewer']) assert.equal((await call('POST', '/ai-review/q1/appeal', { reason: 'I disagree' }, who)).status, 403, who);
});
test('HOD attention list is read-only, HOD-only and scope-filtered', async () => {
  for (const who of ['admin', 'reviewer', 'teacher']) assert.equal((await call('GET', '/questions/queue', null, who)).status, 403, who);
  sql(/FROM questions q JOIN users u .*ai_review_dispute/i, [{ id: 'q1', question_status: 'SUBMITTED' }]);
  const r = await call('GET', '/questions/queue', null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const q = log.find((l) => /FROM questions q JOIN users u/.test(l.text));
  assert.match(q.text, /user_scopes/); assert.match(q.text, /q.question_status IN \('SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW'\)/);
  assert.match(q.text, /LIMIT 200/); assert.doesNotMatch(q.text, /q\.\*/);
  assert.deepEqual(q.params, [USERS.hod.id, 'hod']);
});

// ---- attachments change only while the question is editable ----
const QID = '9a000000-0000-0000-0000-0000000000f1';
const ATT = '9e000000-0000-0000-0000-0000000000f1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function attach(questionId = QID) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'd.png');
  const r = await fetch(`http://localhost:${process.env.PORT}/api/attachments/${questionId}`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor('teacher')}` }, body: fd });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const UPLOADS = new URL('../uploads/', import.meta.url);
test('attachment upload is refused unless the question is DRAFT or CHANGES_REQUESTED', async () => {
  let st = 'SUBMITTED';
  sql(/SELECT id, question_status, question_type FROM questions WHERE id = \$1 AND submitted_by/i, () => (st ? [{ id: QID, question_status: st }] : []));
  for (const s2 of ['SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED', 'APPROVED', 'ACTIVE', 'RETIRED', 'REJECTED']) {
    st = s2;
    assert.equal((await attach()).status, 409, s2);
  }
  assert.equal(log.some((l) => /INSERT INTO question_attachments/.test(l.text)), false);
  st = null;
  assert.equal((await attach()).status, 404, 'someone else\'s question');
  assert.equal((await attach('q1')).status, 404, 'malformed id: 404, never a 500 from the uuid cast');
});
test('attachment upload accepted while CHANGES_REQUESTED; the insert is conditional on the state', async () => {
  sql(/SELECT id, question_status, question_type FROM questions WHERE id = \$1 AND submitted_by/i, [{ id: QID, question_status: 'CHANGES_REQUESTED' }]);
  sql(/COUNT\(\*\)::int as c FROM question_attachments/i, [{ c: 0 }]);
  sql(/INSERT INTO question_attachments/i, [{ id: ATT }]);
  sql(/UPDATE question_attachments SET file_path/i, []);
  try {
    const r = await attach();
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.scan_status, 'failed', 'no scanner configured: fail-closed');
    const upd = log.find((l) => /UPDATE question_attachments SET file_path/.test(l.text));
    assert.equal(upd.params[0], `quarantine/${ATT}.png`, 'an unscanned file goes to quarantine');
    assert.ok(fs.existsSync(new URL(`quarantine/${ATT}.png`, UPLOADS)));
    const ins = log.find((l) => /INSERT INTO question_attachments/.test(l.text));
    assert.match(ins.text, /WHERE EXISTS/); assert.match(ins.text, /IN \('DRAFT', 'CHANGES_REQUESTED'\)/);
    sql(/INSERT INTO question_attachments/i, []);
    const late = await attach();
    assert.equal(late.status, 409); assert.match(late.data.error, /submitted while the file was being scanned/);
  } finally {
    try { fs.unlinkSync(new URL(`quarantine/${ATT}.png`, UPLOADS)); } catch { /* not written */ }
  }
});
test('attachment delete is refused unless the question is editable; the row goes before the file', async () => {
  let row = { id: ATT, question_id: QID, uploaded_by: USERS.teacher.id, question_owner: USERS.teacher.id, question_status: 'ACTIVE', file_path: '' };
  sql(/FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id/i, () => [row]);
  let deleted = [{ id: ATT }];
  sql(/DELETE FROM question_attachments/i, () => deleted);
  assert.equal((await call('DELETE', `/attachments/${ATT}`, null, 'teacher')).status, 409);
  assert.equal(log.some((l) => /DELETE FROM question_attachments/.test(l.text)), false);
  row = { ...row, question_status: 'DRAFT' };
  assert.equal((await call('DELETE', `/attachments/${ATT}`, null, 'teacher')).status, 200);
  assert.ok(auditActions().includes('attachment_deleted'));
  deleted = [];
  assert.equal((await call('DELETE', `/attachments/${ATT}`, null, 'teacher')).status, 409, 'state changed in between');
  row = { ...row, uploaded_by: 'someone-else' };
  assert.equal((await call('DELETE', `/attachments/${ATT}`, null, 'teacher')).status, 404);
});

test('bulk upload: no section given -> uses the teacher\'s assignment for that offering', async () => {
  scriptBulk();
  const fd = new FormData();
  fd.append('file', new Blob(['question_text,difficulty,marks\n']), 'q.csv');
  fd.append('course_offering_id', IDS.off);
  await fetch(`http://localhost:${process.env.PORT}/api/bulk-upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor('teacher')}` }, body: fd });
  const q = log.find((l) => /FROM teacher_course_assignments tca/.test(l.text));
  assert.ok(q, 'assignment looked up');
  assert.match(q.text, /\$3::uuid IS NULL OR tca.section_id IS NULL/);
  assert.equal(q.params[2], null);
});


// ---- question types (spec §8/§10), syllabus scope, admin policy ----
test('draft save: unknown type refused; type-specific data required; legacy names still accepted', async () => {
  const essay = await call('POST', '/questions/draft', { question_type: 'essay', question_text: 'Explain it', difficulty: 'easy', marks: 2 }, 'teacher');
  assert.equal(essay.status, 400); assert.ok(essay.data.details.some((d) => /question_type must be one of/.test(d)));
  const num = await call('POST', '/questions/draft', { question_type: 'numerical', question_text: 'How many?', difficulty: 'easy', marks: 2, answer_data: {} }, 'teacher');
  assert.equal(num.status, 400); assert.ok(num.data.details.some((d) => /expected_value/.test(d)));
  const fb = await call('POST', '/questions/draft', { question_type: 'fill_blank', question_text: 'A ___ and a ___', difficulty: 'easy', marks: 2, answer_data: { answers: ['x'] } }, 'teacher');
  assert.equal(fb.status, 400); assert.ok(fb.data.details.some((d) => /2 blank\(s\) but 1 answer/.test(d)));
});

test('syllabus content is HOD-only: admin cannot create/deactivate units, topics or subtopics', async () => {
  assert.equal((await call('POST', '/academic/units/u1/deactivate', null, 'admin')).status, 403);
  assert.equal((await call('POST', '/academic/topics/t1/deactivate', null, 'admin')).status, 403);
  assert.equal((await call('POST', '/academic/topics/t1/subtopics', { title: 'Rotations' }, 'admin')).status, 403);
  assert.equal((await call('POST', '/academic/topics/t1/subtopics', { title: '' }, 'hod')).status, 400);
});

test('validator independence policy: admin-only, boolean, reason required', async () => {
  sql(/INSERT INTO system_state/i, []);
  const url = '/admin/settings/validator-independence';
  assert.equal((await call('GET', url, null, 'admin')).data.exclude_question_reviewers, false);
  assert.equal((await call('PUT', url, { exclude_question_reviewers: 'yes', reason: 'Senate decision 2026' }, 'admin')).status, 400);
  assert.equal((await call('PUT', url, { exclude_question_reviewers: true }, 'admin')).status, 400);
  assert.equal((await call('PUT', url, { exclude_question_reviewers: true, reason: 'Senate decision 2026' }, 'coe')).status, 403);
  assert.equal((await call('PUT', url, { exclude_question_reviewers: true, reason: 'Senate decision 2026' }, 'admin')).status, 200);
});

// Review issue: attachment download had no scope (any HOD/reviewer, any campus; admin too).
test('attachment download: only clean files, never from quarantine; the author, assigned reviewers and in-scope HODs; never admin', async () => {
  const name = 'att-dl-test.png';
  fs.writeFileSync(new URL(name, UPLOADS), PNG);
  let att = { id: ATT, file_path: name, scan_status: 'clean', uploaded_by: USERS.teacher.id, question_id: QID, question_owner: USERS.teacher.id };
  sql(/FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id/i, () => [att]);
  let ctxRow = { id: QID, submitted_by: USERS.teacher.id, course_offering_id: IDS.off, campus_id: IDS.campusA, program_id: IDS.prog, department_id: IDS.dept };
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p/i, () => [ctxRow]);
  let assigned = [];
  sql(/SELECT id FROM reviewer_assignments WHERE course_offering_id/i, () => assigned);
  const get = async (who) => (await fetch(`http://localhost:${process.env.PORT}/api/attachments/${ATT}/file`, { headers: { Authorization: `Bearer ${tokenFor(who)}` } })).status;
  try {
    assert.equal(await get('teacher'), 200, 'author');
    for (const who of ['admin', 'coe', 'v1']) assert.equal(await get(who), 403, who);
    assert.equal(await get('reviewer'), 403, 'reviewer not assigned to the offering');
    assigned = [{ id: 'ra1' }];
    assert.equal(await get('reviewer'), 200, 'assigned reviewer');
    assert.equal(await get('hod'), 200, 'HOD in scope');
    sql(/user_has_scope/i, [{ has_scope: false }]);
    assert.equal(await get('hod'), 403, 'HOD of another campus/department');
    assert.equal(await get('reviewer'), 403, 'reviewer out of scope');
    sql(/user_has_scope/i, [{ has_scope: true }]);
    att = { ...att, scan_status: 'pending' };
    assert.equal(await get('hod'), 403, 'not scanned clean');
    const own = await fetch(`http://localhost:${process.env.PORT}/api/attachments/${ATT}/file`, { headers: { Authorization: `Bearer ${tokenFor('teacher')}` } });
    assert.equal(own.status, 409, 'not even the author opens an unscanned file');
    assert.equal((await own.json()).scan_status, 'pending');
    att = { ...att, scan_status: 'clean', file_path: `quarantine/${name}` };
    assert.equal(await get('teacher'), 404, 'a file under quarantine/ is never served, whatever the row says');
    att = { ...att, file_path: name };
    assert.equal((await fetch(`http://localhost:${process.env.PORT}/api/attachments/a1/file`, { headers: { Authorization: `Bearer ${tokenFor('teacher')}` } })).status, 404, 'malformed id');
    att = { ...att, question_owner: 'someone-else', uploaded_by: 'someone-else', scan_status: 'clean' };
    ctxRow = { ...ctxRow, submitted_by: 'someone-else' };
    assert.equal(await get('teacher'), 403, 'another teacher');
  } finally {
    try { fs.unlinkSync(new URL(name, UPLOADS)); } catch { /* already gone */ }
  }
});

// Syllabus approval and its targeted effect on questions (phase 4b, migration 042): test/syllabus.test.mjs.

// ---- audit chain (phase 2): appends serialised by an advisory lock; optionally inside the caller's transaction ----
test('logAudit without a transaction runs in its own and takes the chain lock before reading the last hash', async () => {
  const { logAudit } = await import('../src/audit.js');
  log.length = 0;
  await logAudit({ userId: USERS.coe.id, action: 'unit_check', entityId: 'x', details: { a: 1 }, ip: '::1' });
  const at = (re) => log.findIndex((l) => re.test(l.text));
  const lock = at(/pg_advisory_xact_lock/);
  assert.equal(log[lock].params[0], 'audit_log:chain');
  assert.ok(lock < at(/SELECT entry_hash FROM audit_log/) && at(/SELECT entry_hash FROM audit_log/) < at(/INSERT INTO audit_log/), 'lock, read the last hash, append');
});
test('logAudit(entry, txn) issues every statement on the caller\'s transaction', async () => {
  const { logAudit } = await import('../src/audit.js');
  log.length = 0;
  const calls = [];
  const rec = (kind) => async (text, params = []) => { calls.push({ kind, text: text.replace(/\s+/g, ' ').trim(), params }); return kind === 'run' ? { rowCount: 1, rows: [] } : (kind === 'get' ? null : []); };
  const txn = { get: rec('get'), all: rec('all'), run: rec('run') };
  await logAudit({ userId: null, action: 'unit_check', entityId: 'x', details: {}, ip: null }, txn);
  assert.deepEqual(calls.map((c) => c.text.slice(0, 30)), ['SELECT pg_advisory_xact_lock(h', 'SELECT entry_hash FROM audit_l', 'INSERT INTO audit_log (user_id']);
  assert.equal(calls[2].params[6], 'GENESIS');
  assert.equal(log.length, 0, 'nothing went through the pool');
});
test('admin reset never overturns a CHANGES_REQUIRED verdict (§36): refused from CHANGES_REQUIRED and over a recorded objection', async () => {
  let st = 'CHANGES_REQUIRED';
  sql(/SELECT id, paper_status FROM exam_papers WHERE id = \$1( FOR UPDATE)?$/i, () => [{ id: PAPER, paper_status: st }]);
  sql(/set_config\('app.paper_override'/i, []);
  const url = '/admin/overrides/reset-paper';
  const body = { paper_id: PAPER, reason: 'validators rejected it, admin tries anyway' };
  let r = await call('POST', url, body, 'admin');
  assert.equal(r.status, 409); assert.match(r.data.error, /not stuck.*regenerates it/);
  st = 'VALIDATION_PENDING';
  sql(/AND is_active AND decision = 'CHANGES_REQUIRED'/i, [{ n: 1 }]);
  log.length = 0;
  r = await call('POST', url, body, 'admin');
  assert.equal(r.status, 409); assert.match(r.data.error, /1 validator\(s\) already recorded CHANGES_REQUIRED/);
  assert.equal(log.some((l) => /UPDATE paper_validator_assignments|UPDATE exam_papers|INSERT INTO admin_overrides/.test(l.text)), false, 'nothing written');
});
test('admin reset: the audit row is written inside the reset transaction, as its last statement', async () => {
  sql(/SELECT id, paper_status FROM exam_papers WHERE id = \$1( FOR UPDATE)?$/i, () => [{ id: PAPER, paper_status: 'VALIDATED' }]);
  sql(/UPDATE paper_validator_assignments SET is_active = FALSE/i, []);
  sql(/INSERT INTO admin_overrides/i, []); sql(/set_config\('app.paper_override'/i, []);
  sql(/SELECT ep.paper_version, e.exam_type, s.subject_code/i, [{ paper_version: 1, exam_type: 'end_term', subject_code: 'CS101' }]);
  sql(/SELECT DISTINCT u.id FROM users u JOIN exam_papers ep/i, [{ id: USERS.coe.id }]);
  log.length = 0;
  const r = await call('POST', '/admin/overrides/reset-paper', { paper_id: PAPER, reason: 'validators left the university' }, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const audit = log.findIndex((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'technical_override_reset_paper');
  assert.ok(audit > log.findIndex((l) => /INSERT INTO admin_overrides/.test(l.text)), 'after the change it records');
  assert.equal(JSON.parse(log[audit].params[4]).from, 'VALIDATED');
});
