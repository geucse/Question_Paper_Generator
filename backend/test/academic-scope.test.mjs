// Phase 3: object-level and campus/department scope on every academic route (PIVOT_SPEC_V2 §2, §4, §39.2/.8;
// implementation prompt §4, §5 criterion 6). The scope-aware world (harness installWorld) has three contexts:
// A1 (campus A, dept), A2 (campus A, another department), B1 (campus B). Every row of the IDOR matrix targets one
// context's objects; any actor not listed must get 403 (or the row's own denial code) and cause no write.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, log, baseRules, start, call, USERS, IDS, CTX, oid, PYP_NULL, installWorld, WORLD, writes } from './harness.mjs';

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => { baseRules(); installWorld(); });

const ACTORS = ['hod', 'hodA2', 'hodB', 'teacher', 'teacherA2', 'teacherB', 'reviewer', 'reviewerA2', 'reviewerB', 'admin', 'coe', 'v1'];
const fresh = () => { baseRules(); installWorld(); };

// The matrix rows for the objects of context X. allowed: actor keys that may act; deny(actor): the expected
// denial status when it is not 403.
function rows(X) {
  const c = CTX[X];
  const [h, t, r] = [c.hod, c.teacher, c.reviewer];
  const A = '/academic';
  const isHod = (who) => USERS[who].role === 'hod';
  return [
    ['GET', `${A}/sections?course_offering_id=${c.off}`, null, [h, 'admin']],
    ['POST', `${A}/sections`, { course_offering_id: c.off, name: 'B' }, [h, 'admin']],
    ['GET', `${A}/assignments/teacher?course_offering_id=${c.off}`, null, [h]],
    ['POST', `${A}/assignments/teacher`, { teacher_id: USERS[t].id, course_offering_id: c.off, section_id: oid('section', X) }, [h]],
    ['POST', `${A}/assignments/teacher/${oid('tca', X)}/deactivate`, null, [h]],
    ['GET', `${A}/assignments/reviewer?course_offering_id=${c.off}`, null, [h]],
    ['POST', `${A}/assignments/reviewer`, { reviewer_id: USERS[r].id, course_offering_id: c.off }, [h]],
    ['POST', `${A}/assignments/reviewer/${oid('ra', X)}/deactivate`, null, [h]],
    ['GET', `${A}/syllabus-versions?course_offering_id=${c.off}`, null, [h, t]],
    ['POST', `${A}/syllabus-versions`, { course_offering_id: c.off, notes: 'Unit 1: trees' }, [h]],
    ['POST', `${A}/syllabus-versions/${oid('sv_draft', X)}/verify`, null, [h]],
    ['POST', `${A}/syllabus-versions/${oid('sv_draft', X)}/reject`, { reason: 'incomplete' }, [h]],
    ['POST', `${A}/syllabus-versions/${oid('sv_pending', X)}/approve`, null, [h]],
    ['GET', `${A}/syllabus-versions/${c.sv}/course-outcomes`, null, [h, t, r]],
    ['GET', `${A}/course-offerings/${c.off}/course-outcomes`, null, [h, t, r]],
    ['GET', `${A}/syllabus-versions/${c.sv}/units`, null, [h, t, r]],
    ['GET', `${A}/course-offerings/${c.off}/units`, null, [h, t, r]],
    ['GET', `${A}/units/${oid('unit', X)}/topics`, null, [h, t, r]],
    ['GET', `${A}/topics/${oid('topic', X)}/subtopics`, null, [h, t, r]],
    // Content writes target the DRAFT version (only a draft's content may change, migration 042).
    ['POST', `${A}/syllabus-versions/${oid('sv_draft', X)}/course-outcomes`, { code: 'CO9', description: 'Explain' }, [h]],
    ['POST', `${A}/course-outcomes/${oid('co_d', X)}/deactivate`, null, [h]],
    ['POST', `${A}/syllabus-versions/${oid('sv_draft', X)}/units`, { code: 'U9', title: 'Graphs' }, [h]],
    ['POST', `${A}/units/${oid('unit_d', X)}/topics`, { title: 'BFS' }, [h]],
    ['POST', `${A}/units/${oid('unit_d', X)}/deactivate`, null, [h]],
    ['POST', `${A}/topics/${oid('topic_d', X)}/deactivate`, null, [h]],
    ['POST', `${A}/topics/${oid('topic_d', X)}/subtopics`, { title: 'Rotations' }, [h]],
    ['POST', `${A}/subtopics/${oid('subtopic_d', X)}/deactivate`, null, [h]],
    ['GET', `${A}/previous-year-papers?course_offering_id=${c.off}`, null, [h]],
    ['POST', `${A}/previous-year-papers`, { course_offering_id: c.off, year: 2025, questions: ['Define a heap.'] }, [h]],
    ['DELETE', `${A}/previous-year-papers/${oid('pyp', X)}`, null, [h]],
    // Another department's teacher is not confirmed to an HOD: 404 rather than 403.
    ['GET', `/questions/mistakes/${USERS[t].id}`, null, [h], (who) => (isHod(who) ? 404 : 403)],
  ];
}

for (const X of ['A1', 'B1']) {
  for (const [method, path, body, allowed, deny] of rows(X)) {
    test(`IDOR ${X}: ${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} allowed for ${allowed.join(', ')} only`, async () => {
      for (const who of ACTORS) {
        fresh();
        const r = await call(method, path, body, who);
        if (allowed.includes(who)) {
          assert.ok(r.status >= 200 && r.status < 300, `${who}: ${r.status} ${JSON.stringify(r.data)}`);
        } else {
          assert.equal(r.status, deny ? deny(who) : 403, `${who}: ${JSON.stringify(r.data)}`);
          assert.deepEqual(writes().map((l) => l.text.slice(0, 60)), [], `${who} caused a write`);
        }
      }
    });
  }
}

test('admin is technical-only: academic content and staffing refused (and logged), structure allowed', async () => {
  sql(/FROM campuses WHERE is_active/i, [{ id: IDS.campusA, name: 'A' }]);
  sql(/FROM colleges WHERE is_active/i, []);
  sql(/FROM users u LEFT JOIN departments d/i, []);
  for (const path of ['/academic/campuses', `/academic/colleges?campus_id=${IDS.campusA}`, '/academic/users', `/academic/sections?course_offering_id=${IDS.off}`]) {
    assert.equal((await call('GET', path, null, 'admin')).status, 200, path);
  }
  for (const path of ['/academic/teachers', '/academic/reviewers', `/academic/previous-year-papers?course_offering_id=${IDS.off}`, `/questions/mistakes/${USERS.teacher.id}`]) {
    assert.equal((await call('GET', path, null, 'admin')).status, 403, path);
  }
  fresh();
  assert.equal((await call('POST', `/academic/syllabus-versions/${IDS.sv}/reject`, { reason: 'x' }, 'admin')).status, 403);
  assert.equal((await call('POST', `/academic/course-outcomes/${oid('co', 'A1')}/deactivate`, null, 'admin')).status, 403);
  assert.deepEqual(writes(), []);
  // A structure route the admin may use runs through authorize('technical_admin'); the decision is logged.
  fresh();
  assert.equal((await call('POST', '/academic/sections', { course_offering_id: IDS.off, name: 'C' }, 'admin')).status, 200);
  assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[1] === 'technical_admin' && l.params[4] === 'allow'));
  // The central authorize() refuses admin for academic actions and logs admin_technical_only.
  const { authorize } = await import('../src/authorization.js');
  log.length = 0;
  const a = await authorize(USERS.admin, 'manage_academic_context', { type: 'course_offering', id: IDS.off, campus_id: IDS.campusA, department_id: IDS.dept });
  assert.equal(a.allowed, false);
  assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[4] === 'deny' && l.params[5] === 'admin_technical_only'));
});

test('malformed ids are 404 (or 400 for a query/body id), never a 500', async () => {
  assert.equal((await call('GET', '/academic/units/not-a-uuid/topics', null, 'hod')).status, 404);
  assert.equal((await call('POST', '/academic/course-outcomes/xyz/deactivate', null, 'hod')).status, 404);
  assert.equal((await call('DELETE', '/academic/previous-year-papers/abc', null, 'hod')).status, 404);
  assert.equal((await call('GET', '/academic/sections?course_offering_id=abc', null, 'hod')).status, 404);
  assert.equal((await call('POST', '/academic/assignments/teacher/abc/deactivate', null, 'hod')).status, 404);
  assert.equal((await call('GET', '/questions/mistakes/abc', null, 'hod')).status, 404);
  assert.equal((await call('GET', '/academic/colleges?campus_id=abc', null, 'admin')).status, 400);
  assert.equal(log.some((l) => /FROM syllabus_topics|FROM course_outcomes|FROM previous_year_papers/.test(l.text)), false);
});

test('a reviewer reads syllabus content only with an active assignment AND reviewer scope', async () => {
  const path = `/academic/course-offerings/${IDS.off}/units`;
  assert.equal((await call('GET', path, null, 'reviewer')).status, 200);
  WORLD.scopes.filter((s) => s.user_id === USERS.reviewer.id).forEach((s) => { s.is_active = false; });
  assert.equal((await call('GET', path, null, 'reviewer')).status, 403, 'scope revoked');
  fresh();
  WORLD.ra.find((a) => a.reviewer_id === USERS.reviewer.id).is_active = false;
  assert.equal((await call('GET', path, null, 'reviewer')).status, 403, 'assignment ended');
});

test('verify: only the HOD in scope; a teacher of the offering is refused, even the one who uploaded the version', async () => {
  const path = `/academic/syllabus-versions/${oid('sv_draft', 'A1')}/verify`;
  let r = await call('POST', path, null, 'teacher');
  assert.equal(r.status, 403, 'the uploading teacher can no longer verify the official syllabus');
  fresh();
  WORLD.tca.push({ id: '66660000-0000-0000-0000-0000000000ff', teacher_id: USERS.teacherA2.id, course_offering_id: IDS.off, is_active: true });
  r = await call('POST', path, null, 'teacherA2');
  assert.equal(r.status, 403);
  assert.deepEqual(writes(), [], 'a refused verification writes nothing');
  fresh();
  assert.equal((await call('POST', path, null, 'hod')).status, 200);
});

test('teacher assignment: section must be an active section of the offering; teacher active and in the HOD\'s department', async () => {
  const body = (over = {}) => ({ teacher_id: USERS.teacher.id, course_offering_id: IDS.off, ...over });
  let r = await call('POST', '/academic/assignments/teacher', body({ section_id: oid('section', 'A2') }), 'hod');
  assert.equal(r.status, 400); assert.match(r.data.error, /does not belong to this course offering/);
  assert.equal((await call('POST', '/academic/assignments/teacher', body({ section_id: oid('section_off', 'A1') }), 'hod')).status, 400, 'inactive section');
  assert.equal((await call('POST', '/academic/assignments/teacher', body({ section_id: 'nope' }), 'hod')).status, 400);
  assert.equal((await call('POST', '/academic/assignments/teacher', body({ teacher_id: USERS.teacherA2.id }), 'hod')).status, 403, 'teacher of another department');
  assert.equal((await call('POST', '/academic/assignments/teacher', body({ teacher_id: USERS.reviewer.id }), 'hod')).status, 404, 'not a teacher');
  assert.deepEqual(writes(), []);
  USERS.teacher.is_active = false;
  try {
    assert.equal((await call('POST', '/academic/assignments/teacher', body(), 'hod')).status, 400, 'inactive teacher');
  } finally { USERS.teacher.is_active = true; }
  r = await call('POST', '/academic/assignments/teacher', body({ section_id: oid('section', 'A1') }), 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ins = log.find((l) => /^INSERT INTO teacher_course_assignments/.test(l.text));
  assert.deepEqual(ins.params.slice(0, 3), [USERS.teacher.id, IDS.off, oid('section', 'A1')]);
  const grant = log.find((l) => /^INSERT INTO user_scopes/.test(l.text));
  assert.deepEqual(grant.params, [USERS.teacher.id, 'teacher', IDS.campusA, IDS.dept, IDS.prog, IDS.off, USERS.hod.id], 'granted_by records the HOD');
  sql(/^INSERT INTO teacher_course_assignments/i, () => { throw Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505' }); });
  r = await call('POST', '/academic/assignments/teacher', body(), 'hod');
  assert.equal(r.status, 409); assert.doesNotMatch(JSON.stringify(r.data), /duplicate key/, 'no database text');
});

test('ending an assignment revokes the scope it granted, audited; a second deactivate is 409', async () => {
  let r = await call('POST', `/academic/assignments/teacher/${oid('tca', 'A1')}/deactivate`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.scopes_revoked, 1);
  const rev = log.find((l) => /^UPDATE user_scopes SET is_active = FALSE/.test(l.text));
  assert.match(rev.text, /course_offering_id IS NOT DISTINCT FROM \$6::uuid/);
  assert.deepEqual(rev.params, [USERS.teacher.id, 'teacher', IDS.campusA, IDS.dept, IDS.prog, IDS.off, USERS.hod.id, 'assignment_ended']);
  assert.match(rev.text, /revoked_at = now\(\), revoked_by = \$7, revoke_reason = \$8/, 'scope history recorded on the row');
  const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'teacher_unassigned');
  const details = JSON.parse(audit.params[4]);
  assert.equal(details.scopes_revoked.length, 1); assert.equal(details.reason, 'assignment_deactivated');
  assert.equal(WORLD.scopes.find((s) => s.user_id === USERS.teacher.id && s.role === 'teacher').is_active, false);
  assert.equal((await call('POST', `/academic/assignments/teacher/${oid('tca', 'A1')}/deactivate`, null, 'hod')).status, 409);

  r = await call('POST', `/academic/assignments/reviewer/${oid('ra', 'A1')}/deactivate`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rrev = log.findLast((l) => /^UPDATE user_scopes SET is_active = FALSE/.test(l.text));
  assert.match(rrev.text, /NOT EXISTS \(SELECT 1 FROM reviewer_assignments ra JOIN course_offerings co ON co.id = ra.course_offering_id WHERE ra.reviewer_id = \$1 AND ra.is_active AND co.program_id = \$5::uuid\)/);
  assert.deepEqual(rrev.params, [USERS.reviewer.id, 'reviewer', IDS.campusA, IDS.dept, IDS.prog, null, USERS.hod.id, 'assignment_ended']);
  assert.equal(WORLD.scopes.find((s) => s.user_id === USERS.reviewer.id && s.role === 'reviewer').revoked_by, USERS.hod.id);
  // The reviewer lost its scope with its last assignment in the program: no more syllabus reads.
  assert.equal((await call('GET', `/academic/course-offerings/${IDS.off}/units`, null, 'reviewer')).status, 403);
});

test('a reviewer keeps its program scope while another assignment in the program is active', async () => {
  WORLD.ra.push({ id: '77770000-0000-0000-0000-0000000000ee', reviewer_id: USERS.reviewer.id, course_offering_id: IDS.off, is_active: true });
  const r = await call('POST', `/academic/assignments/reviewer/${oid('ra', 'A1')}/deactivate`, null, 'hod');
  assert.equal(r.status, 200); assert.equal(r.data.scopes_revoked, 0);
});

test('approve: the scope check comes before the status check (an out-of-scope HOD learns nothing)', async () => {
  const draft = oid('sv_draft', 'A1');
  assert.equal((await call('POST', `/academic/syllabus-versions/${draft}/approve`, null, 'hodB')).status, 403);
  assert.equal((await call('POST', `/academic/syllabus-versions/${draft}/approve`, null, 'hodA2')).status, 403);
  const r = await call('POST', `/academic/syllabus-versions/${draft}/approve`, null, 'hod');
  assert.equal(r.status, 400); assert.match(r.data.error, /teacher-verified and submitted for HOD review/);
  WORLD.versions[draft].status = 'TEACHER_VERIFIED';
  const r2 = await call('POST', `/academic/syllabus-versions/${draft}/approve`, null, 'hod');
  assert.equal(r2.status, 400); assert.match(r2.data.error, /submitted for HOD review/);
  assert.deepEqual(writes(), []);
});

test('approve: only a version in HOD review (the ACTIVE, a superseded or a rejected one is refused and nothing is written)', async () => {
  for (const status of ['ACTIVE', 'SUPERSEDED', 'REJECTED']) {
    WORLD.versions[IDS.sv].status = status;
    log.length = 0;
    const r = await call('POST', `/academic/syllabus-versions/${IDS.sv}/approve`, null, 'hod');
    assert.equal(r.status, 409, status); assert.match(r.data.error, /Only a syllabus version in HOD review/);
    assert.deepEqual(writes(), [], status);
  }
  WORLD.versions[IDS.sv].status = 'ACTIVE';
  // Incomplete content (no unit with a topic, no CO) is refused before the transaction.
  sql(/^SELECT syllabus_version_content_problems\(\$1\) AS problems/i, [{ problems: ['at least one active course outcome'] }]);
  log.length = 0;
  const inc = await call('POST', `/academic/syllabus-versions/${oid('sv_pending', 'A1')}/approve`, null, 'hod');
  assert.equal(inc.status, 400); assert.match(inc.data.error, /at least one active course outcome/);
  assert.deepEqual(writes(), []);
  fresh();
  // A version in HOD review is approved; the conditional re-check runs under the offering lock, the previous version
  // is superseded before the new one becomes ACTIVE, then the offering points at it.
  const ok = await call('POST', `/academic/syllabus-versions/${oid('sv_pending', 'A1')}/approve`, null, 'hod');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.previous_version_id, IDS.sv);
  const at = (re) => log.findIndex((l) => re.test(l.text));
  const lockAt = at(/FROM course_offerings WHERE id = \$1 FOR UPDATE/);
  const recheck = at(/^SELECT id, version_number, verified_by FROM syllabus_versions WHERE id = \$1 AND status = 'HOD_REVIEW' FOR UPDATE/);
  const supersede = at(/^UPDATE syllabus_versions SET status = 'SUPERSEDED', superseded_by_version_id = \$1/);
  const activate = at(/^UPDATE syllabus_versions SET status = 'ACTIVE', approved_by = \$1/);
  const pointer = at(/^UPDATE course_offerings SET syllabus_version_id = \$1/);
  assert.ok(lockAt >= 0 && recheck > lockAt && supersede > recheck && activate > supersede && pointer > activate, JSON.stringify([lockAt, recheck, supersede, activate, pointer]));
  assert.equal(log[supersede].params[1], IDS.sv); assert.equal(log[activate].params[0], USERS.hod.id);
  // Decided meanwhile (a concurrent approval won): 409, nothing switched.
  fresh();
  sql(/^SELECT id, version_number, verified_by FROM syllabus_versions WHERE id = \$1 AND status = 'HOD_REVIEW' FOR UPDATE/i, []);
  log.length = 0;
  assert.equal((await call('POST', `/academic/syllabus-versions/${oid('sv_pending', 'A1')}/approve`, null, 'hod')).status, 409);
  assert.equal(log.some((l) => /^UPDATE (syllabus_versions|course_offerings|questions)/.test(l.text)), false);
});

test('GET /academic/reviewers: workload counts only offerings the calling HOD covers (no other department\'s figures)', async () => {
  log.length = 0;
  assert.equal((await call('GET', '/academic/reviewers', null, 'hod')).status, 200);
  const q = log.find((l) => /AS active_offerings/.test(l.text));
  const inScope = q.text.match(/JOIN course_offerings co ON co.id = ra.course_offering_id JOIN programs p ON p.id = co.program_id AND \(co.campus_id IS NOT NULL AND p.department_id IS NOT NULL AND user_has_scope\(\$1, 'hod', co.campus_id, p.department_id, NULL, NULL\)\)/g) || [];
  assert.equal(inScope.length, 3, 'active_offerings, pending_questions and awaiting_activation are each limited to the HOD\'s scope');
  assert.deepEqual(q.params, [USERS.hod.id]);
});

test('a reviewer scope limited to one program does not cover another program of the same department', async () => {
  const P2 = 'f0000000-0000-0000-0000-0000000000c2'; const OFF2 = 'a0000000-0000-0000-0000-0000000000c2';
  WORLD.offerings[OFF2] = { course_offering_id: OFF2, program_id: P2, campus_id: IDS.campusA, department_id: IDS.dept, subject_id: IDS.subj, syllabus_version_id: null };
  WORLD.ra.push({ id: '77770000-0000-0000-0000-0000000000c2', reviewer_id: USERS.reviewer.id, course_offering_id: OFF2, is_active: true });
  // The reviewer's scope (from its A1 assignment) is program-level: IDS.prog only.
  const r = await call('GET', `/academic/course-offerings/${OFF2}/units`, null, 'reviewer');
  assert.equal(r.status, 403, 'the assignment alone does not widen a program-limited scope');
  const chk = log.filter((l) => /^SELECT user_has_scope\(\$1, \$2/.test(l.text) && l.params[1] === 'reviewer').pop();
  assert.equal(chk.params[4], P2, 'the program is part of the check');
  assert.equal((await call('GET', `/academic/course-offerings/${IDS.off}/units`, null, 'reviewer')).status, 200, 'its own program still works');
  // The same rule for reviewing a question of that other program (authorize('review_question')).
  const Q2 = '9a000000-0000-0000-0000-0000000000c2';
  WORLD.questions.push({ id: Q2, submitted_by: USERS.teacher.id, course_offering_id: OFF2 });
  const { authorize } = await import('../src/authorization.js');
  assert.equal((await authorize(USERS.reviewer, 'review_question', { question_id: Q2 })).allowed, false);
  assert.equal((await authorize(USERS.reviewer, 'review_question', { question_id: oid('question', 'A1') })).allowed, true);
  // Widened by the admin to the whole department: then the assignment decides.
  WORLD.scopes.push({ id: '5c0000ff-0000-0000-0000-000000000000', user_id: USERS.reviewer.id, role: 'reviewer', campus_id: IDS.campusA, department_id: IDS.dept, program_id: null, course_offering_id: null, is_active: true });
  assert.equal((await authorize(USERS.reviewer, 'review_question', { question_id: Q2 })).allowed, true);
});

test('previous-year papers: subject-wide rows listed read-only; deleted only by an HOD covering every offering of the subject', async () => {
  const g = await call('GET', `/academic/previous-year-papers?course_offering_id=${IDS.off}`, null, 'hod');
  assert.equal(g.status, 200);
  const q = log.find((l) => /FROM previous_year_papers p LEFT JOIN users u/.test(l.text));
  assert.match(q.text, /p.course_offering_id = \$1 OR \(p.course_offering_id IS NULL AND p.subject_id = \$2\)/);
  assert.deepEqual(q.params, [IDS.off, IDS.subj]);
  assert.ok(g.data.some((row) => row.id === PYP_NULL && row.subject_wide === true));
  assert.equal((await call('DELETE', `/academic/previous-year-papers/${PYP_NULL}`, null, 'hodA2')).status, 403, 'covers no offering of the subject');
  assert.deepEqual(writes(), []);
  assert.equal((await call('DELETE', `/academic/previous-year-papers/${PYP_NULL}`, null, 'hod')).status, 200);
  const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'previous_year_paper_removed');
  assert.equal(JSON.parse(audit.params[4]).subject_wide, true);
  fresh();
  WORLD.offerings['a0000000-0000-0000-0000-0000000000b9'] = { ...WORLD.offerings[IDS.offB], course_offering_id: 'a0000000-0000-0000-0000-0000000000b9', subject_id: IDS.subj };
  const d = await call('DELETE', `/academic/previous-year-papers/${PYP_NULL}`, null, 'hod');
  assert.equal(d.status, 403); assert.match(d.data.error, /also applies to course offerings outside/);
  assert.deepEqual(writes(), []);
});

test('/questions/mistakes: in-scope teacher only; every figure limited to offerings the HOD covers', async () => {
  const r = await call('GET', `/questions/mistakes/${USERS.teacher.id}`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const qs = log.filter((l) => /^SELECT .* FROM questions q JOIN course_offerings co/.test(l.text) && /submitted_by = \$3/.test(l.text));
  assert.equal(qs.length, 5);
  for (const l of qs) {
    assert.match(l.text, /EXISTS \( SELECT 1 FROM user_scopes s WHERE s.user_id = \$1 AND s.role = \$2/);
    // The type-aware incomplete check also passes the printable image types (diagram rule).
    assert.deepEqual(l.params, /diagram_image_count/.test(l.text) ? [USERS.hod.id, 'hod', USERS.teacher.id, ['image/png', 'image/jpeg']] : [USERS.hod.id, 'hod', USERS.teacher.id]);
  }
  assert.equal((await call('GET', `/questions/mistakes/${USERS.teacherA2.id}`, null, 'hod')).status, 404);
  assert.equal((await call('GET', `/questions/mistakes/${USERS.teacherB.id}`, null, 'hod')).status, 404);
  assert.equal((await call('GET', `/questions/mistakes/${USERS.reviewer.id}`, null, 'hod')).status, 404, 'not a teacher');
  for (const who of ['admin', 'teacher', 'reviewer', 'coe']) assert.equal((await call('GET', `/questions/mistakes/${USERS.teacher.id}`, null, who)).status, 403, who);
});

test('HOD list routes are filtered through user_scopes (never users.department_id); a reviewer sees only assigned, in-scope offerings', async () => {
  for (const path of ['/academic/course-offerings', '/academic/departments', '/academic/programs', '/academic/teachers', '/academic/reviewers', '/academic/users']) {
    log.length = 0;
    assert.equal((await call('GET', path, null, 'hod')).status, 200, path);
    const q = log.find((l) => /user_has_scope\(\$1, 'hod'/.test(l.text));
    assert.ok(q, `${path} has the hod scope predicate`);
    assert.match(q.text, /IS NOT NULL AND .* IS NOT NULL AND user_has_scope\(\$1, 'hod'/, `${path} refuses rows with an unknown campus/department`);
    assert.equal(q.params[0], USERS.hod.id);
    assert.doesNotMatch(q.text, /department_id = \$1/);
  }
  log.length = 0;
  await call('GET', '/academic/course-offerings', null, 'reviewer');
  const rq = log.find((l) => /FROM course_offerings co JOIN subjects/.test(l.text));
  assert.match(rq.text, /reviewer_assignments WHERE reviewer_id = \$1 AND is_active = TRUE/); assert.match(rq.text, /user_has_scope\(\$1, 'reviewer'/);
  log.length = 0;
  await call('GET', '/academic/departments', null, 'admin');
  const aq = log.find((l) => /FROM departments d/.test(l.text));
  assert.doesNotMatch(aq.text, /user_has_scope/); assert.match(aq.text, /LEFT JOIN campuses ca/); assert.match(aq.text, /LEFT JOIN colleges cl/);
  for (const who of ['admin', 'teacher', 'coe']) assert.equal((await call('GET', '/academic/teachers', null, who)).status, 403, who);
});

test('POST /academic/departments: college resolved explicitly, never a silent default; duplicates 409', async () => {
  const COL1 = 'c1c00000-0000-0000-0000-000000000001'; const COL2 = 'c1c00000-0000-0000-0000-000000000002';
  let cols = [{ id: COL1, campus_id: IDS.campusA, institution_id: 'i0000000-0000-0000-0000-000000000001' }, { id: COL2, campus_id: IDS.campusA, institution_id: 'i0000000-0000-0000-0000-000000000001' }];
  sql(/FROM colleges c JOIN campuses ca ON ca.id = c.campus_id/i, (p) => cols.filter((c) => (!p[0] || c.id === p[0]) && (!p[1] || c.campus_id === p[1])));
  sql(/^INSERT INTO departments/i, (p) => [{ id: 'd0000000-0000-0000-0000-0000000000dd', code: p[1] }]);
  const b = { name: 'Physics', code: 'phy', campus_id: IDS.campusA };
  let r = await call('POST', '/academic/departments', b, 'admin');
  assert.equal(r.status, 400); assert.deepEqual(r.data.colleges, [COL1, COL2]);
  assert.equal((await call('POST', '/academic/departments', { ...b, college_id: COL1, campus_id: IDS.campusB }, 'admin')).status, 400, 'college on another campus');
  assert.equal((await call('POST', '/academic/departments', { ...b, campus_id: 'nope' }, 'admin')).status, 400);
  assert.equal((await call('POST', '/academic/departments', b, 'hod')).status, 403);
  assert.equal(log.some((l) => /^INSERT INTO departments/.test(l.text)), false);
  cols = cols.slice(0, 1);
  r = await call('POST', '/academic/departments', b, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ins = log.find((l) => /^INSERT INTO departments/.test(l.text));
  assert.deepEqual(ins.params.slice(1), ['PHY', null, 'i0000000-0000-0000-0000-000000000001', IDS.campusA, COL1]);
  const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'department_created');
  assert.deepEqual(JSON.parse(audit.params[4]), { campus_id: IDS.campusA, college_id: COL1, code: 'PHY' });
  sql(/^INSERT INTO departments/i, () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
  assert.equal((await call('POST', '/academic/departments', b, 'admin')).status, 409);
});

test('POST /academic/programs and /course-offerings: department/program must be active and in scope', async () => {
  sql(/^INSERT INTO programs/i, [{ id: 'f0000000-0000-0000-0000-0000000000ff' }]);
  assert.equal((await call('POST', '/academic/programs', { name: 'MSc', code: 'msc', department_id: IDS.deptA2 }, 'hod')).status, 403);
  let r = await call('POST', '/academic/programs', { name: 'MSc', code: 'msc' }, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(log.find((l) => /^INSERT INTO programs/.test(l.text)).params[0], IDS.dept, 'the HOD\'s own department by default');
  WORLD.departments[IDS.deptA2].is_active = false;
  assert.equal((await call('POST', '/academic/programs', { name: 'MSc', code: 'msc', department_id: IDS.deptA2 }, 'admin')).status, 400, 'inactive department');
  assert.equal((await call('POST', '/academic/programs', { name: 'MSc', code: 'msc', department_id: 'd0000000-0000-0000-0000-00000000dead' }, 'admin')).status, 400, 'unknown department');
  assert.equal((await call('POST', '/academic/programs', { name: 'MSc', code: 'msc', department_id: IDS.deptB }, 'admin')).status, 200, 'admin builds structure anywhere');

  const off = { subject_id: IDS.subj, academic_session_id: 'a5500000-0000-0000-0000-000000000001', semester: 3 };
  sql(/^SELECT id FROM subjects WHERE id = \$1 AND is_active/i, (p) => (p[0] === IDS.subj ? [{ id: IDS.subj }] : []));
  sql(/^SELECT id FROM academic_sessions WHERE id = \$1/i, (p) => [{ id: p[0] }]);
  assert.equal((await call('POST', '/academic/course-offerings', { ...off, program_id: IDS.progB }, 'hod')).status, 403);
  assert.equal((await call('POST', '/academic/course-offerings', { ...off, program_id: IDS.prog, subject_id: 'e0000000-0000-0000-0000-00000000dead' }, 'hod')).status, 400, 'unknown subject');
  r = await call('POST', '/academic/course-offerings', { ...off, program_id: IDS.prog }, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('HOD account management is limited to teacher/reviewer accounts whose home the HOD scope covers', async () => {
  sql(/^UPDATE users SET is_active/i, (p) => [{ id: p[0] }]);
  sql(/^UPDATE otp_codes SET used = TRUE WHERE user_id/i, []);
  assert.equal((await call('POST', `/academic/users/${USERS.teacherA2.id}/deactivate`, null, 'hod')).status, 403);
  assert.equal((await call('POST', `/academic/users/${USERS.teacherB.id}/reactivate`, null, 'hod')).status, 403);
  assert.equal((await call('POST', `/academic/users/${USERS.coe.id}/deactivate`, null, 'hod')).status, 403, 'not a teacher/reviewer');
  assert.equal((await call('POST', '/academic/users/nope/deactivate', null, 'hod')).status, 404);
  assert.equal(log.some((l) => /^UPDATE users/.test(l.text)), false);
  assert.equal((await call('POST', `/academic/users/${USERS.teacher.id}/deactivate`, null, 'hod')).status, 200);
});
