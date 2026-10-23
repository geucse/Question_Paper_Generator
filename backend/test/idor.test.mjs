// Phase 3 IDOR matrix for the non-academic routes: question reads, analytics, review batches, bulk upload,
// attachments, notifications, legacy papers and the examination-domain paper reads (PIVOT_SPEC_V2 §2, §4, §17,
// §28; implementation prompt §5 criterion 6). Scope rules run against the harness world (installWorld): A1 and A2
// are two departments of campus A, B1 is campus B. Denied mutations must write nothing.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sql, log, baseRules, start, call, tokenFor, USERS, IDS, oid, installWorld, WORLD, writes, userHasScope } from './harness.mjs';
import { SCOPE_SQL } from '../src/scopes.js';

const QA = oid('question', 'A1');
const BATCH = oid('batch', 'A1');
const SV_OLD = 'b0000000-0000-0000-0000-0000000000f1'; // the question's own (older) syllabus version
const UNIT = oid('unit', 'A1'); const TOPIC = oid('topic', 'A1'); const CO1 = oid('co', 'A1');
const SCOPE_TEXT = SCOPE_SQL.replace(/\s+/g, ' ').trim();
let seats; let batchStatus; let notifications;

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => {
  baseRules(); installWorld();
  seats = [{ id: 'ab000000-0000-0000-0000-0000000000a1', review_batch_id: BATCH, reviewer_assignment_id: oid('ra', 'A1'), status: 'in_progress' }];
  batchStatus = 'in_progress';
  notifications = [{ id: '9c000000-0000-0000-0000-0000000000a1', user_id: USERS.teacher.id }];
  const q = (id) => WORLD.questions.find((x) => x.id === id);
  sql(/^SELECT id, submitted_by, canonical_question_id FROM questions WHERE id = \$1/i, (p) => (q(p[0]) ? [{ ...q(p[0]), canonical_question_id: null }] : []));
  sql(/^SELECT \* FROM questions WHERE id = \$1$/i, (p) => (q(p[0]) ? [{ ...q(p[0]), question_status: 'DRAFT', canonical_question_id: null }] : []));
  sql(/FROM questions WHERE id = \$1 AND submitted_by = \$2/i, (p) => (q(p[0])?.submitted_by === p[1] ? [{ ...q(p[0]), question_status: 'DRAFT' }] : []));
  // Review batches: one batch on A1's offering with one live seat for A1's reviewer.
  sql(/^SELECT \* FROM review_batches WHERE id = \$1/i, (p) => (p[0] === BATCH ? [{ id: BATCH, course_offering_id: IDS.off, status: batchStatus, title: 'Round 1', created_by_hod_id: USERS.hod.id }] : []));
  sql(/^SELECT id, course_offering_id FROM review_batches WHERE id = \$1/i, (p) => (p[0] === BATCH ? [{ id: BATCH, course_offering_id: IDS.off }] : []));
  sql(/^SELECT id, status, title FROM review_batches WHERE id = \$1/i, (p) => (p[0] === BATCH ? [{ id: BATCH, status: batchStatus, title: 'Round 1' }] : []));
  sql(/^SELECT rbr.id, rbr.status FROM review_batch_reviewers rbr JOIN reviewer_assignments ra/i, (p) => seats.filter((s) => {
    const ra = WORLD.ra.find((a) => a.id === s.reviewer_assignment_id); const o = WORLD.offerings[IDS.off];
    return s.review_batch_id === p[0] && s.status !== 'revoked' && ra?.reviewer_id === p[1] && ra.is_active && ra.course_offering_id === IDS.off
      && userHasScope([p[1], 'reviewer', o.campus_id, o.department_id]);
  }).map((s) => ({ id: s.id, status: s.status })));
  sql(/^SELECT rbr\.\*, u.email as reviewer_email/i, () => seats.map((s) => ({ ...s, reviewer_id: WORLD.ra.find((a) => a.id === s.reviewer_assignment_id).reviewer_id, assignment_active: true })));
  sql(/^SELECT q\.\*, u.email as teacher_email/i, []);
  sql(/^SELECT question_id FROM review_batch_items WHERE review_batch_id = \$1/i, []);
  sql(/^SELECT ra\.\* FROM reviewer_assignments ra JOIN users u ON u.id = ra.reviewer_id WHERE ra.id = \$1/i, (p) => WORLD.ra.filter((a) => {
    const u = Object.values(USERS).find((x) => x.id === a.reviewer_id);
    return a.id === p[0] && a.course_offering_id === p[1] && a.is_active && u?.is_active && u.role === 'reviewer' && userHasScope([u.id, 'reviewer', p[2], p[3]]);
  }));
  sql(/^INSERT INTO review_batch_reviewers/i, [{ id: 'ab000000-0000-0000-0000-0000000000ff' }]);
  sql(/^UPDATE review_batches SET status/i, []);
  sql(/FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id JOIN questions q ON q.id = rbi.question_id JOIN course_offerings co/i,
    () => [{ id: 'ab100000-0000-0000-0000-000000000001', outcome: null, batch_status: batchStatus, submitted_by: USERS.teacher.id, course_offering_id: IDS.off, question_status: 'UNDER_REVIEW', syllabus_version_id: SV_OLD }]);
  sql(/^SELECT id FROM syllabus_units WHERE id = \$1 AND syllabus_version_id = \$2/i, (p) => (p[0] === UNIT && p[1] === SV_OLD ? [{ id: UNIT }] : []));
  sql(/FROM syllabus_topics t JOIN syllabus_units u/i, (p) => (p[0] === TOPIC && p[1] === SV_OLD ? [{ id: TOPIC }] : []));
  sql(/^SELECT id FROM course_outcomes WHERE id = \$1 AND syllabus_version_id = \$2/i, (p) => (p[0] === CO1 && p[1] === SV_OLD ? [{ id: CO1 }] : []));
  sql(/^SELECT id FROM review_batches WHERE id = \$1 FOR UPDATE/i, [{ id: BATCH }]);
  sql(/^SELECT status FROM review_batches WHERE id = \$1 FOR UPDATE/i, () => [{ status: batchStatus }]);
  sql(/^SELECT outcome FROM review_batch_items WHERE id/i, [{ outcome: null }]);
  sql(/^INSERT INTO question_reviews/i, []);
  sql(/^UPDATE review_batch_reviewers/i, (p) => seats.filter((s) => s.id === p[p.length - 1] || s.id === p[0]).map((s) => ({ id: s.id })));
  // Notifications owned by one user.
  sql(/^UPDATE notifications SET read_at = COALESCE\(read_at, now\(\)\) WHERE id = \$1 AND user_id = \$2 RETURNING id/i,
    (p) => notifications.filter((n) => n.id === p[0] && n.user_id === p[1]).map((n) => ({ id: n.id })));
  sql(/FROM notifications WHERE user_id = \$1/i, (p) => notifications.filter((n) => n.user_id === p[0]));
  sql(/^UPDATE notifications SET read_at = now\(\) WHERE user_id = \$1/i, []);
});

const status = async (method, path, body, who) => (await call(method, path, body, who)).status;
async function expectAll(method, path, body, expected) {
  for (const [who, want] of Object.entries(expected)) {
    log.length = 0;
    const r = await call(method, path, body, who);
    assert.equal(r.status, want, `${method} ${path} as ${who}: ${JSON.stringify(r.data)}`);
    if (want >= 400 && method !== 'GET') assert.deepEqual(writes().map((l) => l.text.slice(0, 60)), [], `${who} caused a write`);
  }
}

// ---------------------------------------------------------------- questions
test('GET /questions/:id/canonical: the author, its assigned reviewer and the HOD in scope; nobody else', async () => {
  await expectAll('GET', `/questions/${QA}/canonical`, null, {
    teacher: 200, teacherA2: 404, teacherB: 404, hod: 200, hodA2: 403, hodB: 403, reviewer: 200, reviewerA2: 403, reviewerB: 403, admin: 403, coe: 403, v1: 403,
  });
  assert.equal(await status('GET', '/questions/not-a-uuid/canonical', null, 'hod'), 404);
});

test('author-only question routes: another teacher gets 404, other roles 403, and nothing is written', async () => {
  for (const [method, path, body] of [
    ['GET', `/questions/${QA}/preview`], ['POST', `/questions/${QA}/submit`, {}],
    ['POST', `/questions/${QA}/duplicate-decision`, { relationship_id: QA, decision: 'different' }],
    ['POST', '/questions/draft', { id: QA, question_type: 'short_answer', question_text: 'Define a binary heap.', difficulty: 'easy', marks: 2, model_answer: 'A tree.' }],
    ['POST', `/ai-review/${QA}`, {}], ['POST', `/ai-review/${QA}/appeal`, { reason: 'I disagree with it' }],
  ]) {
    await expectAll(method, path, body, { teacherA2: 404, teacherB: 404, hod: 403, reviewer: 403, admin: 403, coe: 403 });
  }
});

test('GET /questions/queue: HOD only, bound to the caller\'s own scope', async () => {
  sql(/FROM questions q JOIN users u ON u.id = q.submitted_by JOIN course_offerings co/i,
    (p) => WORLD.questions.filter((q) => { const o = WORLD.offerings[q.course_offering_id]; return userHasScope([p[0], p[1], o.campus_id, o.department_id]); }));
  for (const [who, ctx] of [['hod', 'A1'], ['hodA2', 'A2'], ['hodB', 'B1']]) {
    log.length = 0;
    const r = await call('GET', '/questions/queue', null, who);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.map((q) => q.id), [oid('question', ctx)], who);
    const q = log.find((l) => /FROM questions q JOIN users u/.test(l.text));
    assert.ok(q.text.includes(SCOPE_TEXT)); assert.deepEqual(q.params, [USERS[who].id, 'hod']);
  }
  for (const who of ['admin', 'teacher', 'reviewer', 'coe']) assert.equal(await status('GET', '/questions/queue', null, who), 403, who);
});

test('GET /questions/:id/lifecycle (phase 1 regression): out-of-scope HOD/reviewer and admin denied', async () => {
  sql(/^SELECT question_status, created_at, submitted_at/i, [{ question_status: 'UNDER_REVIEW' }]);
  sql(/FROM audit_log WHERE entity_id/i, []);
  for (const who of ['hodA2', 'hodB', 'reviewerB', 'reviewerA2', 'admin', 'teacherA2']) assert.equal(await status('GET', `/questions/${QA}/lifecycle`, null, who), 403, who);
  for (const who of ['teacher', 'hod', 'reviewer']) assert.equal(await status('GET', `/questions/${QA}/lifecycle`, null, who), 200, who);
  assert.equal(await status('GET', '/questions/not-a-uuid/lifecycle', null, 'hod'), 404);
});

// ---------------------------------------------------------------- review batches
test('review batches list: HOD by user_scopes (SCOPE_SQL), reviewer by live seats only, admin refused', async () => {
  sql(/FROM review_batches rb/i, []);
  await call('GET', '/review/batches', null, 'hodA2');
  const h = log.find((l) => /FROM review_batches rb/.test(l.text));
  assert.ok(h.text.includes(SCOPE_TEXT)); assert.deepEqual(h.params, [USERS.hodA2.id, 'hod']); assert.match(h.text, /LIMIT 200/);
  assert.doesNotMatch(h.text, /department_id = \$1/);
  log.length = 0;
  await call('GET', '/review/batches', null, 'reviewer');
  const r = log.find((l) => /FROM review_batches rb/.test(l.text));
  assert.match(r.text, /rbr.status <> 'revoked' AND ra.is_active/); assert.ok(r.text.includes(SCOPE_TEXT)); assert.deepEqual(r.params, [USERS.reviewer.id, 'reviewer']);
  for (const who of ['admin', 'teacher', 'coe']) assert.equal(await status('GET', '/review/batches', null, who), 403, who);
});

test('GET /review/batches/:id: HOD in scope or a reviewer with a live seat; a revoked seat or ended assignment loses it', async () => {
  await expectAll('GET', `/review/batches/${BATCH}`, null, { hod: 200, hodA2: 403, hodB: 403, admin: 403, reviewer: 200, reviewerA2: 403, reviewerB: 403, teacher: 403, coe: 403 });
  log.length = 0;
  await call('GET', `/review/batches/${BATCH}`, null, 'hod');
  assert.match(log.find((l) => /^SELECT rbr\.\*, u.email as reviewer_email/.test(l.text)).text, /ra.is_active AS assignment_active/);
  seats[0].status = 'revoked';
  assert.equal(await status('GET', `/review/batches/${BATCH}`, null, 'reviewer'), 403, 'seat revoked');
  seats[0].status = 'in_progress';
  WORLD.ra.find((a) => a.id === oid('ra', 'A1')).is_active = false;
  assert.equal(await status('GET', `/review/batches/${BATCH}`, null, 'reviewer'), 403, 'assignment ended');
  assert.equal(await status('GET', '/review/batches/not-a-uuid', null, 'hod'), 404);
});

test('review batch mutations by an out-of-scope HOD (same campus or other campus) are refused and write nothing', async () => {
  sql(/FROM questions q WHERE q.course_offering_id = \$1 AND q.question_status IN/i, [{ id: QA, question_status: 'SUBMITTED' }]);
  sql(/^SELECT \* FROM questions WHERE id = \$1$/i, [{ id: QA, course_offering_id: IDS.off, submitted_by: USERS.teacher.id, syllabus_version_id: SV_OLD }]);
  for (const who of ['hodA2', 'hodB', 'admin']) {
    await expectAll('POST', '/review/batches', { course_offering_id: IDS.off, title: 'x' }, { [who]: 403 });
    await expectAll('POST', `/review/batches/${BATCH}/assign`, { reviewer_assignment_ids: [oid('ra', 'A1')] }, { [who]: 403 });
    await expectAll('POST', `/review/batches/${BATCH}/reassign`, { old_reviewer_assignment_id: oid('ra', 'A1'), new_reviewer_assignment_id: oid('ra', 'A2') }, { [who]: 403 });
    await expectAll('POST', `/review/batches/${BATCH}/close`, null, { [who]: 403 });
    await expectAll('GET', `/review/batches/${BATCH}/disagreements`, null, { [who]: 403 });
    await expectAll('POST', `/review/questions/${QA}/resolve`, { resolution_method: 'hod_override', final_difficulty: 'easy', reason: 'agreed' }, { [who]: 403 });
  }
  log.length = 0;
  await call('POST', `/review/batches/${BATCH}/close`, null, 'hodB');
  const deny = log.find((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[1] === 'manage_review_batch');
  assert.ok(deny && deny.params[4] === 'deny', 'the refusal is logged');
});

test('assign: malformed ids 400; an inactive or out-of-scope reviewer\'s assignment is skipped and reported', async () => {
  assert.equal(await status('POST', `/review/batches/${BATCH}/assign`, { reviewer_assignment_ids: ['ra1'] }, 'hod'), 400);
  WORLD.ra.push({ id: '77770000-0000-0000-0000-0000000000c1', reviewer_id: USERS.reviewerB.id, course_offering_id: IDS.off, is_active: true });
  const r = await call('POST', `/review/batches/${BATCH}/assign`, { reviewer_assignment_ids: [oid('ra', 'A1'), '77770000-0000-0000-0000-0000000000c1'] }, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.skipped, ['77770000-0000-0000-0000-0000000000c1']); assert.equal(r.data.reviewers_notified, 1);
  const ins = log.filter((l) => /^INSERT INTO review_batch_reviewers/.test(l.text));
  assert.deepEqual(ins.map((l) => l.params[1]), [oid('ra', 'A1')]);
});

test('verdict: assigned reviewer only; unit/topic/CO checked against the question\'s own syllabus version; enums; no DB text leaks', async () => {
  const url = `/review/batches/${BATCH}/questions/${QA}/verdict`;
  const accept = (over = {}) => ({ decision: 'accept', verified_difficulty: 'easy', verified_bloom_level: 'apply', verified_course_outcome_id: CO1,
    verified_syllabus_unit_id: UNIT, verified_syllabus_topic_id: TOPIC, answer_approved: true, ...over });
  await expectAll('POST', url, accept(), { reviewerA2: 403, reviewerB: 403, hod: 403, admin: 403 });
  assert.equal(await status('POST', url, accept({ verified_bloom_level: 'guess' }), 'reviewer'), 400);
  assert.equal(await status('POST', url, accept({ verified_difficulty: 'trivial' }), 'reviewer'), 400);
  assert.equal(await status('POST', url, accept({ verified_syllabus_topic_id: 't1' }), 'reviewer'), 400);
  log.length = 0;
  let r = await call('POST', url, accept(), 'reviewer');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(log.find((l) => /^SELECT id FROM syllabus_units WHERE id = \$1/.test(l.text)).params[1], SV_OLD, 'the question\'s own version, not the offering\'s current one');
  sql(/^SELECT id FROM syllabus_units WHERE id = \$1 AND syllabus_version_id = \$2/i, []);
  assert.equal(await status('POST', url, accept(), 'reviewer'), 400, 'unit of another syllabus version');
  sql(/^SELECT id FROM syllabus_units WHERE id = \$1 AND syllabus_version_id = \$2/i, [{ id: UNIT }]);
  sql(/^INSERT INTO question_reviews/i, () => { throw new Error('A reviewer cannot record a verdict on their own submitted question (conflict of interest)'); });
  r = await call('POST', url, accept(), 'reviewer');
  assert.equal(r.status, 403); assert.equal(r.data.details, undefined); assert.match(r.data.error, /conflict of interest/);
  sql(/^INSERT INTO question_reviews/i, () => { throw Object.assign(new Error('relation "secret_table" does not exist'), { code: '42P01' }); });
  r = await call('POST', url, accept(), 'reviewer');
  assert.equal(r.status, 500); assert.doesNotMatch(JSON.stringify(r.data), /secret_table/);
});

test('complete: the batch is locked and re-checked open before the seat moves; out-of-scope reviewer refused', async () => {
  sql(/COUNT\(\*\)::int as c FROM review_batch_items rbi JOIN questions q/i, [{ c: 0 }]);
  sql(/COUNT\(\*\)::int as pending FROM review_batch_reviewers/i, [{ pending: 1 }]);
  const url = `/review/batches/${BATCH}/complete`;
  assert.equal(await status('POST', url, { reviewer_summary: 'done' }, 'reviewerA2'), 403);
  log.length = 0;
  assert.equal(await status('POST', url, { reviewer_summary: 'done' }, 'reviewer'), 200);
  const lock = log.findIndex((l) => /^SELECT status FROM review_batches WHERE id = \$1 FOR UPDATE/.test(l.text));
  const seat = log.findIndex((l) => /^UPDATE review_batch_reviewers SET status = 'completed'/.test(l.text));
  assert.ok(lock >= 0 && lock < seat, 'locked before the seat update');
  assert.match(log[seat].text, /status <> 'revoked'/);
  sql(/^SELECT status FROM review_batches WHERE id = \$1 FOR UPDATE/i, [{ status: 'closed' }]);
  log.length = 0;
  assert.equal(await status('POST', url, { reviewer_summary: 'done' }, 'reviewer'), 409, 'closed under the lock');
  assert.equal(log.some((l) => /^UPDATE review_batch_reviewers/.test(l.text)), false);
});

test('resolve: CO must belong to the question\'s syllabus version; malformed ids 400; nothing recorded on refusal', async () => {
  sql(/^SELECT \* FROM questions WHERE id = \$1$/i, [{ id: QA, course_offering_id: IDS.off, submitted_by: USERS.teacher.id, syllabus_version_id: SV_OLD }]);
  sql(/WHERE rbi.question_id = \$1 AND rbi.outcome IS NULL/i, [{ id: 'x', review_batch_id: BATCH }]);
  sql(/FROM questions q JOIN canonical_questions cq/i, []);
  sql(/^INSERT INTO review_resolutions/i, [{ id: 'res1' }]);
  sql(/SELECT canonical_question_id, submitted_by FROM questions WHERE id/i, [{ canonical_question_id: null, submitted_by: USERS.teacher.id }]);
  const url = `/review/questions/${QA}/resolve`;
  const b = { resolution_method: 'hod_override', reason: 'agreed with reviewer 2' };
  let r = await call('POST', url, { ...b, final_course_outcome_id: oid('co', 'A2') }, 'hod');
  assert.equal(r.status, 400); assert.match(r.data.error, /course outcome does not belong/);
  assert.equal(await status('POST', url, { ...b, final_syllabus_topic_id: 'topic-1' }, 'hod'), 400);
  assert.equal(await status('POST', url, { ...b, final_bloom_level: 'guess' }, 'hod'), 400);
  assert.equal(log.some((l) => /^INSERT INTO review_resolutions/.test(l.text)), false);
  r = await call('POST', url, { ...b, final_course_outcome_id: CO1 }, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('reviewer dashboard: live seats in scope only; the retired candidate-paper section is gone', async () => {
  sql(/FROM review_batches rb JOIN review_batch_reviewers rbr/i, []);
  sql(/FROM question_reviews WHERE reviewer_id = \$1/i, [{ c: 0 }]);
  const r = await call('GET', '/review/dashboard', null, 'reviewer');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.candidates_awaiting_review, undefined);
  assert.equal(log.some((l) => /paper_generation_requests/.test(l.text)), false);
  const q = log.find((l) => /FROM review_batches rb JOIN review_batch_reviewers rbr/.test(l.text));
  assert.match(q.text, /ra.is_active/); assert.ok(q.text.includes(SCOPE_TEXT)); assert.deepEqual(q.params, [USERS.reviewer.id, 'reviewer']);
});

// ---------------------------------------------------------------- bulk upload
test('bulk upload: only into an assigned offering; another teacher cannot confirm the batch; other roles refused', async () => {
  sql(/FROM teacher_course_assignments tca JOIN course_offerings co ON co.id = tca.course_offering_id WHERE tca.teacher_id = \$1/i,
    (p) => WORLD.tca.filter((a) => a.teacher_id === p[0] && a.course_offering_id === p[1] && a.is_active).map((a) => ({ course_offering_id: a.course_offering_id, section_id: null, subject_id: IDS.subj })));
  sql(/FROM bulk_upload_batches WHERE id = \$1 AND uploaded_by = \$2/i, (p) => (p[1] === USERS.teacher.id ? [{ id: p[0], status: 'validated', payload: {} }] : []));
  const up = async (who, offering) => {
    const fd = new FormData();
    fd.append('file', new Blob(['question_text\nWhat is a heap?\n']), 'q.csv');
    if (offering) fd.append('course_offering_id', offering);
    const r = await fetch(`http://localhost:${process.env.PORT}/api/bulk-upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor(who)}` }, body: fd });
    return r.status;
  };
  log.length = 0;
  assert.equal(await up('teacher', IDS.offA2), 403);
  assert.equal(await up('teacher', 'not-a-uuid'), 400);
  assert.equal(await up('hod', IDS.off), 403);
  assert.equal(await up('admin', IDS.off), 403);
  assert.equal(log.some((l) => /INSERT INTO bulk_upload_batches/.test(l.text)), false);
  await expectAll('POST', '/bulk-upload/ab200000-0000-0000-0000-000000000001/confirm', null, { teacherA2: 404, teacherB: 404, hod: 403, admin: 403 });
});

// ---------------------------------------------------------------- attachments
test('attachment download: a clean file only to the author, its assigned reviewer and the HOD in scope', async () => {
  const UPLOADS = new URL('../uploads/', import.meta.url);
  fs.mkdirSync(UPLOADS, { recursive: true });
  const name = 'idor-att-test.txt';
  fs.writeFileSync(new URL(name, UPLOADS), 'x');
  sql(/FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id/i,
    () => [{ id: 'att', file_path: name, scan_status: 'clean', uploaded_by: USERS.teacher.id, question_id: QA, question_owner: USERS.teacher.id }]);
  const get = async (who) => (await fetch(`http://localhost:${process.env.PORT}/api/attachments/ab300000-0000-0000-0000-000000000001/file`, { headers: { Authorization: `Bearer ${tokenFor(who)}` } })).status;
  try {
    const want = { teacher: 200, hod: 200, reviewer: 200, hodA2: 403, hodB: 403, reviewerA2: 403, reviewerB: 403, teacherA2: 403, admin: 403, coe: 403, v1: 403 };
    for (const [who, code] of Object.entries(want)) assert.equal(await get(who), code, who);
  } finally {
    try { fs.unlinkSync(new URL(name, UPLOADS)); } catch { /* already gone */ }
  }
});

// ---------------------------------------------------------------- notifications
test('notifications: only the owner\'s own; marking someone else\'s (or a missing one) read is 404, not a fake ok', async () => {
  const N = notifications[0].id;
  await call('GET', '/notifications', null, 'reviewer');
  assert.deepEqual(log.find((l) => /FROM notifications WHERE user_id = \$1/.test(l.text)).params, [USERS.reviewer.id]);
  let r = await call('POST', `/notifications/${N}/read`, null, 'reviewer');
  assert.equal(r.status, 404);
  assert.deepEqual(log.findLast((l) => /^UPDATE notifications/.test(l.text)).params, [N, USERS.reviewer.id]);
  r = await call('POST', `/notifications/${N}/read`, null, 'teacher');
  assert.equal(r.status, 200);
  log.length = 0;
  assert.equal(await status('POST', '/notifications/not-a-uuid/read', null, 'teacher'), 404);
  assert.equal(log.some((l) => /notifications/.test(l.text) && /^UPDATE/.test(l.text)), false);
  await call('POST', '/notifications/read-all', null, 'hodB');
  assert.deepEqual(log.findLast((l) => /^UPDATE notifications SET read_at = now\(\) WHERE user_id = \$1/.test(l.text)).params, [USERS.hodB.id]);
});

// ---------------------------------------------------------------- examination-domain papers (phase 2 regression)
test('examination papers: a COE of another campus, HODs and admin are refused; a malformed id is 404 without a query', async () => {
  const P = '9d000000-0000-0000-0000-0000000000e1';
  sql(/FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id JOIN programs pr ON pr.id = e.program_id WHERE ep.id/i,
    (p) => (p[0] === P ? [{ id: P, examination_id: 'ee000000-0000-0000-0000-000000000001', paper_status: 'VALIDATION_PENDING', campus_id: IDS.campusA, program_id: IDS.prog, department_id: IDS.dept, exam_offering_id: IDS.off }] : []));
  sql(/FROM paper_validator_assignments WHERE paper_id = \$1 AND validator_id = \$2/i, []);
  for (const path of [`/examinations/papers/${P}`, `/coe/papers/${P}/coe-status`, `/examinations/papers/${P}/issues`]) {
    for (const who of ['coeB', 'vB', 'hod', 'admin']) assert.equal(await status('GET', path, null, who), 403, `${path} ${who}`);
  }
  log.length = 0;
  assert.equal(await status('GET', '/examinations/papers/not-a-uuid', null, 'coe'), 404);
  assert.equal(log.some((l) => /FROM exam_papers/.test(l.text)), false);
});

// ---------------------------------------------------------------- central authorize()
// Review issue: POST /questions/:id/transition answered with the question's status (and confirmed it exists)
// before authorization, and the probe was never logged.
test('transition: outsiders (other department, other campus) learn neither the status nor the existence of a question; denials logged', async () => {
  sql(/^SELECT id, question_status, submitted_by FROM questions WHERE id = \$1/i, (p) => WORLD.questions.filter((q) => q.id === p[0]).map((q) => ({ ...q, question_status: 'UNDER_REVIEW' })));
  const UNKNOWN = '9a000000-0000-0000-0000-0000000000ff';
  const unknown = await call('POST', `/questions/${UNKNOWN}/transition`, { target_status: 'BOGUS' }, 'teacherB');
  for (const who of ['teacherB', 'hodB', 'reviewerB', 'teacherA2', 'hodA2', 'reviewerA2']) {
    for (const body of [{ target_status: 'BOGUS' }, { target_status: 'REJECTED' }, { target_status: 'APPROVED' }]) {
      log.length = 0;
      const r = await call('POST', `/questions/${QA}/transition`, body, who);
      assert.equal(r.status, 404, `${who} ${body.target_status}`);
      assert.deepEqual(r.data, unknown.data, 'answered exactly like an unknown id');
      assert.doesNotMatch(JSON.stringify(r.data), /UNDER_REVIEW|allowed|reason/i);
      assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[0] === USERS[who].id && l.params[4] === 'deny'), `${who}: logged`);
      assert.deepEqual(writes(), []);
    }
  }
  // Those who may see it still get the state errors.
  const own = await call('POST', `/questions/${QA}/transition`, { target_status: 'BOGUS' }, 'hod');
  assert.equal(own.status, 400); assert.deepEqual(own.data.allowed, ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED']);
});

// Review issue: the verdict and complete routes answered with outcomes, batch and question state before the scope/seat.
test('verdict and complete: scope and seat are checked before any batch, outcome or question state is told', async () => {
  sql(/FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id JOIN questions q ON q.id = rbi.question_id JOIN course_offerings co/i,
    () => [{ id: 'ab100000-0000-0000-0000-000000000001', outcome: 'APPROVED', batch_status: 'closed', submitted_by: USERS.teacher.id, course_offering_id: IDS.off, question_status: 'CHANGES_REQUESTED', syllabus_version_id: SV_OLD }]);
  batchStatus = 'closed';
  const verdict = { decision: 'reject', comment: 'Wrong answer key' };
  for (const who of ['reviewerB', 'reviewerA2']) {
    log.length = 0;
    const v = await call('POST', `/review/batches/${BATCH}/questions/${QA}/verdict`, verdict, who);
    assert.equal(v.status, 403, who); assert.doesNotMatch(JSON.stringify(v.data), /APPROVED|closed|CHANGES_REQUESTED/);
    assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[1] === 'review_question' && l.params[4] === 'deny'), `${who}: logged`);
    const c = await call('POST', `/review/batches/${BATCH}/complete`, { reviewer_summary: 'done' }, who);
    assert.equal(c.status, 403, who); assert.doesNotMatch(JSON.stringify(c.data), /closed/);
  }
  // A reviewer of the offering without a seat on this batch: in scope, but still told nothing.
  seats = [];
  const noSeat = await call('POST', `/review/batches/${BATCH}/questions/${QA}/verdict`, verdict, 'reviewer');
  assert.equal(noSeat.status, 403); assert.match(noSeat.data.error, /not assigned to this review batch/);
  const noSeatComplete = await call('POST', `/review/batches/${BATCH}/complete`, { reviewer_summary: 'done' }, 'reviewer');
  assert.equal(noSeatComplete.status, 403); assert.doesNotMatch(JSON.stringify(noSeatComplete.data), /closed/);
  // The seated reviewer gets the real state.
  seats = [{ id: 'ab000000-0000-0000-0000-0000000000a1', review_batch_id: BATCH, reviewer_assignment_id: oid('ra', 'A1'), status: 'in_progress' }];
  const seated = await call('POST', `/review/batches/${BATCH}/questions/${QA}/verdict`, verdict, 'reviewer');
  assert.equal(seated.status, 409); assert.match(seated.data.error, /already decided \(APPROVED\)/);
  assert.equal((await call('POST', `/review/batches/${BATCH}/complete`, { reviewer_summary: 'done' }, 'reviewer')).status, 409);
});

test('authorize(): view_question is the workflow rule (no campus-only access); admin refused for every new action, logged', async () => {
  const { authorize } = await import('../src/authorization.js');
  assert.equal((await authorize(USERS.hodA2, 'view_question', { question_id: QA })).allowed, false, 'same campus, other department');
  assert.equal((await authorize(USERS.hod, 'view_question', { question_id: QA })).allowed, true);
  for (const action of ['view_teacher_quality', 'view_analytics', 'view_review_batch', 'manage_review_batch', 'view_academic_context', 'manage_academic_context']) {
    log.length = 0;
    const a = await authorize(USERS.admin, action, { type: 'x', id: null });
    assert.equal(a.allowed, false, action);
    assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[1] === action && l.params[5] === 'admin_technical_only'), action);
  }
});
