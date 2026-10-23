import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, log, baseRules, start, call, USERS, IDS } from './harness.mjs';

const EXAM = { id: 'ee000000-0000-0000-0000-000000000001', campus_id: IDS.campusA, program_id: IDS.prog, subject_id: IDS.subj, course_offering_id: IDS.off,
  syllabus_version_id: IDS.sv, exam_type: 'end_term', maximum_marks: 18, duration_minutes: 90 };
const PAPER = '99000000-0000-0000-0000-000000000001';
const BP_OTHER = 'b9000000-0000-0000-0000-0000000000ff'; // a blueprint version of ANOTHER examination
const OFFERING = { id: IDS.off, subject_id: IDS.subj, program_id: IDS.prog, academic_session_id: 's1', semester: 5, syllabus_version_id: IDS.sv, campus_id: IDS.campusA, college_id: 'col' };
// A COE whose scope does not cover the examination (another campus, or another program of the same campus):
// user_has_scope answers false for the 'coe' role only (checkScope passes the role as $2; list filters inline it).
const coeOutOfScope = () => sql(/user_has_scope/i, (p, t) => [{ has_scope: !(p[1] === 'coe' || /user_has_scope\(\$1, 'coe'/.test(t)) }]);
let n = 0;
const mkQ = (difficulty, marks, extra = {}) => ({ id: `q${++n}`, canonical_question_id: `cq${n}`, question_text: `Question number ${n}`, question_type: 'subjective', difficulty, marks,
  topic: `T${n % 3}`, model_answer: 'model answer', bloom: 'apply', cos: ['CO1'], question_status: 'ACTIVE', campus_id: IDS.campusA, program_id: IDS.prog, subject_id: IDS.subj,
  course_offering_id: IDS.off, syllabus_version_id: IDS.sv, times_used: 0, submitted_by: USERS.teacher.id, ...extra });
let pool, paperStatus, decided, svStatus, validationPassed, authors, reviewers, active, openIssues, livePapers, printedPapers, nextVersion, lockedStatus, coCodes;

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => {
  baseRules(); n = 0; paperStatus = 'GENERATED'; decided = 0; svStatus = 'hod_approved'; validationPassed = true;
  authors = [USERS.teacher.id]; reviewers = []; active = []; openIssues = []; livePapers = []; printedPapers = []; nextVersion = 1; lockedStatus = null; coCodes = ['CO1', 'CO2'];
  pool = [...Array(3)].map(() => mkQ('easy', 2)).concat([...Array(3)].map(() => mkQ('medium', 4)), [mkQ('hard', 6)]);
  sql(/FROM course_offerings co JOIN programs p ON p.id = co.program_id WHERE co.id/i, () => [OFFERING]);
  sql(/FROM syllabus_versions WHERE id = \$1 AND course_offering_id/i, () => [{ id: IDS.sv, approval_status: svStatus, status: svStatus === 'hod_approved' ? 'ACTIVE' : 'HOD_REVIEW' }]);
  sql(/INSERT INTO examinations/i, (p) => [{ id: EXAM.id, campus_id: p[0], exam_type: p[8] }]);
  sql(/FROM examinations e JOIN programs p ON p.id = e.program_id WHERE e.id/i, () => [EXAM]);
  sql(/FROM paper_blueprints WHERE examination_id/i, []);
  sql(/UPDATE paper_blueprints SET is_active/i, []);
  sql(/SELECT department_id FROM programs/i, [{ department_id: IDS.dept }]);
  sql(/INSERT INTO paper_blueprints/i, (p) => [{ id: 'bp1', version_number: p[11], total_marks: p[13] }]);
  // Blueprint lookups are scoped to the examination (regenerate IDOR fix): another examination's id finds nothing.
  sql(/FROM paper_blueprints WHERE id = \$1 AND examination_id/i, (p) => (p[1] === EXAM.id && p[0] !== BP_OTHER ? [{ id: p[0] || 'bp1', version_number: 1, easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 18, reuse_lookback_exams: 2 }] : []));
  sql(/FROM course_outcomes WHERE syllabus_version_id = \$1 AND is_active/i, () => coCodes.map((code) => ({ code })));
  sql(/SELECT id FROM examinations WHERE id = \$1 FOR NO KEY UPDATE/i, [{ id: EXAM.id }]);
  // Generation under the offering lock: lock_timeout, the one-live-paper check, the version computed under the lock.
  sql(/set_config\('lock_timeout'/i, []);
  sql(/paper_status = ANY\(\$2::text\[\]\) AND id IS DISTINCT FROM \$3::uuid/i, () => livePapers);
  sql(/COALESCE\(MAX\(paper_version\), 0\)::int \+ 1 AS v/i, () => [{ v: nextVersion }]);
  sql(/INSERT INTO paper_constraint_overrides/i, []);
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN canonical_questions cq/i, () => pool);
  sql(/FROM question_usage qu/i, []);
  sql(/INSERT INTO exam_papers/i, [{ id: PAPER }]);
  sql(/INSERT INTO paper_questions/i, []);
  sql(/FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id (JOIN programs pr ON pr.id = e.program_id )?WHERE ep.id/i, () => [{ id: PAPER, examination_id: EXAM.id, paper_status: paperStatus, campus_id: IDS.campusA, blueprint_version_id: 'bp1',
    generated_by: USERS.coe.id, candidate_metrics: { validation: { passed: validationPassed } } }]);
  // Paper row lock taken first by every validator/issue/regenerate transaction.
  sql(/FROM exam_papers WHERE id = \$1 FOR UPDATE/i, () => [{ id: PAPER, paper_status: lockedStatus ?? paperStatus, required_approvals: null, generated_by: USERS.coe.id,
    examination_id: EXAM.id, candidate_metrics: { validation: { passed: validationPassed } } }]);
  // Assignments (migration 039: rounds, ended instead of deleted) and the eligibility helper.
  sql(/SELECT id, validator_id, decision FROM paper_validator_assignments WHERE paper_id = \$1 AND is_active FOR UPDATE/i,
    () => (active.length ? active : [...Array(decided)].map((_, i) => ({ id: `a${i}`, validator_id: `x${i}`, decision: 'APPROVE' }))));
  sql(/UPDATE paper_validator_assignments SET is_active = FALSE/i, () => active.filter((a) => !a.decision).map((a) => ({ id: a.id, validator_id: a.validator_id })));
  sql(/MAX\(validation_round\)/i, [{ round: 1 }]);
  sql(/INSERT INTO paper_validator_assignments/i, () => [{ id: 'new-asg' }]);
  sql(/paper_question_authors/i, () => authors.map((a) => ({ author_id: a })));
  sql(/paper_question_reviewers/i, () => reviewers);
  sql(/FROM users WHERE id = \$1 FOR SHARE/i, (p) => [Object.values(USERS).find((u) => u.id === p[0])].filter(Boolean));
  sql(/FROM user_scopes WHERE user_id = \$1 AND role = 'validator' AND is_active FOR SHARE/i, []);
  sql(/UPDATE exam_papers SET/i, []);
  // Notifications (paper-notifications.js): label, the paper's COEs, ended assignments.
  sql(/SELECT ep.paper_version, e.exam_type, s.subject_code/i, [{ paper_version: 1, exam_type: 'end_term', subject_code: 'CS101' }]);
  sql(/SELECT DISTINCT u.id FROM users u JOIN exam_papers ep/i, [{ id: USERS.coe.id }]);
  sql(/SELECT DISTINCT validator_id FROM paper_validator_assignments WHERE paper_id = \$1 AND deactivation_reason/i, []);
  // Paper detail extras: blueprint targets, send-backs, my assignment.
  sql(/SELECT id, version_number, name, hard_targets, co_distribution, bloom_distribution FROM paper_blueprints/i, [{ id: 'bp1', version_number: 1, name: 'bp', hard_targets: true, co_distribution: null, bloom_distribution: null }]);
  sql(/FROM paper_send_backs/i, []);
  sql(/FROM paper_issues WHERE paper_id = \$1 AND status = 'open'/i, () => openIssues);
  sql(/FROM examinations e JOIN programs pr ON pr.id = e.program_id WHERE e.id/i, [{ campus_id: IDS.campusA, program_id: IDS.prog, exam_offering_id: IDS.off, department_id: IDS.dept }]);
  sql(/FROM exam_papers WHERE examination_id = \$1 AND paper_status = 'PRINT_READY'/i, () => printedPapers);
  // generation: per-offering advisory lock + reservations (migration 037)
  sql(/pg_advisory_xact_lock/i, []);
  sql(/^(INSERT INTO|UPDATE) question_reservations/i, []);
});

const body = { course_offering_id: IDS.off, exam_type: 'end_term', maximum_marks: 18, duration_minutes: 90 };

test('create examination derives campus/program/subject from the offering (client ids ignored)', async () => {
  const r = await call('POST', '/examinations', { ...body, campus_id: IDS.campusB, program_id: 'evil', subject_id: 'evil' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const ins = log.find((l) => /INSERT INTO examinations/.test(l.text));
  assert.equal(ins.params[0], IDS.campusA); assert.equal(ins.params[2], IDS.prog); assert.equal(ins.params[6], IDS.subj);
});
test('create examination: validation + guards', async () => {
  assert.equal((await call('POST', '/examinations', { ...body, exam_type: 'Mid-Term' }, 'coe')).status, 400);
  assert.equal((await call('POST', '/examinations', { ...body, maximum_marks: 0 }, 'coe')).status, 400);
  svStatus = 'pending';
  assert.equal((await call('POST', '/examinations', body, 'coe')).status, 400);
  svStatus = 'hod_approved';
  assert.equal((await call('POST', '/examinations', body, 'hod')).status, 403);
  assert.equal((await call('POST', '/examinations', body, 'admin')).status, 403);
  sql(/user_has_scope/i, [{ has_scope: false }]);
  const x = await call('POST', '/examinations', body, 'coe');
  assert.equal(x.status, 403);
});
// Spec §14, §39.5: new examinations use the offering's current syllabus version; a superseded one is refused.
test('create examination: only the offering\'s CURRENT syllabus version; a superseded or missing one is refused', async () => {
  const OLD = 'b0000000-0000-0000-0000-0000000000f0';
  let current = { effective_to: null };
  sql(/FROM syllabus_versions WHERE id = \$1 AND course_offering_id/i, (p) => [{ id: p[0], approval_status: 'hod_approved', status: p[0] === OLD ? 'SUPERSEDED' : 'ACTIVE', effective_to: p[0] === OLD ? '2026-01-01T00:00:00Z' : current.effective_to }]);
  const old = await call('POST', '/examinations', { ...body, syllabus_version_id: OLD }, 'coe');
  assert.equal(old.status, 400); assert.match(old.data.error, /superseded/); assert.equal(old.data.current_syllabus_version_id, IDS.sv);
  current = { effective_to: '2026-02-01T00:00:00Z' };
  const closed = await call('POST', '/examinations', body, 'coe');
  assert.equal(closed.status, 400, 'the current pointer with effective_to set is not current'); assert.match(closed.data.error, /superseded/);
  assert.equal((await call('POST', '/examinations', { ...body, syllabus_version_id: 'nope' }, 'coe')).status, 400);
  sql(/FROM course_offerings co JOIN programs p ON p.id = co.program_id WHERE co.id/i, () => [{ ...OFFERING, syllabus_version_id: null }]);
  const none = await call('POST', '/examinations', body, 'coe');
  assert.equal(none.status, 400); assert.match(none.data.error, /no HOD-approved syllabus version/);
  assert.equal(log.some((l) => /INSERT INTO examinations/.test(l.text)), false, 'nothing created');
  sql(/FROM course_offerings co JOIN programs p ON p.id = co.program_id WHERE co.id/i, () => [OFFERING]);
  current = { effective_to: null };
  assert.equal((await call('POST', '/examinations', body, 'coe')).status, 201);
  assert.equal((await call('POST', '/examinations', { ...body, course_offering_id: 'not-a-uuid' }, 'coe')).status, 404);
});
test('blueprint: versioned, validated, scoped', async () => {
  const ok = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1 }, 'coe');
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const ins = log.find((l) => /INSERT INTO paper_blueprints/.test(l.text));
  assert.equal(ins.params[11], 1); assert.equal(ins.params[13], 18, 'total_marks defaults to exam maximum');
  assert.equal((await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 0, medium_count: 0, hard_count: 0 }, 'coe')).status, 400);
  coeOutOfScope();
  assert.equal((await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 1 }, 'coe')).status, 403);
});
test('new blueprint supersedes the previous version', async () => {
  sql(/FROM paper_blueprints WHERE examination_id/i, [{ id: 'bp0', version_number: 3 }]);
  await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 1 }, 'coe');
  const ins = log.find((l) => /INSERT INTO paper_blueprints/.test(l.text));
  assert.equal(ins.params[11], 4); assert.equal(ins.params[12], 'bp0');
  assert.ok(log.some((l) => /UPDATE paper_blueprints SET is_active = FALSE/.test(l.text)));
});
test('generate: success stores seed/version/blueprint and numbers questions', async () => {
  const r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1', seed: 'abc' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.seed, 'abc'); assert.equal(r.data.validation.passed, true); assert.equal(r.data.validation.summary.total_marks, 18);
  const ins = log.find((l) => /INSERT INTO exam_papers/.test(l.text));
  assert.equal(ins.params[6], 'abc'); assert.equal(ins.params[8], 'bp1'); assert.match(ins.params[7], /coe-gen/);
  assert.deepEqual(log.filter((l) => /INSERT INTO paper_questions/.test(l.text)).map((l) => l.params[2]), [1, 2, 3, 4, 5]);
});
test('generate: same seed gives the same questions', async () => {
  const pick = async () => { log.length = 0; await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1', seed: 's1' }, 'coe'); return log.filter((l) => /INSERT INTO paper_questions/.test(l.text)).map((l) => l.params[1]); };
  assert.deepEqual(await pick(), await pick());
});
test('generate: fails with a clear reason and writes nothing when ACTIVE pool is short', async () => {
  pool = pool.filter((q) => q.difficulty !== 'hard');
  const r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  assert.equal(r.status, 422); assert.match(r.data.reasons.join(' '), /HARD/);
  assert.equal(log.some((l) => /INSERT INTO exam_papers/.test(l.text)), false);
});
test('generate: wrong-syllabus / non-ACTIVE rows can never be substituted even if the query returned them', async () => {
  pool = pool.filter((q) => q.difficulty !== 'hard').concat([mkQ('hard', 6, { syllabus_version_id: 'old' }), mkQ('hard', 6, { question_status: 'APPROVED' })]);
  const r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  assert.equal(r.status, 422, 'belt-and-braces validation must reject them');
  assert.equal(log.some((l) => /INSERT INTO exam_papers/.test(l.text)), false);
});
test('generate: HOD, reviewer, validator and admin cannot generate', async () => {
  for (const who of ['hod', 'reviewer', 'v1', 'admin', 'teacher']) {
    assert.equal((await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, who)).status, 403, who);
  }
  assert.equal((await call('POST', '/papers/generate', {}, 'hod')).status, 410);
});
test('generate: cross-campus COE is denied', async () => {
  sql(/user_has_scope/i, [{ has_scope: false }]);
  assert.equal((await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe')).status, 403);
});

const four = () => [USERS.v1.id, USERS.v2.id, USERS.v3.id, USERS.v4.id];
const V5 = '0000000a-0000-0000-0000-000000000000';
const ISSUE = '1ee00000-0000-0000-0000-000000000001';
const Q1 = '0e000000-0000-0000-0000-000000000001';
const audits = () => log.filter((l) => /INSERT INTO audit_log/.test(l.text)).map((l) => l.params[2]);
const notes = () => log.filter((l) => /INSERT INTO notifications/.test(l.text)).map((l) => ({ user: l.params[0], type: l.params[1], message: l.params[2] }));

test('validators: exactly 4 distinct; COE and authors rejected', async () => {
  const url = `/examinations/papers/${PAPER}/validators`;
  assert.equal((await call('POST', url, { validator_ids: four().slice(0, 3) }, 'coe')).status, 400);
  assert.equal((await call('POST', url, { validator_ids: [USERS.v1.id, USERS.v1.id, USERS.v2.id, USERS.v3.id] }, 'coe')).status, 400);
  const asCoe = await call('POST', url, { validator_ids: [USERS.coe.id, USERS.v2.id, USERS.v3.id, USERS.v4.id] }, 'coe');
  assert.equal(asCoe.status, 403); assert.match(asCoe.data.error, /COE/);
  const asAuthor = await call('POST', url, { validator_ids: [USERS.teacher.id, USERS.v2.id, USERS.v3.id, USERS.v4.id] }, 'coe');
  assert.equal(asAuthor.status, 403); assert.match(asAuthor.data.error, /author/i);
  authors = [USERS.v2.id];
  const realAuthor = await call('POST', url, { validator_ids: four() }, 'coe');
  assert.equal(realAuthor.status, 403); assert.equal(realAuthor.data.error, 'Validator 2: Validator cannot be an author of questions in the paper');
  assert.equal(log.some((l) => /INSERT INTO paper_validator_assignments/.test(l.text)), false);
});
test('validators: inactive or out-of-scope validator rejected', async () => {
  const url = `/examinations/papers/${PAPER}/validators`;
  USERS.v2.status = 'INACTIVE';
  const r = await call('POST', url, { validator_ids: four() }, 'coe');
  USERS.v2.status = 'ACTIVE';
  assert.equal(r.status, 403); assert.match(r.data.error, /not active/);
  USERS.v2.is_active = false;
  const r2 = await call('POST', url, { validator_ids: four() }, 'coe');
  USERS.v2.is_active = true;
  assert.equal(r2.status, 403, 'is_active=false alone (academic.js deactivation) also counts'); assert.match(r2.data.error, /Validator 2: Validator is not active/);
  sql(/user_has_scope/i, (p) => [{ has_scope: !(p[0] === USERS.v3.id && p[1] === 'validator') }]);
  assert.equal((await call('POST', url, { validator_ids: four() }, 'coe')).status, 403);
});
test('validators: success ends the previous round (never deletes) and inserts a new round of 4', async () => {
  active = [{ id: 'old1', validator_id: V5, decision: null }];
  const r = await call('POST', `/examinations/papers/${PAPER}/validators`, { validator_ids: four() }, 'coe');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.round, 1);
  const ins = log.filter((l) => /INSERT INTO paper_validator_assignments/.test(l.text));
  assert.equal(ins.length, 4); assert.deepEqual(ins.map((l) => l.params[2]), [1, 2, 3, 4]); assert.ok(ins.every((l) => l.params[4] === 1), 'round stored');
  assert.equal(log.some((l) => /DELETE FROM paper_validator_assignments/.test(l.text)), false, 'history is never deleted');
  const end = log.find((l) => /UPDATE paper_validator_assignments SET is_active = FALSE/.test(l.text));
  assert.match(end.text, /deactivation_reason = 'reassigned'/);
  assert.ok(log.some((l) => /UPDATE exam_papers SET paper_status = 'VALIDATION_PENDING'/.test(l.text)));
  const lockAt = log.findIndex((l) => /FROM exam_papers WHERE id = \$1 FOR UPDATE/.test(l.text));
  const checkAt = log.findIndex((l) => /FROM users WHERE id = \$1 FOR SHARE/.test(l.text));
  const insAt = log.findIndex((l) => /INSERT INTO paper_validator_assignments/.test(l.text));
  assert.ok(lockAt >= 0 && lockAt < checkAt && checkAt < insAt, 'paper row lock, then in-transaction eligibility, then inserts');
  const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'validators_assigned');
  assert.deepEqual(JSON.parse(audit.params[4]).ended_assignment_ids, ['old1']);
  const n = notes();
  assert.equal(n.filter((x) => x.type === 'validation_assigned').length, 4);
  assert.deepEqual(n.filter((x) => x.type === 'validation_unassigned').map((x) => x.user), [V5]);
});
test('validators: wrong status, failed automated validation, or started decisions block assignment', async () => {
  const url = `/examinations/papers/${PAPER}/validators`;
  paperStatus = 'VALIDATED'; assert.equal((await call('POST', url, { validator_ids: four() }, 'coe')).status, 409);
  paperStatus = 'GENERATED'; validationPassed = false; assert.equal((await call('POST', url, { validator_ids: four() }, 'coe')).status, 409);
  validationPassed = true; decided = 1; log.length = 0;
  const r = await call('POST', url, { validator_ids: four() }, 'coe');
  assert.equal(r.status, 409, 'a decided active row found inside the transaction'); assert.match(r.data.error, /replace an undecided validator/);
  assert.equal(log.some((l) => /INSERT INTO paper_validator_assignments|SET is_active = FALSE/.test(l.text)), false);
});
test('validators: cross-campus COE denied', async () => {
  coeOutOfScope();
  assert.equal((await call('POST', `/examinations/papers/${PAPER}/validators`, { validator_ids: four() }, 'coe')).status, 403);
});
test('validators: a concurrent change (unique index) gives 409, not 500', async () => {
  sql(/INSERT INTO paper_validator_assignments/i, () => { throw Object.assign(new Error('duplicate key value violates unique constraint "uq_pva_active_slot"'), { code: '23505' }); });
  const r = await call('POST', `/examinations/papers/${PAPER}/validators`, { validator_ids: four() }, 'coe');
  assert.equal(r.status, 409, JSON.stringify(r.data));
});
test('validators: optional policy blocks a validator who reviewed a question in the paper', async () => {
  const url = `/examinations/papers/${PAPER}/validators`;
  sql(/validator_excludes_question_reviewers/i, [{ value: 'true' }]);
  reviewers = [{ reviewer_id: USERS.v3.id, source: 'review round decision' }];
  const r = await call('POST', url, { validator_ids: four() }, 'coe');
  assert.equal(r.status, 403); assert.match(r.data.error, /Validator 3: Validator reviewed a question in this paper \(review round decision\)/);
  sql(/validator_excludes_question_reviewers/i, [{ value: 'false' }]);
  assert.equal((await call('POST', url, { validator_ids: four() }, 'coe')).status, 200, 'policy off: allowed');
});
test('validator candidates for a paper list conflicts; out-of-scope COE denied; plain list unchanged', async () => {
  sql(/validator_excludes_question_reviewers/i, [{ value: 'true' }]);
  sql(/WITH a AS \(SELECT author_id FROM paper_question_authors/i, () => [
    { id: USERS.v1.id, full_name: 'V1', email: 'v1@t.edu', role: 'validator', status: 'ACTIVE', is_active: true, has_scope: true, is_author: false, reviewer_sources: [], assigned_as: 1 },
    { id: USERS.v2.id, full_name: 'V2', email: 'v2@t.edu', role: 'validator', status: 'ACTIVE', is_active: true, has_scope: true, is_author: true, reviewer_sources: ['reviewer verdict'], assigned_as: null },
    { id: USERS.v3.id, full_name: 'V3', email: 'v3@t.edu', role: 'validator', status: 'INACTIVE', is_active: false, has_scope: true, is_author: false, reviewer_sources: [], assigned_as: null },
  ]);
  const r = await call('GET', `/examinations/validators?paper_id=${PAPER}`, null, 'coe');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data[0].conflicts, []); assert.equal(r.data[0].assigned_as, 1);
  assert.deepEqual(r.data[1].conflicts, ['Validator cannot be an author of questions in the paper',
    'Validator reviewed a question in this paper (reviewer verdict); institutional policy requires independent validators']);
  assert.deepEqual(r.data[2].conflicts, ['Validator is not active']);
  sql(/SELECT DISTINCT u.id, u.full_name, u.email FROM users u JOIN user_scopes/i, [{ id: USERS.v1.id, full_name: 'V1', email: 'v1@t.edu' }]);
  const plain = await call('GET', '/examinations/validators', null, 'coe');
  assert.deepEqual(Object.keys(plain.data[0]).sort(), ['email', 'full_name', 'id']);
  coeOutOfScope();
  assert.equal((await call('GET', `/examinations/validators?paper_id=${PAPER}`, null, 'coe')).status, 403);
});

// ---- single-validator replacement ----
function scriptSlot(slot) {
  sql(/SELECT \* FROM paper_validator_assignments WHERE paper_id = \$1 AND validator_number = \$2 AND is_active FOR UPDATE/i, () => (slot ? [slot] : []));
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id = \$1 AND validator_id = \$2 AND is_active$/i, []);
  sql(/UPDATE paper_validator_assignments SET is_active = FALSE, deactivated_by = \$2, deactivation_reason = 'replaced'/i, () => [{ id: slot?.id }]);
}
const REPLACE = `/examinations/papers/${PAPER}/validators/4/replace`;
const replaceBody = { validator_id: V5, reason: 'validator 4 left the university' };
test('replace: input, role and scope checks', async () => {
  paperStatus = 'VALIDATION_PENDING';
  USERS.v5 = { ...USERS.v1, id: V5, email: 'validator10@t.edu' };
  scriptSlot({ id: 'asg4', validator_id: USERS.v4.id, validator_number: 4, validation_round: 2, decision: null });
  assert.equal((await call('POST', REPLACE, { ...replaceBody, reason: 'short' }, 'coe')).status, 400);
  assert.equal((await call('POST', `/examinations/papers/${PAPER}/validators/5/replace`, replaceBody, 'coe')).status, 400);
  assert.equal((await call('POST', `/examinations/papers/${PAPER}/validators/x/replace`, replaceBody, 'coe')).status, 400);
  for (const who of ['hod', 'v1', 'admin']) assert.equal((await call('POST', REPLACE, replaceBody, who)).status, 403, who);
  coeOutOfScope();
  assert.equal((await call('POST', REPLACE, replaceBody, 'coe')).status, 403, 'cross-campus COE');
  delete USERS.v5;
});
test('replace: state and slot rules', async () => {
  USERS.v5 = { ...USERS.v1, id: V5, email: 'validator10@t.edu' };
  paperStatus = 'VALIDATED';
  scriptSlot({ id: 'asg4', validator_id: USERS.v4.id, validator_number: 4, validation_round: 1, decision: null });
  assert.equal((await call('POST', REPLACE, replaceBody, 'coe')).status, 409, 'not while VALIDATED');
  paperStatus = 'VALIDATION_PENDING';
  scriptSlot(null);
  assert.equal((await call('POST', REPLACE, replaceBody, 'coe')).status, 404, 'empty slot');
  scriptSlot({ id: 'asg4', validator_id: USERS.v4.id, validator_number: 4, validation_round: 1, decision: 'APPROVE' });
  const decidedSlot = await call('POST', REPLACE, replaceBody, 'coe');
  assert.equal(decidedSlot.status, 409); assert.match(decidedSlot.data.error, /never replaced.*send the paper back/);
  scriptSlot({ id: 'asg4', validator_id: V5, validator_number: 4, validation_round: 1, decision: null });
  assert.equal((await call('POST', REPLACE, replaceBody, 'coe')).status, 400, 'same validator');
  scriptSlot({ id: 'asg4', validator_id: USERS.v4.id, validator_number: 4, validation_round: 1, decision: null });
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id = \$1 AND validator_id = \$2 AND is_active$/i, [{ x: 1 }]);
  assert.equal((await call('POST', REPLACE, replaceBody, 'coe')).status, 409, 'already active on the paper');
  delete USERS.v5;
});
test('replace: the new validator must pass every eligibility rule', async () => {
  paperStatus = 'VALIDATION_PENDING';
  scriptSlot({ id: 'asg4', validator_id: USERS.v4.id, validator_number: 4, validation_round: 1, decision: null });
  const r1 = await call('POST', REPLACE, { ...replaceBody, validator_id: USERS.teacher.id }, 'coe');
  assert.equal(r1.status, 403); assert.match(r1.data.error, /author/);
  const r2 = await call('POST', REPLACE, { ...replaceBody, validator_id: USERS.coe.id }, 'coe');
  assert.equal(r2.status, 403); assert.match(r2.data.error, /COE cannot be a validator/);
  sql(/user_has_scope/i, (p) => [{ has_scope: p[0] !== USERS.v1.id }]);
  const r3 = await call('POST', REPLACE, { ...replaceBody, validator_id: USERS.v1.id }, 'coe');
  assert.equal(r3.status, 403); assert.match(r3.data.error, /scope/);
  sql(/user_has_scope/i, [{ has_scope: true }]);
  sql(/validator_excludes_question_reviewers/i, [{ value: 'true' }]);
  reviewers = [{ reviewer_id: USERS.v1.id, source: 'approved the question' }];
  const r4 = await call('POST', REPLACE, { ...replaceBody, validator_id: USERS.v1.id }, 'coe');
  assert.equal(r4.status, 403); assert.match(r4.data.error, /reviewed a question/);
  assert.equal(log.some((l) => /INSERT INTO paper_validator_assignments/.test(l.text)), false);
});
test('replace: success ends only that slot, keeps number and round, links back, audits and notifies both', async () => {
  paperStatus = 'VALIDATION_PENDING';
  USERS.v5 = { ...USERS.v1, id: V5, email: 'validator10@t.edu' };
  scriptSlot({ id: 'asg4', validator_id: USERS.v4.id, validator_number: 4, validation_round: 2, decision: null });
  const r = await call('POST', REPLACE, replaceBody, 'coe');
  delete USERS.v5;
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.assignment_id, 'new-asg');
  const ends = log.filter((l) => /UPDATE paper_validator_assignments/.test(l.text));
  assert.equal(ends.length, 1, 'no other assignment is touched');
  assert.deepEqual(ends[0].params, ['asg4', USERS.coe.id, replaceBody.reason]);
  const ins = log.find((l) => /INSERT INTO paper_validator_assignments/.test(l.text));
  assert.deepEqual(ins.params, [PAPER, V5, 4, USERS.coe.id, 2, 'asg4']);
  const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'validator_replaced');
  const d = JSON.parse(audit.params[4]);
  assert.equal(d.old_validator_id, USERS.v4.id); assert.equal(d.new_validator_id, V5); assert.equal(d.reason, replaceBody.reason); assert.equal(d.round, 2);
  const n = notes();
  assert.ok(n.some((x) => x.user === V5 && x.type === 'validation_assigned'));
  assert.ok(n.some((x) => x.user === USERS.v4.id && x.type === 'validation_unassigned'));
});
test('replace: a unique-index race gives 409', async () => {
  paperStatus = 'VALIDATION_PENDING';
  USERS.v5 = { ...USERS.v1, id: V5, email: 'validator10@t.edu' };
  scriptSlot({ id: 'asg4', validator_id: USERS.v4.id, validator_number: 4, validation_round: 1, decision: null });
  sql(/INSERT INTO paper_validator_assignments/i, () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); });
  const r = await call('POST', REPLACE, replaceBody, 'coe');
  delete USERS.v5;
  assert.equal(r.status, 409);
});
test('GET validators: undecided rows carry problems; ?history=1 adds ended rows', async () => {
  paperStatus = 'VALIDATION_PENDING';
  const rows = [
    { assignment_id: 'a1', validator_number: 1, validator_id: USERS.v1.id, decision: 'APPROVE', is_active: true },
    { assignment_id: 'a2', validator_number: 2, validator_id: USERS.v2.id, decision: null, is_active: true },
  ];
  sql(/FROM paper_validator_assignments pva JOIN users u ON u.id = pva.validator_id LEFT JOIN users db/i, (p) => (p[1] ? [...rows, { assignment_id: 'a0', validator_number: 2, validator_id: V5, is_active: false, deactivation_reason: 'replaced' }] : rows));
  sql(/SELECT DISTINCT assigned_by FROM paper_validator_assignments/i, [{ assigned_by: USERS.coe.id }]);
  sql(/user_has_scope/i, (p) => [{ has_scope: p[0] !== USERS.v2.id }]);
  const r = await call('GET', `/examinations/papers/${PAPER}/validators`, null, 'coe');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data[0].problems, [], 'decided rows are never flagged');
  assert.deepEqual(r.data[1].problems, ['Validator does not have required scope']);
  const h = await call('GET', `/examinations/papers/${PAPER}/validators?history=1`, null, 'coe');
  assert.equal(h.data.length, 3); assert.equal(h.data[2].deactivation_reason, 'replaced');
  assert.equal((await call('GET', `/examinations/papers/${PAPER}/validators`, null, 'v1')).status, 403);
});

// ---- validator decisions ----
const CHECK = Object.fromEntries(['question_correctness', 'syllabus_relevance', 'co_mapping_correct', 'bloom_levels_correct', 'difficulty_appropriate', 'marks_distribution_ok', 'formatting_ok', 'numbering_correct', 'spelling_grammar_ok', 'instructions_clear', 'layout_acceptable'].map((k) => [k, true]));
let decisions;
function scriptValidation(assignedTo = USERS.v1.id) {
  paperStatus = 'VALIDATION_PENDING';
  decisions = [{ decision: null }, { decision: null }, { decision: null }, { decision: null }];
  sql(/SELECT id FROM paper_validator_assignments WHERE paper_id = \$1 AND validator_id = \$2 AND is_active = true/i, (p) => (p[1] === assignedTo ? [{ id: 'asg' }] : []));
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id/i, (p) => (p[1] === assignedTo ? [{ x: 1 }] : []));
  sql(/SELECT id, decision, assigned_by FROM paper_validator_assignments/i, () => [{ id: 'asg', decision: null, assigned_by: USERS.coe.id }]);
  sql(/UPDATE paper_validator_assignments SET decision/i, [{ id: 'asg' }]);
  sql(/INSERT INTO paper_validation_reviews/i, []);
  sql(/SELECT decision FROM paper_validator_assignments WHERE paper_id = \$1 AND is_active/i, () => decisions);
}
const VALIDATE = `/validators/papers/${PAPER}/validate`;
test('validate: needs full checklist to approve, comments to request changes', async () => {
  scriptValidation();
  assert.equal((await call('POST', VALIDATE, { decision: 'APPROVE', checklist: { ...CHECK, layout_acceptable: false } }, 'v1')).status, 400);
  assert.equal((await call('POST', VALIDATE, { decision: 'CHANGES_REQUIRED' }, 'v1')).status, 400);
  assert.equal((await call('POST', VALIDATE, { decision: 'MAYBE' }, 'v1')).status, 400);
});
test('validate: unassigned validator, wrong roles denied', async () => {
  scriptValidation();
  assert.equal((await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, 'v2')).status, 403);
  for (const who of ['coe', 'hod', 'admin', 'teacher']) assert.equal((await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, who)).status, 403, who);
});
test('validate: an assignment ended meanwhile gives 403 (no crash) and writes nothing', async () => {
  scriptValidation();
  sql(/SELECT id, decision, assigned_by FROM paper_validator_assignments/i, []);
  const r = await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, 'v1');
  assert.equal(r.status, 403); assert.equal(r.data.error, 'You are no longer assigned to this paper');
  assert.equal(log.some((l) => /UPDATE paper_validator_assignments SET decision|INSERT INTO paper_validation_reviews/.test(l.text)), false);
});
for (const [name, setup, re] of [
  ['lost scope', () => sql(/SELECT user_has_scope\(\$1, \$2, \$3, \$4, \$5, \$6\)/i, (p) => [{ has_scope: p[0] !== USERS.v1.id }]), /required scope/],
  ['account INACTIVE', () => { USERS.v1.status = 'INACTIVE'; }, /not active/],
  ['independence policy turned on', () => { sql(/validator_excludes_question_reviewers/i, [{ value: 'true' }]); reviewers = [{ reviewer_id: USERS.v1.id, source: 'review round decision' }]; }, /reviewed a question/],
]) {
  test(`validate: re-checked at decision time (${name}) -> 403, nothing written, refusal audited, COE told`, async () => {
    scriptValidation();
    setup();
    const r = await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, 'v1');
    USERS.v1.status = 'ACTIVE';
    assert.equal(r.status, 403, JSON.stringify(r.data)); assert.match(r.data.error, re); assert.match(r.data.error, /COE has been asked to replace you/);
    assert.equal(log.some((l) => /UPDATE paper_validator_assignments SET decision|INSERT INTO paper_validation_reviews|UPDATE exam_papers/.test(l.text)), false);
    assert.ok(audits().includes('paper_validation_refused'));
    assert.ok(notes().some((x) => x.user === USERS.coe.id && x.type === 'validator_needs_replacement'));
    const lockAt = log.findIndex((l) => /FROM exam_papers WHERE id = \$1 FOR UPDATE/.test(l.text));
    const mineAt = log.findIndex((l) => /SELECT id, decision, assigned_by FROM paper_validator_assignments .* FOR UPDATE/.test(l.text));
    const userAt = log.findIndex((l) => /FROM users WHERE id = \$1 FOR SHARE/.test(l.text));
    assert.ok(lockAt < mineAt && mineAt < userAt, 'lock order: paper, assignment, user');
  });
}
test('validate: a decision is recorded against its assignment; one approval does not finish; fourth => VALIDATED and the COE is told', async () => {
  scriptValidation();
  let r = await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, 'v1');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.all_decided, false);
  const rev = log.find((l) => /INSERT INTO paper_validation_reviews/.test(l.text));
  assert.match(rev.text, /\(paper_id, validator_id, assignment_id,/); assert.equal(rev.params[2], 'asg');
  assert.match(log.find((l) => /UPDATE paper_validator_assignments SET decision/.test(l.text)).text, /AND is_active AND decision IS NULL/);
  assert.equal(notes().some((x) => x.type === 'paper_validation_outcome'), false);
  decisions = [{ decision: 'APPROVE' }, { decision: 'APPROVE' }, { decision: 'APPROVE' }, { decision: 'APPROVE' }];
  r = await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, 'v1');
  assert.equal(r.data.all_approved, true);
  assert.ok(log.some((l) => /UPDATE exam_papers SET paper_status = \$1/.test(l.text) && l.params[0] === 'VALIDATED'));
  assert.ok(notes().some((x) => x.user === USERS.coe.id && x.type === 'paper_validation_outcome' && /VALIDATED/.test(x.message)));
});
test('validate: any CHANGES_REQUIRED => paper CHANGES_REQUIRED; double submit blocked', async () => {
  scriptValidation();
  decisions = [{ decision: 'APPROVE' }, { decision: 'CHANGES_REQUIRED' }, { decision: 'APPROVE' }, { decision: 'APPROVE' }];
  await call('POST', VALIDATE, { decision: 'CHANGES_REQUIRED', comments: 'Q2 wrong', checklist: {} }, 'v1');
  assert.ok(log.some((l) => /UPDATE exam_papers SET paper_status = \$1/.test(l.text) && l.params[0] === 'CHANGES_REQUIRED'));
  sql(/SELECT id, decision, assigned_by FROM paper_validator_assignments/i, () => [{ id: 'asg', decision: 'APPROVE', assigned_by: USERS.coe.id }]);
  assert.equal((await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, 'v1')).status, 409);
});

// ---- issues ----
function scriptIssues() {
  scriptValidation();
  sql(/FROM paper_questions WHERE paper_id = \$1 AND question_id = \$2/i, (p) => (p[1] === Q1 ? [{ x: 1, slot_number: 3 }] : []));
  sql(/SELECT id FROM paper_issues WHERE paper_id = \$1 AND reported_by/i, []);
  sql(/INSERT INTO paper_issues/i, [{ id: ISSUE }]);
}
const ISSUES = `/examinations/papers/${PAPER}/issues`;
test('issues: validated input; only for questions in the paper', async () => {
  scriptIssues();
  assert.equal((await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q', question_id: 'nope' }, 'v1')).status, 400);
  assert.equal((await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q', question_id: '0e000000-0000-0000-0000-000000000009' }, 'v1')).status, 400);
  assert.equal((await call('POST', ISSUES, { issue_type: 'bogus', description: 'something wrong' }, 'v1')).status, 400);
  assert.equal((await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo' }, 'v1')).status, 400, 'description under 5 characters');
  assert.equal((await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q1' }, 'coe')).status, 403);
});
test('issues: reported while VALIDATION_PENDING or VALIDATED only; audited with the id; COE notified', async () => {
  scriptIssues();
  for (const st of ['GENERATED', 'CHANGES_REQUIRED', 'COE_APPROVED', 'REGENERATED', 'PRINT_READY']) {
    paperStatus = st;
    assert.equal((await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q1' }, 'v1')).status, 409, st);
  }
  assert.equal(log.some((l) => /INSERT INTO paper_issues/.test(l.text)), false);
  for (const st of ['VALIDATION_PENDING', 'VALIDATED']) {
    paperStatus = st; log.length = 0;
    const r = await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q1', question_id: Q1 }, 'v1');
    assert.equal(r.status, 201, `${st} ${JSON.stringify(r.data)}`);
    const a = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'paper_issue_reported');
    assert.equal(JSON.parse(a.params[4]).issue_id, ISSUE);
    assert.ok(notes().some((x) => x.user === USERS.coe.id && x.type === 'paper_issue_reported' && /on Q3/.test(x.message)));
  }
});
test('issues: an assignment ended inside the transaction gives 403; an exact duplicate gives 409', async () => {
  scriptIssues();
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id = \$1 AND validator_id = \$2 AND is_active$/i, []);
  assert.equal((await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q1' }, 'v1')).status, 403);
  scriptIssues();
  sql(/SELECT id FROM paper_issues WHERE paper_id = \$1 AND reported_by/i, [{ id: ISSUE }]);
  const dup = await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q1' }, 'v1');
  assert.equal(dup.status, 409); assert.equal(dup.data.issue_id, ISSUE);
});
test('issues: a validator sees only their own, without emails; the COE sees all', async () => {
  scriptIssues();
  sql(/FROM paper_issues pi JOIN users u ON u.id = pi.reported_by/i, []);
  assert.equal((await call('GET', ISSUES, null, 'v1')).status, 200);
  let q = log.filter((l) => /FROM paper_issues pi JOIN users u/.test(l.text)).at(-1);
  assert.deepEqual(q.params, [PAPER, USERS.v1.id, 'validator']); assert.match(q.text, /\$3 = 'coe' OR pi.reported_by = \$2/);
  assert.match(q.text, /CASE WHEN \$3 = 'coe' THEN u.email END AS reported_by_email/);
  assert.equal((await call('GET', ISSUES, null, 'coe')).status, 200);
  q = log.filter((l) => /FROM paper_issues pi JOIN users u/.test(l.text)).at(-1);
  assert.equal(q.params[2], 'coe');
});
const RESOLVE = `/examinations/issues/${ISSUE}/resolve`;
function scriptResolve(updated = true) {
  sql(/SELECT id, paper_id, reported_by, status FROM paper_issues WHERE id/i, [{ id: ISSUE, paper_id: PAPER, reported_by: USERS.v1.id, status: 'open' }]);
  sql(/UPDATE paper_issues SET status = \$1/i, () => (updated ? [{ id: ISSUE, status: 'resolved' }] : []));
  sql(/SELECT status FROM paper_issues WHERE id/i, [{ status: 'wont_fix' }]);
}
test('resolve: one-shot, COE only, closable statuses, audited with old/new, reporter notified', async () => {
  paperStatus = 'VALIDATED'; scriptResolve();
  assert.equal((await call('POST', RESOLVE, { status: 'resolved' }, 'coe')).status, 400);
  assert.equal((await call('POST', RESOLVE, { status: 'resolved', resolution: 'too short' }, 'coe')).status, 400);
  for (const st of ['carried_forward', 'open']) assert.equal((await call('POST', RESOLVE, { status: st, resolution: 'a long enough resolution' }, 'coe')).status, 400, st);
  assert.equal((await call('POST', RESOLVE, { status: 'resolved', resolution: 'a long enough resolution' }, 'v1')).status, 403);
  log.length = 0;
  const ok = await call('POST', RESOLVE, { status: 'wont_fix', resolution: 'accepted as printed; minor wording' }, 'coe');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(log.find((l) => /UPDATE paper_issues SET status = \$1/.test(l.text)).text, /WHERE id = \$4 AND status = 'open' RETURNING/);
  const a = JSON.parse(log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'paper_issue_resolved').params[4]);
  assert.equal(a.old_status, 'open'); assert.equal(a.new_status, 'wont_fix'); assert.equal(a.paper_status, 'VALIDATED');
  assert.ok(notes().some((x) => x.user === USERS.v1.id && x.type === 'paper_issue_closed'));
  scriptResolve(false);
  const again = await call('POST', RESOLVE, { status: 'resolved', resolution: 'a long enough resolution' }, 'coe');
  assert.equal(again.status, 409); assert.equal(again.data.current_status, 'wont_fix');
  scriptResolve();
  for (const st of ['REGENERATED', 'COE_APPROVED', 'PRINT_READY']) {
    paperStatus = st;
    assert.equal((await call('POST', RESOLVE, { status: 'resolved', resolution: 'a long enough resolution' }, 'coe')).status, 409, st);
  }
  paperStatus = 'VALIDATED';
  coeOutOfScope();
  assert.equal((await call('POST', RESOLVE, { status: 'resolved', resolution: 'a long enough resolution' }, 'coe')).status, 403, 'COE outside the campus');
});
const REFER = `/examinations/issues/${ISSUE}/refer`;
function scriptRefer({ question = Q1, reviewers: rv = [{ id: USERS.reviewer.id }], hods = [] } = {}) {
  paperStatus = 'VALIDATED';
  sql(/SELECT id, paper_id, question_id, issue_type, origin_issue_id FROM paper_issues/i, [{ id: ISSUE, paper_id: PAPER, question_id: question, issue_type: 'incorrect', origin_issue_id: null }]);
  sql(/SELECT q.submitted_by, q.course_offering_id, co.campus_id, p.department_id/i, [{ submitted_by: USERS.teacher.id, course_offering_id: IDS.off, campus_id: IDS.campusA, department_id: IDS.dept }]);
  sql(/FROM reviewer_assignments ra JOIN users u/i, rv);
  sql(/JOIN user_scopes s ON s.user_id = u.id AND s.role = 'hod'/i, hods);
  sql(/INSERT INTO paper_issue_referrals/i, [{ id: 'ref1', created_at: new Date().toISOString() }]);
}
test('refer: records the request and notifies the reviewer, never with paper details; never writes the bank', async () => {
  scriptRefer();
  assert.equal((await call('POST', REFER, { note: 'short' }, 'coe')).status, 400);
  assert.equal((await call('POST', REFER, { note: 'please re-check the model answer' }, 'v1')).status, 403);
  log.length = 0;
  const r = await call('POST', REFER, { note: 'please re-check the model answer' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.referred_to_role, 'reviewer');
  const ins = log.find((l) => /INSERT INTO paper_issue_referrals/.test(l.text));
  assert.equal(ins.params[0], ISSUE, 'keyed by the origin issue'); assert.deepEqual(ins.params[3], [USERS.reviewer.id]);
  const n = notes().filter((x) => x.type === 'question_referred_by_examination');
  assert.equal(n.length, 1); assert.equal(n[0].user, USERS.reviewer.id);
  assert.doesNotMatch(n[0].message, /end_term|CS101|paper v|typo/);
  assert.equal(log.some((l) => /UPDATE questions|INSERT INTO questions/.test(l.text)), false, 'the examination never writes the question bank');
  scriptRefer({ reviewers: [], hods: [{ id: USERS.hod.id }] });
  assert.equal((await call('POST', REFER, { note: 'please re-check the model answer' }, 'coe')).data.referred_to_role, 'hod');
  scriptRefer({ reviewers: [], hods: [] });
  assert.equal((await call('POST', REFER, { note: 'please re-check the model answer' }, 'coe')).status, 409, 'nobody to refer to');
  scriptRefer({ question: null });
  assert.equal((await call('POST', REFER, { note: 'please re-check the model answer' }, 'coe')).status, 400, 'paper-level issue');
  scriptRefer();
  sql(/INSERT INTO paper_issue_referrals/i, () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
  assert.equal((await call('POST', REFER, { note: 'please re-check the model answer' }, 'coe')).status, 409, 'referred once');
});

test('regenerate creates a new revision in one transaction, marks the old one REGENERATED, needs a reason', async () => {
  paperStatus = 'CHANGES_REQUIRED';
  nextVersion = 2;
  sql(/INSERT INTO paper_revisions/i, []);
  sql(/SET paper_status = 'REGENERATED' WHERE id = \$1 AND paper_status = \$2/i, [{ id: PAPER }]);
  sql(/FROM paper_blueprints WHERE id = \$1$/i, () => [{ id: 'bp1', version_number: 1, easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 18, reuse_lookback_exams: 2 }]);
  assert.equal((await call('POST', `/examinations/papers/${PAPER}/regenerate`, {}, 'coe')).status, 400);
  const r = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q2 incorrect' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const at = (re) => log.findIndex((l) => re.test(l.text));
  assert.ok(at(/pg_advisory_xact_lock/) < at(/SELECT id, paper_status FROM exam_papers WHERE id = \$1 FOR UPDATE/), 'offering lock, then parent row');
  assert.ok(at(/SET paper_status = 'GENERATED'/) < at(/SET paper_status = 'REGENERATED' WHERE id = \$1 AND paper_status = \$2/), 'supersede after the new revision, conditional');
  assert.ok(log.some((l) => /INSERT INTO paper_revisions/.test(l.text)));
  assert.equal(log.some((l) => /UPDATE paper_validator_assignments|DELETE FROM paper_validator_assignments/.test(l.text)), false, 'assignments are ended by the DB trigger');
  paperStatus = 'VALIDATED';
  assert.equal((await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'x y z' }, 'coe')).status, 409);
});
test('regenerate: open issues are resolved (replaced question) or carried, and flagged questions are left out by default', async () => {
  paperStatus = 'CHANGES_REQUIRED';
  const kept = pool[0].id;
  openIssues = [
    { id: 'i-kept', question_id: kept, issue_type: 'spelling', description: 'typo here', reported_by: USERS.v1.id, origin_issue_id: null },
    { id: 'i-gone', question_id: 'q-not-in-new-paper', issue_type: 'incorrect', description: 'wrong answer', reported_by: USERS.v2.id, origin_issue_id: null },
    { id: 'i-paper', question_id: null, issue_type: 'formatting', description: 'layout broken', reported_by: USERS.v3.id, origin_issue_id: 'i-root' },
  ];
  sql(/SELECT DISTINCT question_id FROM paper_issues WHERE paper_id = \$1 AND status = 'open'/i, []);
  nextVersion = 2;
  sql(/INSERT INTO paper_revisions/i, []);
  sql(/SET paper_status = 'REGENERATED' WHERE id = \$1 AND paper_status = \$2/i, [{ id: PAPER }]);
  sql(/UPDATE paper_issues SET status = 'resolved'/i, [{ id: 'i-gone' }]);
  sql(/UPDATE paper_issues SET status = 'carried_forward'/i, [{ id: 'x' }]);
  sql(/INSERT INTO paper_issues/i, (p) => [{ id: `copy-of-${p[5]}` }]);
  sql(/FROM paper_blueprints WHERE id = \$1$/i, () => [{ id: 'bp1', version_number: 1, easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 18, reuse_lookback_exams: 2 }]);
  // Force q1 into the new paper by making it the only easy question besides one other.
  pool = pool.filter((q) => q.difficulty !== 'easy' || q.id === kept || q.id === pool[1].id);
  const r = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q2 incorrect', exclude_flagged_questions: false }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(log.find((l) => /UPDATE paper_issues SET status = 'resolved'/.test(l.text)).params.slice(0, 2), ['i-gone', 'Question replaced by regeneration (paper v2)']);
  const copies = log.filter((l) => /INSERT INTO paper_issues/.test(l.text));
  assert.deepEqual(copies.map((l) => l.params[5]).sort(), ['i-kept', 'i-paper']);
  assert.equal(copies.find((l) => l.params[5] === 'i-paper').params[6], 'i-root', 'origin kept along the chain');
  assert.equal(log.filter((l) => /UPDATE paper_issues SET status = 'carried_forward'/.test(l.text)).length, 2);
  const revs = log.filter((l) => /INSERT INTO paper_revisions/.test(l.text));
  assert.deepEqual(revs.map((l) => /'issue_resolution'/.test(l.text)), [false, true]);
  const at = (re) => log.findIndex((l) => re.test(l.text));
  assert.ok(at(/UPDATE paper_issues SET status = 'carried_forward'/) < at(/SET paper_status = 'REGENERATED'/), 'issues closed while the parent is still closable');
  assert.ok(audits().includes('paper_issues_carried'));
});
test('regenerate: flagged questions are excluded by default; an infeasible exclusion says why; a parent that changed gives 409', async () => {
  paperStatus = 'CHANGES_REQUIRED';
  const hard = pool.find((q) => q.difficulty === 'hard').id;
  sql(/SELECT DISTINCT question_id FROM paper_issues WHERE paper_id = \$1 AND status = 'open'/i, [{ question_id: hard }]);
  nextVersion = 2;
  sql(/FROM paper_blueprints WHERE id = \$1$/i, () => [{ id: 'bp1', version_number: 1, easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 18, reuse_lookback_exams: 2 }]);
  const r = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q5 incorrect' }, 'coe');
  assert.equal(r.status, 422, JSON.stringify(r.data)); assert.match(r.data.reasons.join(' '), /1 question\(s\) with open validator issues were left out/);
  sql(/FOR UPDATE/i, () => [{ id: PAPER, paper_status: 'REGENERATED' }]);
  sql(/SELECT DISTINCT question_id FROM paper_issues WHERE paper_id = \$1 AND status = 'open'/i, []);
  const raced = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q5 incorrect' }, 'coe');
  assert.equal(raced.status, 409, JSON.stringify(raced.data));
});

// ---- access by paper status (paper-policy.js paperAccessFor) ----
test('paper detail: COE in campus always; assigned validator only while under validation; my_assignment + validation view', async () => {
  sql(/FROM paper_questions pq WHERE pq.paper_id/i, [{ slot_number: 1, question_id: 'q1', text: 'T', marks: 2 }]);
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id/i, (p) => (p[1] === USERS.v1.id ? [{ x: 1 }] : []));
  sql(/SELECT id AS assignment_id, validator_number, validation_round/i, [{ assignment_id: 'asg', validator_number: 1, validation_round: 1, decision: 'APPROVE' }]);
  sql(/COUNT\(\*\) FILTER \(WHERE decision = 'APPROVE'\)::int AS approved/i, [{ approved: 1, total: 4 }]);
  for (const st of ['GENERATED', 'VALIDATION_PENDING', 'VALIDATED', 'COE_APPROVED', 'PRINT_READY', 'ARCHIVED', 'REGENERATED', 'CHANGES_REQUIRED']) {
    paperStatus = st;
    assert.equal((await call('GET', `/examinations/papers/${PAPER}`, null, 'coe')).status, 200, `coe ${st}`);
    const v = await call('GET', `/examinations/papers/${PAPER}`, null, 'v1');
    assert.equal(v.status, ['VALIDATION_PENDING', 'VALIDATED'].includes(st) ? 200 : 403, `v1 ${st}`);
    if (v.status === 200) { assert.equal(v.data.my_assignment.decision, 'APPROVE'); assert.equal(v.data.access.decide, st === 'VALIDATION_PENDING'); }
    assert.equal((await call('GET', `/coe/papers/${PAPER}/coe-status`, null, 'v1')).status === 200, ['VALIDATION_PENDING', 'VALIDATED'].includes(st), `coe-status v1 ${st}`);
  }
  paperStatus = 'VALIDATION_PENDING';
  for (const who of ['v2', 'hod', 'teacher']) assert.equal((await call('GET', `/examinations/papers/${PAPER}`, null, who)).status, 403, who);
});

// ---- configurable approval threshold (spec §27) ----
test('validators: assignment freezes the institution threshold on the paper (default 4, policy 3)', async () => {
  const url = `/examinations/papers/${PAPER}/validators`;
  let r = await call('POST', url, { validator_ids: four() }, 'coe');
  assert.equal(r.status, 200); assert.equal(r.data.required_approvals, 4);
  let upd = log.find((l) => /UPDATE exam_papers SET paper_status = 'VALIDATION_PENDING'/.test(l.text));
  assert.match(upd.text, /COALESCE\(required_approvals, \$2\)/); assert.equal(upd.params[1], 4);
  sql(/required_validator_approvals/i, [{ value: '3' }]);
  log.length = 0;
  r = await call('POST', url, { validator_ids: four() }, 'coe');
  upd = log.find((l) => /UPDATE exam_papers SET paper_status = 'VALIDATION_PENDING'/.test(l.text));
  assert.equal(upd.params[1], 3);
});
test('validate: with a 3-of-4 paper, one objection still validates; with the default it does not', async () => {
  scriptValidation();
  decisions = [{ decision: 'APPROVE' }, { decision: 'APPROVE' }, { decision: 'APPROVE' }, { decision: 'CHANGES_REQUIRED' }];
  sql(/FROM exam_papers WHERE id = \$1 FOR UPDATE/i, () => [{ id: PAPER, paper_status: 'VALIDATION_PENDING', required_approvals: 3, examination_id: EXAM.id }]);
  let r = await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, 'v1');
  assert.equal(r.data.paper_status, 'VALIDATED', JSON.stringify(r.data));
  sql(/FROM exam_papers WHERE id = \$1 FOR UPDATE/i, () => [{ id: PAPER, paper_status: 'VALIDATION_PENDING', required_approvals: 4, examination_id: EXAM.id }]);
  r = await call('POST', VALIDATE, { decision: 'APPROVE', checklist: CHECK }, 'v1');
  assert.equal(r.data.paper_status, 'CHANGES_REQUIRED');
});

// ---- printable paper from snapshots ----
test('pdf: COE in scope always (answer key too); validator only while under validation; built from snapshots', async () => {
  sql(/FROM examinations e\s+JOIN subjects s/i, [{ subject_code: 'CS101', course_title: 'Intro', program_name: 'BTech' }]);
  sql(/FROM paper_questions pq WHERE pq.paper_id/i, [{ slot_number: 1, question_text_snapshot: 'Snapshot text', marks_snapshot: 2, metadata_snapshot: { question_type: 'subjective' } }]);
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id/i, (p) => (p[1] === USERS.v1.id ? [{ x: 1 }] : []));
  const { tokenFor } = await import('./harness.mjs');
  const get = (who, q = '') => fetch(`http://localhost:${process.env.PORT}/api/examinations/papers/${PAPER}/pdf${q}`, { headers: { Authorization: `Bearer ${tokenFor(who)}` } });
  paperStatus = 'VALIDATION_PENDING';
  const res = await get('coe');
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /pdf/);
  assert.ok(log.some((l) => /question_text_snapshot/.test(l.text)), 'reads snapshots, not the live bank');
  assert.equal(log.some((l) => /FROM paper_questions pq JOIN questions q/.test(l.text)), false);
  assert.equal((await get('v1', '?include_answers=1')).status, 200, 'validator gets the answer key while validating');
  for (const who of ['v2', 'hod', 'admin', 'teacher']) assert.equal((await call('GET', `/examinations/papers/${PAPER}/pdf`, null, who)).status, 403, who);
  for (const st of ['COE_APPROVED', 'PRINT_READY', 'ARCHIVED', 'REGENERATED']) {
    paperStatus = st;
    assert.equal((await get('v1')).status, 403, `validator pdf ${st}`);
    assert.equal((await get('v1', '?include_answers=1')).status, 403, `validator answer key ${st}`);
    assert.equal((await get('coe', '?include_answers=1')).status, 200, `COE answer key ${st}`);
  }
  const a = log.filter((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'paper_pdf_downloaded').at(-1);
  assert.deepEqual(JSON.parse(a.params[4]), { include_answers: true, paper_status: 'REGENERATED' });
});

// ---- exam-portal-v4-complete-implementation-prompt: sections, hard targets, overrides, reservations ----
test('blueprint: inconsistent sections are refused with reasons; valid sections are stored with hard targets', async () => {
  const bad = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 18,
    sections: [{ name: 'A', question_count: 3, marks_per_question: 2 }, { name: 'A', question_count: 1 }] }, 'coe');
  assert.equal(bad.status, 400);
  assert.ok(bad.data.reasons.some((r) => /Duplicate section/.test(r)) && bad.data.reasons.some((r) => /Sections hold 4/.test(r)), JSON.stringify(bad.data));
  log.length = 0;
  const ok = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 18,
    sections: [{ name: 'Section A', question_count: 2, marks_per_question: 2 }, { name: 'Section B', question_count: 3 }],
    co_distribution: { CO1: 5 }, bloom_distribution: { apply: 100 } }, 'coe');
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const ins = log.find((l) => /INSERT INTO paper_blueprints/.test(l.text));
  assert.match(ins.text, /sections, hard_targets\) VALUES .*\$17,TRUE\)/);
  assert.equal(JSON.parse(ins.params[16]).length, 2);
});

test('generate: takes the per-offering lock before reading the pool, and reserves every picked question', async () => {
  log.length = 0;
  const r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1', seed: 'lock' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const lockAt = log.findIndex((l) => /pg_advisory_xact_lock/.test(l.text));
  const poolAt = log.findIndex((l) => /FROM questions q JOIN course_offerings co/.test(l.text));
  assert.ok(lockAt >= 0 && lockAt < poolAt, 'lock first');
  assert.match(log[poolAt].text, /question_reservations r WHERE r.question_id = q.id AND r.released_at IS NULL AND r.examination_id <> \$6/);
  const picked = log.filter((l) => /INSERT INTO paper_questions/.test(l.text)).length;
  assert.equal(log.filter((l) => /INSERT INTO question_reservations/.test(l.text)).length, picked);
});

// ---- phase 2: CO/Bloom targets, overrides, blueprint integrity ----
const BP_CO2 = 'b9000000-0000-0000-0000-000000000c02';
// A hard-target blueprint whose CO2 target the (all-CO1) pool cannot meet.
const scriptCo2Blueprint = (extra = {}) => sql(/FROM paper_blueprints WHERE id = \$1 AND examination_id/i, (p) => (p[1] === EXAM.id && p[0] !== BP_OTHER ? [{ id: p[0], version_number: 3, easy_count: 2, medium_count: 2,
  hard_count: 1, total_marks: 18, reuse_lookback_exams: 2, hard_targets: true, co_distribution: { CO2: 1 }, ...extra }] : []));
const at = (re, from = 0) => log.findIndex((l, i) => i >= from && re.test(l.text));
const auditAt = (action) => log.findIndex((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === action);
const authzActions = () => log.filter((l) => /INSERT INTO authorization_log/.test(l.text)).map((l) => l.params[1]);

test('generate: a CO/Bloom override is refused unless strict generation fails; when needed it is recorded, approved by the generating COE and audited in the transaction', async () => {
  const short = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1', override: { relax: ['co'], reason: 'short' } }, 'coe');
  assert.equal(short.status, 422); assert.match(short.data.reasons[0], /10 characters/); assert.equal(short.data.code, 'OVERRIDE_INVALID');
  log.length = 0;
  const none = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1', override: { relax: ['co'], reason: 'New course: bank still being built' } }, 'coe');
  assert.equal(none.status, 422, 'bp1 has no CO targets to relax'); assert.equal(none.data.code, 'OVERRIDE_INVALID');
  assert.equal(log.some((l) => /INSERT INTO exam_papers/.test(l.text)), false);

  scriptCo2Blueprint();
  const strict = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: BP_CO2 }, 'coe');
  assert.equal(strict.status, 422); assert.match(strict.data.reasons.join(' '), /CO2/); assert.equal(strict.data.code, 'INVENTORY');
  log.length = 0;
  const ok = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: BP_CO2, override: { relax: ['co', 'marks'], reason: 'New course: bank still being built' } }, 'coe');
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.ok(authzActions().includes('override_generation_targets'), 'the override approval is its own authorization decision');
  const ins = log.find((l) => /INSERT INTO exam_papers/.test(l.text));
  const ov = JSON.parse(ins.params[15]);
  assert.deepEqual(ov.relax, ['co'], 'only co/bloom can be relaxed');
  assert.equal(ov.approved_by, USERS.coe.id); assert.equal(ov.approval_basis, 'generating_coe');
  assert.equal(ov.strict_failure.code, 'INVENTORY'); assert.equal(ov.strict_failure.proven, true);
  assert.deepEqual(ov.original_targets, { co: { CO2: 1 } });
  const rec = log.find((l) => /INSERT INTO paper_constraint_overrides/.test(l.text));
  assert.equal(rec.params[1], 'co_distribution'); assert.deepEqual(JSON.parse(rec.params[2]), { CO2: 1 }); assert.equal(rec.params[5], USERS.coe.id);
  assert.ok(at(/INSERT INTO paper_constraint_overrides/) < at(/SET paper_status = 'GENERATED'/), 'recorded while GENERATING');
  const gen = at(/SET paper_status = 'GENERATED'/);
  for (const action of ['paper_generated', 'generation_constraint_override']) {
    const i = auditAt(action);
    assert.ok(i > gen, `${action} audited inside the generation, after the paper`);
    const lock = log.slice(0, i).map((l, k) => [l, k]).filter(([l]) => /pg_advisory_xact_lock/.test(l.text) && l.params[0] === 'audit_log:chain').at(-1);
    assert.ok(lock && lock[1] > gen, `${action}: chain lock taken before its row`);
  }
  const audit = JSON.parse(log[auditAt('generation_constraint_override')].params[4]);
  assert.deepEqual(audit.original_targets, { co: { CO2: 1 } }); assert.equal(audit.approved_by, USERS.coe.id);
});
test('generate: a legacy (soft-target) blueprint with targets is refused with LEGACY_BLUEPRINT before anything is locked or written', async () => {
  scriptCo2Blueprint({ hard_targets: false, co_distribution: { CO1: 1 } });
  log.length = 0;
  const r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: BP_CO2 }, 'coe');
  assert.equal(r.status, 422); assert.equal(r.data.code, 'LEGACY_BLUEPRINT'); assert.match(r.data.reasons[0], /Copy into editor/);
  assert.equal(log.some((l) => /INSERT INTO exam_papers|pg_advisory_xact_lock/.test(l.text)), false);
});
test('generate: refused with 409 and the live paper list while the examination has a live paper; nothing is inserted', async () => {
  livePapers = [{ id: PAPER, paper_version: 1, paper_status: 'GENERATED' }];
  const r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  assert.equal(r.status, 409, JSON.stringify(r.data)); assert.match(r.data.reasons[0], /v1 is GENERATED/); assert.equal(r.data.live_papers[0].id, PAPER);
  assert.equal(log.some((l) => /INSERT INTO exam_papers/.test(l.text)), false);
});
test('generate: the paper version is computed under the offering lock, after the one-live check', async () => {
  nextVersion = 7; log.length = 0;
  const r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.paperVersion, 7); assert.equal(r.data.attempt, 1);
  const order = [/set_config\('lock_timeout'/, /pg_advisory_xact_lock/, /id IS DISTINCT FROM \$3::uuid/, /COALESCE\(MAX\(paper_version\), 0\)/, /FROM questions q JOIN course_offerings co/, /INSERT INTO exam_papers/].map((re) => at(re));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), JSON.stringify(order));
  assert.equal(log[order[1]].params[0], `generate:${EXAM.course_offering_id}`);
  const ins = log[order[5]];
  assert.equal(ins.params[13], 7); assert.match(ins.params[2], /v7$/);
  assert.equal(log.some((l) => /COUNT\(\*\)::int AS n FROM exam_papers/.test(l.text)), false, 'no version from an unlocked count');
});
test('generate: retries a deadlock (same seed) and succeeds; retries are bounded; conflicts that retrying cannot fix are not retried', async () => {
  const attempts = () => log.filter((l) => /set_config\('lock_timeout'/.test(l.text)).length;
  let fails = 1;
  sql(/INSERT INTO exam_papers/i, () => { if (fails-- > 0) throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); return [{ id: PAPER }]; });
  log.length = 0;
  let r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1', seed: 'retry' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.attempt, 2); assert.equal(r.data.seed, 'retry');
  assert.equal(log.filter((l) => /INSERT INTO exam_papers/.test(l.text)).length, 2);
  sql(/INSERT INTO exam_papers/i, () => { throw Object.assign(new Error('could not serialize access'), { code: '40001' }); });
  log.length = 0;
  r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  assert.equal(r.status, 409, JSON.stringify(r.data)); assert.equal(attempts(), 3, 'at most 3 attempts');
  sql(/INSERT INTO exam_papers/i, [{ id: PAPER }]);
  sql(/^INSERT INTO question_reservations/i, () => { throw new Error('duplicate key value violates unique constraint "uq_question_reservation_active"'); });
  log.length = 0;
  r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  assert.equal(r.status, 409, 'a reservation race is transient (409), not an infeasible blueprint (422)'); assert.match(r.data.error, /reserved some of these questions/); assert.equal(attempts(), 3);
  sql(/^INSERT INTO question_reservations/i, []);
  for (const [name, err] of [['lock timeout', Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })],
    ['one live paper (deferred check)', Object.assign(new Error('Examination x already has a paper in progress or printed'), { code: '23505', constraint: 'uq_one_live_paper_per_examination' })]]) {
    sql(/INSERT INTO exam_papers/i, () => { throw err; });
    log.length = 0;
    r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
    assert.equal(r.status, 409, name); assert.equal(attempts(), 1, `${name}: not retried`);
  }
  sql(/INSERT INTO exam_papers/i, [{ id: PAPER }]);
  pool = pool.filter((q) => q.difficulty !== 'hard'); log.length = 0;
  r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  assert.equal(r.status, 422); assert.equal(attempts(), 1, 'an infeasible blueprint is not retried');
});
test('regenerate: only a blueprint version of the paper\'s own examination; the default is the paper\'s version', async () => {
  paperStatus = 'CHANGES_REQUIRED'; nextVersion = 2;
  sql(/INSERT INTO paper_revisions/i, []);
  sql(/SET paper_status = 'REGENERATED' WHERE id = \$1 AND paper_status = \$2/i, [{ id: PAPER }]);
  const other = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q2 incorrect', blueprint_id: BP_OTHER }, 'coe');
  assert.equal(other.status, 400); assert.match(other.data.error, /this paper's examination/);
  assert.equal((await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q2 incorrect', blueprint_id: 'nope' }, 'coe')).status, 400);
  assert.equal(log.some((l) => /INSERT INTO exam_papers/.test(l.text)), false);
  log.length = 0;
  const r = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q2 incorrect' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(log.find((l) => /FROM paper_blueprints WHERE id = \$1 AND examination_id = \$2/.test(l.text)).params, ['bp1', EXAM.id]);
  scriptCo2Blueprint(); log.length = 0;
  const withOv = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'use v3 with relaxed CO', blueprint_id: BP_CO2, seed: 'r1',
    override: { relax: ['co'], reason: 'CO2 questions are still in review' } }, 'coe');
  assert.equal(withOv.status, 201, JSON.stringify(withOv.data));
  const ins = log.find((l) => /INSERT INTO exam_papers/.test(l.text));
  assert.equal(ins.params[8], BP_CO2); assert.equal(ins.params[6], 'r1'); assert.equal(ins.params[14], PAPER, 'linked to its parent');
  assert.deepEqual(JSON.parse(ins.params[15]).relax, ['co']);
});
test('regenerate: the parent is locked and re-checked; supersede, revision and audit rows happen in the generation transaction, in order', async () => {
  paperStatus = 'CHANGES_REQUIRED'; lockedStatus = 'VALIDATION_PENDING';
  sql(/INSERT INTO paper_revisions/i, []);
  sql(/SET paper_status = 'REGENERATED' WHERE id = \$1 AND paper_status = \$2/i, [{ id: PAPER }]);
  let r = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q2 incorrect' }, 'coe');
  assert.equal(r.status, 409, 'status changed under the lock'); assert.equal(log.some((l) => /INSERT INTO exam_papers|INSERT INTO paper_revisions/.test(l.text)), false);
  lockedStatus = null; nextVersion = 4; log.length = 0;
  r = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q2 incorrect' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.paperVersion, 4);
  const order = [/FROM exam_papers WHERE id = \$1 FOR UPDATE/, /INSERT INTO exam_papers/, /SET paper_status = 'REGENERATED'/, /INSERT INTO paper_revisions/].map((re) => at(re));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), JSON.stringify(order));
  assert.equal(log[order[3]].params[1], 4, 'revision number = the version computed under the lock');
  assert.ok(order[3] < auditAt('paper_superseded') && auditAt('paper_superseded') < auditAt('paper_generated'), 'audit rows last');
  assert.deepEqual(JSON.parse(log[auditAt('paper_superseded')].params[4]).superseded_by, PAPER);
  sql(/SET paper_status = 'REGENERATED' WHERE id = \$1 AND paper_status = \$2/i, []); log.length = 0;
  r = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q2 incorrect' }, 'coe');
  assert.equal(r.status, 409, 'conditional supersede lost the race'); assert.equal(log.some((l) => /INSERT INTO paper_revisions/.test(l.text)), false);
});
test('validators: a status change found under the row lock gives 409 and writes nothing', async () => {
  lockedStatus = 'CHANGES_REQUIRED';
  const r = await call('POST', `/examinations/papers/${PAPER}/validators`, { validator_ids: four() }, 'coe');
  assert.equal(r.status, 409); assert.equal(log.some((l) => /INSERT INTO paper_validator_assignments|SET is_active = FALSE/.test(l.text)), false);
  lockedStatus = null; log.length = 0;
  assert.equal((await call('POST', `/examinations/papers/${PAPER}/validators`, { validator_ids: four() }, 'coe')).status, 200);
  assert.ok(auditAt('validators_assigned') > at(/UPDATE exam_papers SET paper_status = 'VALIDATION_PENDING'/), 'audited inside the transaction, last');
});
test('blueprint: exam row locked before the previous version is read; CO keys normalised to active COs; totals must match the exam; a concurrent save gives 409', async () => {
  log.length = 0;
  const ok = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1, co_distribution: { co1: 2 }, bloom_distribution: { Apply: 60 } }, 'coe');
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.ok(at(/FOR NO KEY UPDATE/) >= 0 && at(/FOR NO KEY UPDATE/) < at(/ORDER BY version_number DESC/), 'exam row lock first');
  const ins = log.find((l) => /INSERT INTO paper_blueprints/.test(l.text));
  assert.deepEqual(JSON.parse(ins.params[14]), { CO1: 2 }, 'canonical CO code'); assert.deepEqual(JSON.parse(ins.params[7]), { apply: 60 });
  assert.ok(auditAt('blueprint_version_created') > at(/INSERT INTO paper_blueprints/), 'audit inside the transaction');
  const co9 = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1, co_distribution: { CO9: 1 } }, 'coe');
  assert.equal(co9.status, 400); assert.match(co9.data.reasons.join(' '), /CO9 is not an active course outcome .*active: CO1, CO2/);
  const dup = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1, co_distribution: { CO1: 1, co1: 1 } }, 'coe');
  assert.equal(dup.status, 400); assert.match(dup.data.reasons.join(' '), /same course outcome/);
  const marks = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 20 }, 'coe');
  assert.equal(marks.status, 400); assert.match(marks.data.reasons.join(' '), /must equal the examination's maximum marks \(18\)/);
  const notes = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1, bloom_distribution: { apply: 80, create: 5 } }, 'coe');
  assert.equal(notes.status, 201); assert.match(notes.data.target_notes.join(' '), /create 5% of 5 question\(s\) resolves to 0/);
  sql(/INSERT INTO paper_blueprints/i, () => { throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_paper_blueprints_examination_version' }); });
  const race = await call('POST', '/examinations/blueprints', { examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1 }, 'coe');
  assert.equal(race.status, 409); assert.match(race.data.error, /saved at the same moment/);
});
test('blueprints: list labels the target mode and usage; detail view is campus-scoped and resolves targets', async () => {
  const row = { id: BP_CO2, examination_id: EXAM.id, version_number: 2, easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 18, hard_targets: false, co_distribution: { CO1: 1 },
    bloom_distribution: null, sections: null, supersedes_id: null, paper_count: 1 };
  sql(/FROM paper_blueprints b JOIN examinations e ON e.id = b.examination_id JOIN programs pr ON pr.id = e.program_id\s+WHERE user_has_scope/i, () => [row, { ...row, id: 'bp-hard', hard_targets: true, version_number: 3 }]);
  const list = await call('GET', `/examinations/blueprints?examination_id=${EXAM.id}`, null, 'coe');
  assert.equal(list.status, 200); assert.equal(list.data[0].target_mode, 'legacy_soft'); assert.match(list.data[0].generation_blocked_reason, /legacy soft targets/);
  assert.equal(list.data[1].target_mode, 'hard'); assert.equal(list.data[1].generation_blocked_reason, null);
  sql(/FROM paper_blueprints b JOIN examinations e ON e.id = b.examination_id JOIN programs pr ON pr.id = e.program_id WHERE b.id = \$1/i, () => [{ ...row, hard_targets: true, bloom_distribution: { apply: 100 },
    exam_campus_id: IDS.campusA, exam_department_id: IDS.dept, exam_program_id: IDS.prog, exam_offering_id: IDS.off }]);
  sql(/SELECT id, paper_version, paper_status, generated_at FROM exam_papers WHERE blueprint_version_id/i, [{ id: PAPER, paper_version: 1, paper_status: 'GENERATED' }]);
  const d = await call('GET', `/examinations/blueprints/${BP_CO2}`, null, 'coe');
  assert.equal(d.status, 200, JSON.stringify(d.data)); assert.equal(d.data.targets.bloom.apply, 5); assert.equal(d.data.targets.bloom_complete, true); assert.equal(d.data.papers.length, 1);
  assert.equal(d.data.exam_campus_id, undefined); assert.equal(d.data.exam_program_id, undefined);
  const scopeCheck = log.filter((l) => /SELECT user_has_scope/.test(l.text)).pop();
  assert.deepEqual(scopeCheck.params.slice(1), ['coe', IDS.campusA, IDS.dept, IDS.prog, IDS.off], 'the whole examination context is checked, not only the campus');
  coeOutOfScope();
  assert.equal((await call('GET', `/examinations/blueprints/${BP_CO2}`, null, 'coe')).status, 403);
  assert.equal((await call('GET', `/examinations/blueprints/${BP_CO2}`, null, 'hod')).status, 403);
});
test('feasibility: read-only verdict for a saved version or a draft; offers the minimal override; scoped', async () => {
  const url = `/examinations/${EXAM.id}/feasibility`;
  log.length = 0;
  const ok = await call('POST', url, { blueprint_id: BP_CO2.replace('c02', 'c03'), seed: 'f1' }, 'coe');
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.feasible, true); assert.equal(ok.data.seed, 'f1'); assert.equal(ok.data.eligible_count, pool.length);
  assert.equal(ok.data.achieved.total_marks, 18); assert.match(ok.data.note, /nothing was saved or reserved/);
  assert.equal(log.some((l) => /^(INSERT|UPDATE|DELETE)/i.test(l.text) && !/authorization_log/.test(l.text)), false, 'writes nothing');
  assert.equal(log.some((l) => /pg_advisory|question_reservations \(/.test(l.text)), false, 'no lock, no reservation');
  scriptCo2Blueprint();
  const no = await call('POST', url, { blueprint_id: BP_CO2 }, 'coe');
  assert.equal(no.data.feasible, false); assert.equal(no.data.code, 'INVENTORY');
  assert.deepEqual(no.data.override_options, [{ relax: ['co'], feasible: true }]);
  const withOv = await call('POST', url, { blueprint_id: BP_CO2, override: { relax: ['co'], reason: 'CO2 questions are still in review' } }, 'coe');
  assert.equal(withOv.data.feasible, true); assert.equal(withOv.data.override.accepted, true);
  const draft = await call('POST', url, { blueprint: { easy_count: 2, medium_count: 2, hard_count: 1, sections: [{ name: 'A', question_count: 2 }] } }, 'coe');
  assert.equal(draft.status, 200); assert.equal(draft.data.feasible, false); assert.equal(draft.data.code, 'CONFIG'); assert.match(draft.data.reasons.join(' '), /Sections hold 2/);
  assert.equal((await call('POST', url, { blueprint_id: BP_OTHER }, 'coe')).status, 400);
  assert.equal((await call('POST', url, {}, 'coe')).status, 400);
  for (const who of ['hod', 'v1', 'admin']) assert.equal((await call('POST', url, { blueprint_id: BP_CO2 }, who)).status, 403, who);
  sql(/user_has_scope/i, [{ has_scope: false }]);
  assert.equal((await call('POST', url, { blueprint_id: BP_CO2 }, 'coe')).status, 403, 'cross-campus COE');
});

// ---- sections in output: previews and PDF from the frozen format_config ----
const FROZEN = JSON.stringify({ easy: 2, medium: 2, hard: 1, sections: [
  { name: 'Section A', index: 0, instructions: 'Answer all questions briefly.', question_count: 2, types: null, mpq: 2, total: null, diff: null, attempt: null },
  { name: 'Section B', index: 1, instructions: null, question_count: 3, types: ['long_answer'], mpq: 5, total: 10, diff: null, attempt: 2 },
] });
function scriptSectionedPaper() {
  sql(/FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id (JOIN programs pr ON pr.id = e.program_id )?WHERE ep.id/i, () => [{ id: PAPER, examination_id: EXAM.id, paper_status: paperStatus, campus_id: IDS.campusA,
    blueprint_version_id: 'bp1', generated_by: USERS.coe.id, format_config: FROZEN, title: 'end_term paper v1', candidate_metrics: { validation: { passed: true, errors: [], warnings: [], summary: { question_count: 5 } } } }]);
  const row = (slot, sec, marks, type) => ({ slot_number: slot, question_id: `q${slot}`, text: `Question ${slot}`, marks, meta: { question_type: type, difficulty: 'easy' }, section_name: sec,
    question_text_snapshot: `Question ${slot}`, marks_snapshot: marks, metadata_snapshot: { question_type: type, difficulty: 'easy', model_answer: 'm' } });
  sql(/FROM paper_questions pq WHERE pq.paper_id/i, [row(1, 'Section A', 2, 'short_answer'), row(2, 'Section A', 2, 'short_answer'),
    row(3, 'Section B', 5, 'long_answer'), row(4, 'Section B', 5, 'long_answer'), row(5, 'Section B', 5, 'long_answer')]);
  sql(/FROM examinations e\s+JOIN subjects s/i, [{ subject_code: 'CS101', course_title: 'Intro', program_name: 'BTech' }]);
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id/i, (p) => (p[1] === USERS.v1.id ? [{ x: 1 }] : []));
  sql(/SELECT id AS assignment_id, validator_number, validation_round/i, [{ assignment_id: 'asg', validator_number: 1, validation_round: 1, decision: null }]);
}
test('paper preview and PDF use the frozen section rules, never the live blueprint', async () => {
  paperStatus = 'VALIDATION_PENDING'; scriptSectionedPaper();
  const coe = await call('GET', `/examinations/papers/${PAPER}`, null, 'coe');
  assert.equal(coe.status, 200, JSON.stringify(coe.data));
  assert.equal(coe.data.sections.length, 2);
  assert.equal(coe.data.sections[1].heading, 'Section B  (Attempt any 2 of 3 questions, 10 marks)');
  assert.deepEqual(coe.data.sections[1].instruction_lines, ['Attempt any 2 of the 3 questions in this section. Each question carries 5 marks.']);
  assert.ok(coe.data.sections.every((x) => x.check.passed), JSON.stringify(coe.data.sections));
  assert.equal(coe.data.validation_view.sections[1].marks, 10); assert.equal(coe.data.validation_view.sections[1].ok, true);
  const v1 = await call('GET', `/examinations/papers/${PAPER}`, null, 'v1');
  assert.deepEqual(v1.data.sections, coe.data.sections, 'validators see the same section rules');
  for (const who of ['hod', 'teacher']) assert.equal((await call('GET', `/examinations/papers/${PAPER}`, null, who)).status, 403, who);
  const { tokenFor } = await import('./harness.mjs');
  const { pdfText } = await import('./pdf-text.mjs');
  log.length = 0;
  const res = await fetch(`http://localhost:${process.env.PORT}/api/examinations/papers/${PAPER}/pdf`, { headers: { Authorization: `Bearer ${tokenFor('coe')}` } });
  assert.equal(res.status, 200);
  const text = pdfText(Buffer.from(await res.arrayBuffer()));
  assert.match(text, /Maximum Marks: 14/); assert.match(text, /Answer all questions briefly\./);
  assert.ok(text.indexOf('Section A (2 questions, 4 marks)') >= 0 && text.indexOf('Section A (2 questions, 4 marks)') < text.indexOf('Section B (Attempt any 2 of 3 questions, 10 marks)'), text.slice(0, 400));
  assert.match(text, /Attempt any 2 of the 3 questions in this section\. Each question carries 5 marks\./);
  assert.equal(log.some((l) => /paper_blueprints/.test(l.text)), false, 'the PDF never reads the live blueprint');
});
test('printed paper: examination metadata, frozen CO codes and printed numbering; never the live CO mapping', async () => {
  paperStatus = 'VALIDATION_PENDING'; scriptSectionedPaper();
  sql(/FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id (JOIN programs pr ON pr.id = e.program_id )?WHERE ep.id/i, () => [{ id: PAPER, examination_id: EXAM.id,
    paper_status: paperStatus, campus_id: IDS.campusA, blueprint_version_id: 'bp1', generated_by: USERS.coe.id, format_config: FROZEN, title: 'end_term paper v1',
    candidate_metrics: { validation: { passed: true, errors: [], warnings: [], summary: { question_count: 5 } }, question_cos: { q1: ['CO1'], q3: ['CO2', 'CO3'] } } }]);
  sql(/FROM examinations e\s+JOIN subjects s/i, [{ subject_code: 'CS101', course_title: 'Intro', program_name: 'BTech', semester: 3, exam_type: 'end_term',
    exam_date: '2026-11-20', academic_session_label: '2026-27', campus_name: 'Main Campus' }]);
  const coe = await call('GET', `/examinations/papers/${PAPER}`, null, 'coe');
  assert.equal(coe.status, 200, JSON.stringify(coe.data));
  assert.deepEqual(coe.data.questions.map((q) => q.print_label), ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
  assert.deepEqual(coe.data.questions.map((q) => q.cos), [['CO1'], [], ['CO2', 'CO3'], [], []]);
  assert.equal(coe.data.candidate_metrics, undefined, 'the raw generation metrics stay internal');
  const { tokenFor } = await import('./harness.mjs');
  const { pdfText } = await import('./pdf-text.mjs');
  log.length = 0;
  const res = await fetch(`http://localhost:${process.env.PORT}/api/examinations/papers/${PAPER}/pdf`, { headers: { Authorization: `Bearer ${tokenFor('coe')}` } });
  assert.equal(res.status, 200);
  const text = pdfText(Buffer.from(await res.arrayBuffer()));
  for (const s of ['END SEMESTER EXAMINATION NOV. 2026', 'Main Campus', 'Name of the Program: BTech', 'Semester: III', 'Course Code: CS101',
    'Date: 20.11.2026', 'Q. No. Question Marks CO', 'CO2, CO3', 'Page 1 of 1']) assert.ok(text.includes(s), `${s} :: ${text.slice(0, 500)}`);
  assert.equal(log.some((l) => /question_course_outcomes|course_outcomes/.test(l.text)), false, 'CO codes come from the frozen paper, never the live mapping');
  assert.equal(log.some((l) => /paper_blueprints/.test(l.text)), false);
});
test('blueprint: internal choice rules are validated; sections are stored sanitised', async () => {
  const sec = (b) => ({ examination_id: EXAM.id, easy_count: 2, medium_count: 2, hard_count: 1, sections: [{ name: 'A', question_count: 2, marks_per_question: 4 }, { name: 'B', question_count: 3, marks_per_question: 5, ...b }] });
  const all3 = await call('POST', '/examinations/blueprints', sec({ attempt_count: 3 }), 'coe');
  assert.equal(all3.status, 400); assert.match(all3.data.reasons.join(' '), /must be fewer than the section's 3 question/);
  log.length = 0;
  const ok = await call('POST', '/examinations/blueprints', sec({ attempt_count: 2, instructions: '  Choose wisely  ', evil: 'x' }), 'coe');
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const stored = JSON.parse(log.find((l) => /INSERT INTO paper_blueprints/.test(l.text)).params[16]);
  assert.deepEqual(stored[1], { name: 'B', question_count: 3, marks_per_question: 5, instructions: 'Choose wisely', attempt_count: 2 });
  assert.equal((await call('POST', '/examinations/blueprints', { ...sec({}), sections: [1, 2] }, 'coe')).status, 400);
});

// ---- review fixes: scope re-checks, in-transaction audits and exclusion, printed-paper revisions ----
const scopeLostFor = (userId) => sql(/user_has_scope/i, (p) => [{ has_scope: p[0] !== userId }]);
test('a validator who lost validator scope keeps neither the paper, the answer key nor issue reporting (reason given)', async () => {
  scriptIssues();
  sql(/FROM paper_questions pq WHERE pq.paper_id/i, []);
  sql(/FROM examinations e\s+JOIN subjects s/i, [{ subject_code: 'CS101' }]);
  sql(/SELECT id AS assignment_id, validator_number, validation_round/i, []);
  for (const st of ['VALIDATION_PENDING', 'VALIDATED']) {
    paperStatus = st;
    assert.equal((await call('GET', `/examinations/papers/${PAPER}`, null, 'v1')).status, 200, `still eligible ${st}`);
  }
  scopeLostFor(USERS.v1.id); log.length = 0;
  const detail = await call('GET', `/examinations/papers/${PAPER}`, null, 'v1');
  assert.equal(detail.status, 403); assert.match(detail.data.error, /no longer work on this paper: Validator does not have required scope/);
  assert.equal((await call('GET', `/examinations/papers/${PAPER}/pdf?include_answers=1`, null, 'v1')).status, 403, 'no answer key');
  const scopeQ = log.find((l) => /SELECT user_has_scope\(\$1, \$2, \$3, \$4, \$5, \$6\)/.test(l.text) && l.params[1] === 'validator');
  assert.equal(scopeQ.params[2], IDS.campusA, 'the examination context is passed');
  log.length = 0;
  const rep = await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q1' }, 'v1');
  assert.equal(rep.status, 403); assert.match(rep.data.error, /required scope/);
  assert.equal(log.some((l) => /INSERT INTO paper_issues/.test(l.text)), false, 'nothing written');
  const lockedCheck = log.find((l) => /FROM users WHERE id = \$1 FOR SHARE/.test(l.text));
  assert.ok(lockedCheck && at(/FOR UPDATE/) < log.indexOf(lockedCheck), 're-checked inside the transaction, after the paper row lock');
  USERS.v1.status = 'INACTIVE';
  sql(/user_has_scope/i, [{ has_scope: true }]);
  assert.equal((await call('GET', `/examinations/papers/${PAPER}`, null, 'v1')).status, 403, 'deactivated validator');
  USERS.v1.status = 'ACTIVE';
});
test('issue report, resolve and refer write their audit row inside their transaction (with the change), before notifying', async () => {
  scriptIssues(); log.length = 0;
  const r = await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q1', question_id: Q1 }, 'v1');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(at(/INSERT INTO paper_issues/) < auditAt('paper_issue_reported') && auditAt('paper_issue_reported') < at(/INSERT INTO notifications/));
  sql(/INSERT INTO audit_log/i, () => { throw new Error('audit append failed'); });
  scriptIssues(); log.length = 0;
  const failed = await call('POST', ISSUES, { issue_type: 'spelling', description: 'typo in Q1' }, 'v1');
  assert.equal(failed.status, 500); assert.equal(log.some((l) => /INSERT INTO notifications/.test(l.text)), false, 'no notification for a rolled-back issue');
  sql(/INSERT INTO audit_log/i, []);
  paperStatus = 'VALIDATED'; scriptResolve(); log.length = 0;
  assert.equal((await call('POST', RESOLVE, { status: 'wont_fix', resolution: 'accepted as printed; minor wording' }, 'coe')).status, 200);
  assert.ok(at(/UPDATE paper_issues SET status = \$1/) < auditAt('paper_issue_resolved') && auditAt('paper_issue_resolved') < at(/INSERT INTO notifications/));
  scriptRefer(); log.length = 0;
  assert.equal((await call('POST', REFER, { note: 'please re-check the model answer' }, 'coe')).status, 201);
  assert.ok(at(/INSERT INTO paper_issue_referrals/) < auditAt('paper_issue_referred') && auditAt('paper_issue_referred') < at(/INSERT INTO notifications/));
});
test('regenerate: the flagged questions are read under the parent row lock; revision and audit record that list', async () => {
  paperStatus = 'CHANGES_REQUIRED'; nextVersion = 2;
  const flaggedId = pool[0].id;
  sql(/SELECT DISTINCT question_id FROM paper_issues WHERE paper_id = \$1 AND status = 'open'/i, [{ question_id: flaggedId }]);
  sql(/INSERT INTO paper_revisions/i, []);
  sql(/SET paper_status = 'REGENERATED' WHERE id = \$1 AND paper_status = \$2/i, [{ id: PAPER }]);
  log.length = 0;
  const r = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q1 incorrect' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(at(/pg_advisory_xact_lock/) < at(/FROM exam_papers WHERE id = \$1 FOR UPDATE/)
    && at(/FROM exam_papers WHERE id = \$1 FOR UPDATE/) < at(/SELECT DISTINCT question_id FROM paper_issues/), 'offering lock, parent lock, then the open issues');
  assert.equal(log.filter((l) => /SELECT DISTINCT question_id FROM paper_issues/.test(l.text)).length, 1, 'read once, inside the transaction');
  assert.equal(log.some((l) => /INSERT INTO paper_questions/.test(l.text) && l.params[1] === flaggedId), false, 'left out');
  const rev = log.find((l) => /INSERT INTO paper_revisions/.test(l.text) && /'question_regenerated'/.test(l.text));
  assert.deepEqual(JSON.parse(rev.params[5]).excluded_question_ids, [flaggedId]);
  assert.deepEqual(JSON.parse(log[auditAt('paper_generated')].params[4]).excluded_question_ids, [flaggedId]);
  // Closed meanwhile (seen under the lock): nothing is left out and nothing is recorded as excluded.
  sql(/SELECT DISTINCT question_id FROM paper_issues WHERE paper_id = \$1 AND status = 'open'/i, []); log.length = 0;
  const r2 = await call('POST', `/examinations/papers/${PAPER}/regenerate`, { reason: 'Q1 incorrect' }, 'coe');
  assert.equal(r2.status, 201);
  assert.deepEqual(JSON.parse(log.find((l) => /'question_regenerated'/.test(l.text)).params[5]).excluded_question_ids, []);
});
test('generate: refused while the examination has a printed paper (a change after PRINT_READY is a revision)', async () => {
  printedPapers = [{ id: PAPER, paper_version: 1, paper_status: 'PRINT_READY' }];
  const r = await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  assert.equal(r.status, 409, JSON.stringify(r.data)); assert.match(r.data.error, /use Revise on the printed paper/); assert.match(r.data.reasons[0], /v1 is PRINT_READY/);
  assert.equal(log.some((l) => /INSERT INTO exam_papers/.test(l.text)), false);
});
test('revise: a PRINT_READY paper gets a new revision (parent = the printed paper, revision row, audit); the printed paper is not touched', async () => {
  const url = `/examinations/papers/${PAPER}/revise`;
  sql(/INSERT INTO paper_revisions/i, []);
  paperStatus = 'PRINT_READY'; nextVersion = 2; printedPapers = [{ id: PAPER, paper_version: 1, paper_status: 'PRINT_READY' }];
  assert.equal((await call('POST', url, { reason: 'short' }, 'coe')).status, 400);
  for (const who of ['hod', 'v1', 'admin']) assert.equal((await call('POST', url, { reason: 'Q4 printed with a wrong figure' }, who)).status, 403, who);
  assert.equal((await call('POST', url, { reason: 'Q4 printed with a wrong figure', blueprint_id: BP_OTHER }, 'coe')).status, 400, 'own examination\'s blueprint only');
  log.length = 0;
  const r = await call('POST', url, { reason: 'Q4 printed with a wrong figure' }, 'coe');
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.paperVersion, 2);
  const ins = log.find((l) => /INSERT INTO exam_papers/.test(l.text));
  assert.equal(ins.params[14], PAPER, 'parent_paper_id = the printed paper');
  assert.equal(log.some((l) => /UPDATE exam_papers SET paper_status = '(REGENERATED|ARCHIVED)'/.test(l.text) && l.params[0] === PAPER), false, 'the printed paper stays PRINT_READY');
  const rev = log.find((l) => /INSERT INTO paper_revisions/.test(l.text));
  assert.equal(JSON.parse(rev.params[4]).revision_of_printed, true); assert.equal(rev.params[1], 2);
  assert.ok(at(/FROM exam_papers WHERE id = \$1 FOR UPDATE/) < at(/INSERT INTO exam_papers/) && at(/INSERT INTO paper_revisions/) < auditAt('printed_paper_revision_started')
    && auditAt('printed_paper_revision_started') < auditAt('paper_generated'), 'printed paper locked first; revision row, then the audit rows');
  for (const st of ['GENERATED', 'CHANGES_REQUIRED', 'COE_APPROVED', 'ARCHIVED']) {
    paperStatus = st;
    assert.equal((await call('POST', url, { reason: 'Q4 printed with a wrong figure' }, 'coe')).status, 409, st);
  }
  paperStatus = 'PRINT_READY'; livePapers = [{ id: 'rev-in-progress', paper_version: 2, paper_status: 'GENERATED' }];
  assert.equal((await call('POST', url, { reason: 'Q4 printed with a wrong figure' }, 'coe')).status, 409, 'a revision already in progress');
  livePapers = []; lockedStatus = 'ARCHIVED';
  assert.equal((await call('POST', url, { reason: 'Q4 printed with a wrong figure' }, 'coe')).status, 409, 'archived under the row lock');
});
test('a COE scoped to another program of the same campus cannot read, assign, regenerate or list this examination\'s papers', async () => {
  coeOutOfScope();
  paperStatus = 'VALIDATED';
  assert.equal((await call('GET', `/examinations/papers/${PAPER}`, null, 'coe')).status, 403);
  assert.equal((await call('GET', `/examinations/papers/${PAPER}/pdf?include_answers=1`, null, 'coe')).status, 403, 'no answer key');
  paperStatus = 'GENERATED';
  assert.equal((await call('POST', `/examinations/papers/${PAPER}/validators`, { validator_ids: four() }, 'coe')).status, 403);
  assert.equal((await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe')).status, 403);
  log.length = 0;
  sql(/FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id JOIN subjects s/i, []);
  await call('GET', '/examinations/papers', null, 'coe');
  const list = log.find((l) => /FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id JOIN subjects s/.test(l.text));
  assert.match(list.text, /user_has_scope\(\$1, 'coe', e.campus_id, pr.department_id, e.program_id, e.course_offering_id\)/, 'list filtered by the full scope');
});
test('recency: printed papers count whether or not they were archived afterwards', async () => {
  log.length = 0;
  await call('POST', `/examinations/${EXAM.id}/generate`, { blueprint_id: 'bp1' }, 'coe');
  const q = log.find((l) => /FROM question_usage qu/.test(l.text));
  assert.match(q.text, /locked_at IS NOT NULL AND paper_status IN \('PRINT_READY', 'ARCHIVED'\)/);
});

// ---- phase 4a: diagrams of paper questions (snapshot attachments), inline PDF ----
const ATT_OK = 'a7000000-0000-0000-0000-000000000001';
const ATT_OTHER = 'a7000000-0000-0000-0000-000000000002';
const PQ_Q = 'a7100000-0000-0000-0000-000000000001';
const PNG4A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function withDiagram(fn, { snapshotAttachments = true, live = {} } = {}) {
  const fs = await import('node:fs'); const path = await import('node:path');
  const { UPLOAD_DIR } = await import('../src/attachment-scan.js');
  const rel = `p4a-${process.pid}.png`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true }); fs.writeFileSync(path.join(UPLOAD_DIR, rel), PNG4A);
  const meta = { question_type: 'diagram', model_answer: 'root and leaves',
    ...(snapshotAttachments ? { attachments: [{ id: ATT_OK, file_name: 'tree.png', file_type: 'image/png', file_hash: 'h1' }] } : {}) };
  const row = { id: ATT_OK, question_id: PQ_Q, file_name: 'tree.png', file_type: 'image/png', file_hash: 'h1', file_path: rel, scan_status: 'clean',
    created_at: '2026-01-01T00:00:00Z', ...live };
  sql(/FROM paper_questions pq WHERE pq.paper_id/i, [{ slot_number: 1, question_id: PQ_Q, question_text_snapshot: 'Label the tree', text: 'Label the tree',
    marks_snapshot: 2, marks: 2, metadata_snapshot: meta, meta }]);
  sql(/FROM paper_questions pq JOIN question_attachments a ON a.question_id = pq.question_id WHERE pq.paper_id = \$1 AND a.id = \$2/i,
    (p) => (p[1] === ATT_OK ? [{ question_id: PQ_Q, metadata_snapshot: meta }] : []));
  sql(/FROM question_attachments a WHERE a.question_id = ANY\(\$1::uuid\[\]\)/i, () => [row]);
  sql(/FROM examinations e\s+JOIN subjects s/i, [{ subject_code: 'CS101' }]);
  sql(/SELECT id AS assignment_id, validator_number, validation_round/i, []);
  sql(/SELECT (1 AS x|id, assigned_by) FROM paper_validator_assignments WHERE paper_id/i, (p) => (p[1] === USERS.v1.id ? [{ x: 1, id: 'asg1', assigned_by: USERS.coe.id }] : []));
  try { await fn(); } finally { fs.rmSync(path.join(UPLOAD_DIR, rel), { force: true }); }
}
const fileOf = async (who, att = ATT_OK) => {
  const { tokenFor } = await import('./harness.mjs');
  const r = await fetch(`http://localhost:${process.env.PORT}/api/examinations/papers/${PAPER}/attachments/${att}`, { headers: { Authorization: `Bearer ${tokenFor(who)}` } });
  return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), body: Buffer.from(await r.arrayBuffer()) };
};

test('paper view lists each question\'s snapshot attachments (no storage path); COE and the assigned validator open them, nobody else', async () => {
  paperStatus = 'VALIDATION_PENDING';
  await withDiagram(async () => {
    const v = await call('GET', `/examinations/papers/${PAPER}`, null, 'coe');
    assert.equal(v.status, 200, JSON.stringify(v.data));
    assert.deepEqual(v.data.questions[0].attachments, [{ id: ATT_OK, file_name: 'tree.png', file_type: 'image/png', available: true }]);
    assert.equal(v.data.questions[0].meta.model_answer, 'root and leaves', 'answer key inline for the COE');
    const vv = await call('GET', `/examinations/papers/${PAPER}`, null, 'v1');
    assert.equal(vv.status, 200); assert.equal(vv.data.questions[0].meta.model_answer, 'root and leaves', 'answer key inline for the validator');
    const coe = await fileOf('coe');
    assert.equal(coe.status, 200); assert.match(coe.type, /image\/png/); assert.equal(coe.cache, 'no-store'); assert.ok(coe.body.equals(PNG4A));
    assert.equal((await fileOf('v1')).status, 200, 'assigned validator while under validation');
    for (const who of ['v2', 'hod', 'teacher', 'reviewer', 'admin']) assert.equal((await fileOf(who)).status, 403, who);
    assert.equal((await fileOf('coe', ATT_OTHER)).status, 404, 'a file of a question that is not in this paper');
    assert.equal((await fileOf('coe', 'not-a-uuid')).status, 404);
    paperStatus = 'PRINT_READY';
    assert.equal((await fileOf('v1')).status, 403, 'validators lose the diagrams with the paper');
    assert.equal((await fileOf('coe')).status, 200);
  });
  coeOutOfScope();
  await withDiagram(async () => assert.equal((await fileOf('coe')).status, 403, 'COE out of scope'));
});

test('paper diagrams: a replaced (other hash) or quarantined file is not served; a pre-041 snapshot refers only to files older than the paper', async () => {
  paperStatus = 'VALIDATION_PENDING';
  await withDiagram(async () => {
    assert.equal((await fileOf('coe')).status, 404);
    const v = await call('GET', `/examinations/papers/${PAPER}`, null, 'coe');
    assert.equal(v.data.questions[0].attachments[0].available, false);
  }, { live: { file_hash: 'other' } });
  await withDiagram(async () => assert.equal((await fileOf('coe')).status, 404), { live: { file_path: 'quarantine/x.png' } });
  // Legacy snapshot (no attachments key): only files that existed when the paper was generated.
  sql(/FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id (JOIN programs pr ON pr.id = e.program_id )?WHERE ep.id/i, () => [{ id: PAPER, examination_id: EXAM.id,
    paper_status: 'VALIDATION_PENDING', campus_id: IDS.campusA, blueprint_version_id: 'bp1', generated_by: USERS.coe.id, generated_at: '2026-06-01T00:00:00Z' }]);
  await withDiagram(async () => {
    assert.equal((await fileOf('coe')).status, 200);
    const v = await call('GET', `/examinations/papers/${PAPER}`, null, 'coe');
    assert.equal(v.data.questions[0].attachments[0].legacy_reference, true);
  }, { snapshotAttachments: false });
  await withDiagram(async () => assert.equal((await fileOf('coe')).status, 404, 'added after the paper was generated'),
    { snapshotAttachments: false, live: { created_at: '2026-07-01T00:00:00Z' } });
});

test('pdf: the snapshot\'s diagram is embedded; ?inline=1 serves it for preview/print (audited as inline)', async () => {
  paperStatus = 'VALIDATION_PENDING';
  const { tokenFor } = await import('./harness.mjs');
  await withDiagram(async () => {
    const res = await fetch(`http://localhost:${process.env.PORT}/api/examinations/papers/${PAPER}/pdf?inline=1&include_answers=1`, { headers: { Authorization: `Bearer ${tokenFor('coe')}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^inline; filename=/);
    assert.match(Buffer.from(await res.arrayBuffer()).toString('latin1'), /\/Subtype \/Image/);
    const a = log.filter((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'paper_pdf_downloaded').at(-1);
    assert.deepEqual(JSON.parse(a.params[4]), { include_answers: true, paper_status: 'VALIDATION_PENDING', inline: true });
    const dl = await fetch(`http://localhost:${process.env.PORT}/api/examinations/papers/${PAPER}/pdf`, { headers: { Authorization: `Bearer ${tokenFor('coe')}` } });
    assert.match(dl.headers.get('content-disposition'), /^attachment; filename=/);
    await dl.arrayBuffer();
    assert.equal((await call('GET', `/examinations/papers/${PAPER}/pdf?inline=1`, null, 'hod')).status, 403);
  });
});
