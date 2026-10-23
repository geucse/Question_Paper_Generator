// Review batches drive the question decision (PIVOT_SPEC_V2 §2, §11, §12; brain.md §5, §8).
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, log, baseRules, start, call, USERS, IDS } from './harness.mjs';

const QID = '92000000-0000-0000-0000-000000000001';
const Q2 = '92000000-0000-0000-0000-000000000002';
const BID = '93000000-0000-0000-0000-000000000001';
const CO1 = 'c1000000-0000-0000-0000-000000000001';
const OTHER = '0000000a-0000-0000-0000-000000000000';
const U1 = '11110000-0000-0000-0000-000000000001'; const T1 = '22220000-0000-0000-0000-000000000001';
const RA1 = '77770000-0000-0000-0000-000000000001'; const RA_OLD = '77770000-0000-0000-0000-0000000000a0'; const RA_NEW = '77770000-0000-0000-0000-0000000000b0';
let item; let onBatch; let verdicts; let resolutions; let reviewers; let batchStatus;

const fullAccept = (over = {}) => ({ decision: 'accept', verified_difficulty: 'easy', verified_bloom_level: 'apply', verified_course_outcome_id: CO1,
  verified_syllabus_unit_id: U1, verified_syllabus_topic_id: T1, answer_approved: true, ...over });
const verdictRow = (over = {}) => ({ reviewer_id: USERS.reviewer.id, reviewer_email: USERS.reviewer.email, ...fullAccept(), flagged_ambiguous: false,
  flagged_duplicate: false, updated_at: '2026-01-02T00:00:00Z', ...over });

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => {
  baseRules();
  item = { id: 'rbi1', outcome: null, batch_status: 'in_progress', submitted_by: USERS.teacher.id, course_offering_id: IDS.off, question_status: 'UNDER_REVIEW', syllabus_version_id: IDS.sv };
  onBatch = [{ id: 'rbr1', reviewer_id: USERS.reviewer.id, status: 'in_progress' }];
  verdicts = [verdictRow()]; resolutions = []; batchStatus = 'in_progress';
  reviewers = [{ id: 'rbr1', reviewer_id: USERS.reviewer.id, reviewer_email: USERS.reviewer.email, status: 'completed', email: USERS.reviewer.email }];
  // authorize('review_question'/'assign_review') context + reviewer assignment
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p ON p.id = co.program_id WHERE q.id/i,
    [{ id: QID, submitted_by: USERS.teacher.id, course_offering_id: IDS.off, campus_id: IDS.campusA, program_id: IDS.prog, department_id: IDS.dept }]);
  sql(/SELECT id FROM reviewer_assignments WHERE course_offering_id/i, [{ id: 'ra1' }]);
  sql(/FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id JOIN questions q ON q.id = rbi.question_id JOIN course_offerings co/i, () => (item ? [item] : []));
  sql(/FROM review_batch_reviewers rbr JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id WHERE rbr.review_batch_id = \$1 AND ra.reviewer_id = \$2/i, () => onBatch);
  sql(/FROM course_outcomes WHERE id = \$1 AND syllabus_version_id = \$2/i, [{ id: CO1 }]);
  sql(/SELECT syllabus_version_id FROM course_offerings WHERE id/i, [{ syllabus_version_id: IDS.sv }]);
  sql(/FROM syllabus_units WHERE id/i, [{ id: U1 }]);
  sql(/FROM syllabus_topics t JOIN syllabus_units u/i, [{ id: T1 }]);
  sql(/FROM review_batches WHERE id = \$1 FOR UPDATE/i, [{ id: BID }]);
  sql(/SELECT outcome FROM review_batch_items WHERE id/i, () => [{ outcome: item?.outcome || null }]);
  sql(/INSERT INTO question_reviews/i, []);
  sql(/UPDATE review_batch_reviewers/i, []);
  sql(/UPDATE review_batches SET status/i, []);
  sql(/FROM question_reviews qr JOIN users u ON u.id = qr.reviewer_id WHERE qr.review_batch_id = \$1 AND qr.question_id = \$2 AND EXISTS/i, () => verdicts);
  sql(/FROM review_resolutions WHERE question_id = \$1 AND created_at >= \$2/i, () => resolutions);
});

const verdict = (body, who = 'reviewer') => call('POST', `/review/batches/${BID}/questions/${QID}/verdict`, body, who);

// ---- verdict ----
test('an accept verdict must verify the full classification and approve the answer', async () => {
  const r = await verdict({ decision: 'accept', verified_difficulty: 'easy', answer_approved: true });
  assert.equal(r.status, 400); assert.match(r.data.error, /must verify the Bloom level, course outcome, unit, topic/);
  assert.equal((await verdict(fullAccept({ answer_approved: false }))).status, 400);
  assert.equal((await verdict(fullAccept({ flagged_duplicate: true }))).status, 400);
  assert.equal((await verdict({ decision: 'request_revision' })).status, 400, 'comment still required');
});
test('verdicts only on an open round of an UNDER_REVIEW question, by an assigned non-author reviewer', async () => {
  item.outcome = 'APPROVED';
  assert.match((await verdict(fullAccept())).data.error, /already decided/);
  item.outcome = null; item.batch_status = 'closed';
  assert.equal((await verdict(fullAccept())).status, 409);
  item.batch_status = 'in_progress'; item.question_status = 'APPROVED';
  const s = await verdict(fullAccept());
  assert.equal(s.status, 409); assert.match(s.data.error, /under review/);
  item.question_status = 'UNDER_REVIEW'; item.submitted_by = USERS.reviewer.id;
  assert.equal((await verdict(fullAccept())).status, 403, 'own question');
  item.submitted_by = USERS.teacher.id;
  sql(/FROM course_outcomes WHERE id = \$1 AND syllabus_version_id = \$2/i, []);
  assert.equal((await verdict(fullAccept())).status, 400, 'CO from another syllabus version');
  sql(/FROM course_outcomes WHERE id = \$1 AND syllabus_version_id = \$2/i, [{ id: CO1 }]);
  onBatch = [];
  assert.equal((await verdict(fullAccept())).status, 403);
  assert.match(log.findLast((l) => /ra.reviewer_id = \$2/.test(l.text) && /review_batch_reviewers/.test(l.text)).text, /ra.is_active = TRUE/);
});
test('a recorded verdict locks the batch, upserts and reopens a completed batch', async () => {
  const r = await verdict(fullAccept());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const lock = log.findIndex((l) => /FROM review_batches WHERE id = \$1 FOR UPDATE/.test(l.text));
  const ins = log.findIndex((l) => /INSERT INTO question_reviews/.test(l.text));
  assert.ok(lock >= 0 && lock < ins);
  assert.ok(log.some((l) => /UPDATE review_batches SET status = 'in_progress'/.test(l.text)));
});

// ---- complete ----
function scriptComplete({ missing = 0 } = {}) {
  sql(/SELECT id, status, title FROM review_batches WHERE id/i, () => [{ id: BID, status: batchStatus, title: 'Round 1' }]);
  sql(/SELECT rbr\.\*, ra.reviewer_id FROM review_batch_reviewers/i, () => onBatch);
  sql(/COUNT\(\*\)::int as c FROM review_batch_items rbi JOIN questions q/i, () => [{ c: missing }]);
  sql(/COUNT\(\*\)::int as pending FROM review_batch_reviewers/i, [{ pending: 0 }]);
  sql(/SELECT \* FROM review_batches WHERE id/i, [{ id: BID, title: 'Round 1', created_by_hod_id: USERS.hod.id }]);
  sql(/SELECT question_id FROM review_batch_items WHERE review_batch_id = \$1 AND outcome IS NULL/i, [{ question_id: QID }]);
  sql(/SELECT DISTINCT ra.reviewer_id FROM review_batch_reviewers/i, [{ reviewer_id: USERS.reviewer.id }]);
  sql(/INSERT INTO review_resolutions/i, (p) => [{ id: 'res1', resolution_method: p[7], decided_by: p[8] }]);
  sql(/SELECT canonical_question_id, submitted_by FROM questions WHERE id/i, [{ canonical_question_id: 'cq1', submitted_by: USERS.teacher.id }]);
  sql(/UPDATE canonical_questions SET/i, []);
  sql(/INSERT INTO question_course_outcomes/i, []);
  sql(/UPDATE review_batch_reviewers SET status = 'completed'/i, () => onBatch.map((r) => ({ id: r.id })));
}
test('complete: counts only open rounds the reviewer did not author; validates the score; closed batches refused', async () => {
  scriptComplete({ missing: 1 });
  const r = await call('POST', `/review/batches/${BID}/complete`, { reviewer_summary: 'done' }, 'reviewer');
  assert.equal(r.status, 400);
  const m = log.find((l) => /COUNT\(\*\)::int as c FROM review_batch_items/.test(l.text));
  assert.match(m.text, /rbi.outcome IS NULL/); assert.match(m.text, /q.submitted_by <> \$2/);
  assert.equal((await call('POST', `/review/batches/${BID}/complete`, { reviewer_summary: 'done', recommendation_score: 'abc' }, 'reviewer')).status, 400);
  batchStatus = 'closed';
  assert.equal((await call('POST', `/review/batches/${BID}/complete`, { reviewer_summary: 'done' }, 'reviewer')).status, 409);
});
test('complete: when everyone is done, consensus is recorded with the single reviewer as the decider and reviewers + HOD are told', async () => {
  scriptComplete();
  const r = await call('POST', `/review/batches/${BID}/complete`, { reviewer_summary: 'done', recommendation_score: '4.5' }, 'reviewer');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const res = log.find((l) => /INSERT INTO review_resolutions/.test(l.text));
  assert.equal(res.params[7], 'single_reviewer_consensus'); assert.equal(res.params[8], USERS.reviewer.id);
  assert.deepEqual(res.params[10], [USERS.reviewer.id], 'the verifying reviewer ids are recorded (042)');
  const notes = log.filter((l) => /INSERT INTO notifications/.test(l.text)).map((l) => l.params[0]);
  assert.ok(notes.includes(USERS.reviewer.id) && notes.includes(USERS.hod.id));
  log.length = 0;
  resolutions = [{ resolution_method: 'single_reviewer_consensus', created_at: '2026-01-03' }];
  await call('POST', `/review/batches/${BID}/complete`, { reviewer_summary: 'done' }, 'reviewer');
  assert.equal(log.some((l) => /INSERT INTO review_resolutions/.test(l.text)), false, 'already recorded for these verdicts');
});

// 042: a consensus of several reviewers records every verifier and a recorded verifier (the earliest verdict), so the
// CO mapping it produces counts as reviewer-verified (gate and generation need verified_by).
test('complete: a consensus of two reviewers records both reviewer ids and the earliest as verified_by', async () => {
  scriptComplete();
  const R2 = USERS.reviewerA2.id;
  verdicts = [verdictRow(), verdictRow({ reviewer_id: R2, reviewer_email: 'r2@t.edu' })];
  const r = await call('POST', `/review/batches/${BID}/complete`, { reviewer_summary: 'done' }, 'reviewer');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const res = log.find((l) => /INSERT INTO review_resolutions/.test(l.text));
  assert.equal(res.params[8], null, 'nobody decided alone'); assert.deepEqual(res.params[10], [USERS.reviewer.id, R2]);
  const cq = log.find((l) => /UPDATE canonical_questions SET/.test(l.text));
  assert.match(cq.text, /verified_by = \$\d+, verified_by_reviewer_ids = \$\d+::uuid\[\]/);
  assert.ok(cq.params.includes(USERS.reviewer.id)); assert.ok(cq.params.some((v) => Array.isArray(v) && v.length === 2));
  const qco = log.find((l) => /INSERT INTO question_course_outcomes/.test(l.text));
  assert.equal(qco.params[2], USERS.reviewer.id); assert.deepEqual(qco.params[3], [USERS.reviewer.id, R2]);
});

// 042: reviewers verify the subtopic; it must sit under the verified topic of the question's version.
test('verdict: a verified subtopic must belong to the verified topic and is stored with the verdict', async () => {
  const S1 = '33330000-0000-0000-0000-000000000001';
  sql(/FROM syllabus_subtopics WHERE id = \$1 AND syllabus_topic_id = \$2 AND is_active/i, []);
  let r = await verdict(fullAccept({ verified_syllabus_subtopic_id: S1 }));
  assert.equal(r.status, 400); assert.match(r.data.error, /subtopic does not belong to the given topic/);
  assert.equal((await verdict(fullAccept({ verified_syllabus_subtopic_id: 'nope' }))).status, 400, 'malformed id');
  r = await verdict({ decision: 'request_revision', comment: 'fix', verified_syllabus_subtopic_id: S1 });
  assert.equal(r.status, 400); assert.match(r.data.error, /verified together with its topic/);
  assert.equal(log.some((l) => /INSERT INTO question_reviews/.test(l.text)), false);
  sql(/FROM syllabus_subtopics WHERE id = \$1 AND syllabus_topic_id = \$2 AND is_active/i, (p) => (p[1] === T1 ? [{ id: p[0] }] : []));
  r = await verdict(fullAccept({ verified_syllabus_subtopic_id: S1 }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ins = log.find((l) => /INSERT INTO question_reviews/.test(l.text));
  assert.match(ins.text, /verified_syllabus_subtopic_id = \$14/); assert.equal(ins.params[13], S1);
});

// ---- batch creation = send to review ----
function scriptCreate(eligible) {
  sql(/SELECT q.id, q.question_status FROM questions q/i, () => eligible);
  sql(/INSERT INTO review_batches/i, [{ id: BID, title: 'Round 1' }]);
  sql(/INSERT INTO review_batch_items/i, []);
  sql(/UPDATE questions SET question_status = 'UNDER_REVIEW'/i, () => [{ id: 'x' }]);
}
test('creating a batch sends SUBMITTED/RESUBMITTED questions to review, audited as transitions', async () => {
  scriptCreate([{ id: QID, question_status: 'SUBMITTED' }, { id: Q2, question_status: 'UNDER_REVIEW' }]);
  const r = await call('POST', '/review/batches', { course_offering_id: IDS.off, title: 'Round 1', question_ids: [QID, Q2] }, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent_to_review, 1);
  const moves = log.filter((l) => /UPDATE questions SET question_status = 'UNDER_REVIEW'/.test(l.text));
  assert.equal(moves.length, 1); assert.deepEqual(moves[0].params, [QID, 'SUBMITTED']);
  assert.equal(log.filter((l) => /INSERT INTO review_batch_items/.test(l.text)).length, 2);
  const audits = log.filter((l) => /INSERT INTO audit_log/.test(l.text));
  assert.ok(audits.some((l) => l.params[2] === 'review_batch_created'));
  const t = audits.find((l) => l.params[2] === 'question_transition_under_review');
  assert.equal(JSON.parse(t.params[4]).from, 'SUBMITTED');
});
test('batch creation: role, ids, eligibility, races and scope are checked', async () => {
  scriptCreate([{ id: QID, question_status: 'SUBMITTED' }]);
  assert.equal((await call('POST', '/review/batches', { course_offering_id: IDS.off, title: 'x' }, 'reviewer')).status, 403);
  assert.equal((await call('POST', '/review/batches', { course_offering_id: IDS.off, title: 'x', question_ids: ['nope'] }, 'hod')).status, 400);
  const inel = await call('POST', '/review/batches', { course_offering_id: IDS.off, title: 'x', question_ids: [QID, Q2] }, 'hod');
  assert.equal(inel.status, 400); assert.deepEqual(inel.data.question_ids, [Q2]);
  sql(/UPDATE questions SET question_status = 'UNDER_REVIEW'/i, []);
  assert.equal((await call('POST', '/review/batches', { course_offering_id: IDS.off, title: 'x' }, 'hod')).status, 409);
  sql(/INSERT INTO review_batch_items/i, () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); });
  assert.equal((await call('POST', '/review/batches', { course_offering_id: IDS.off, title: 'x' }, 'hod')).status, 409);
  sql(/user_has_scope/i, [{ has_scope: false }]);
  assert.equal((await call('POST', '/review/batches', { course_offering_id: IDS.off, title: 'x' }, 'hod')).status, 403);
});

// ---- resolve / close ----
test('resolve: consensus cannot be forced; only an open round can be resolved', async () => {
  sql(/SELECT \* FROM questions WHERE id = \$1/i, [{ id: QID, course_offering_id: IDS.off, submitted_by: USERS.teacher.id }]);
  sql(/FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id JOIN questions q ON q.id = rbi.question_id WHERE rbi.question_id = \$1 AND rbi.outcome IS NULL/i, []);
  assert.equal((await call('POST', `/review/questions/${QID}/resolve`, { resolution_method: 'single_reviewer_consensus', final_difficulty: 'easy' }, 'hod')).status, 400);
  assert.equal((await call('POST', `/review/questions/${QID}/resolve`, { resolution_method: 'hod_override', final_difficulty: 'easy', reason: 'agreed' }, 'hod')).status, 409);
  sql(/FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id JOIN questions q ON q.id = rbi.question_id WHERE rbi.question_id = \$1 AND rbi.outcome IS NULL/i,
    [{ id: 'rbi1', review_batch_id: BID }]);
  sql(/FROM questions q JOIN canonical_questions cq/i, []);
  sql(/INSERT INTO review_resolutions/i, [{ id: 'res1' }]);
  sql(/SELECT canonical_question_id, submitted_by FROM questions WHERE id/i, [{ canonical_question_id: null, submitted_by: USERS.teacher.id }]);
  assert.equal((await call('POST', `/review/questions/${QID}/resolve`, { resolution_method: 'hod_override', final_difficulty: 'easy', reason: 'agreed' }, 'hod')).status, 200);
});
// Review issue: closing a batch whose rounds are still open stranded its questions in UNDER_REVIEW for good
// (a closed batch takes no verdicts, and the question could not be re-batched).
test('close: refused while any question in the batch has no review decision; nothing written', async () => {
  sql(/SELECT \* FROM review_batches WHERE id/i, [{ id: BID, course_offering_id: IDS.off, status: 'assigned' }]);
  sql(/SELECT question_id FROM review_batch_items WHERE review_batch_id = \$1 AND outcome IS NULL/i, [{ question_id: QID }, { question_id: Q2 }]);
  const r = await call('POST', `/review/batches/${BID}/close`, null, 'hod');
  assert.equal(r.status, 409); assert.match(r.data.error, /2 question\(s\) in this batch have no review decision/);
  assert.deepEqual(r.data.question_ids, [QID, Q2]);
  assert.equal(log.some((l) => /UPDATE review_batches/.test(l.text)), false);
  assert.equal(log.some((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'review_batch_closed'), false);
});
test('close: allowed once every round is decided; conditional, audited; a closed batch is not closed twice', async () => {
  let st = 'review_complete';
  sql(/SELECT \* FROM review_batches WHERE id/i, () => [{ id: BID, course_offering_id: IDS.off, status: st }]);
  sql(/SELECT question_id FROM review_batch_items WHERE review_batch_id = \$1 AND outcome IS NULL/i, []);
  sql(/UPDATE review_batches SET status = 'closed'/i, [{ id: BID }]);
  const r = await call('POST', `/review/batches/${BID}/close`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(log.find((l) => /UPDATE review_batches SET status = 'closed'/.test(l.text)).text, /status NOT IN \('closed', 'cancelled'\)/);
  assert.ok(log.some((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'review_batch_closed'));
  st = 'closed';
  assert.equal((await call('POST', `/review/batches/${BID}/close`, null, 'hod')).status, 409);
  assert.equal((await call('POST', `/review/batches/${BID}/close`, null, 'admin')).status, 403);
});

// Review issue: /reassign could revoke a completed reviewer and with it their (dissenting) verdicts.
function scriptReassign({ batchStatus: bs = 'in_progress', oldStatus = 'in_progress', revoked = true } = {}) {
  sql(/SELECT \* FROM review_batches WHERE id/i, [{ id: BID, course_offering_id: IDS.off, status: bs, title: 'Round 1' }]);
  sql(/SELECT \* FROM review_batch_reviewers WHERE review_batch_id = \$1 AND reviewer_assignment_id = \$2/i, [{ id: 'rbr-old', status: oldStatus }]);
  sql(/SELECT ra\.\* FROM reviewer_assignments ra JOIN users u ON u.id = ra.reviewer_id WHERE ra.id = \$1 AND ra.course_offering_id/i, [{ id: RA_NEW, reviewer_id: OTHER }]);
  sql(/UPDATE review_batch_reviewers SET status = 'revoked'/i, () => (revoked ? [{ id: 'rbr-old' }] : []));
  sql(/INSERT INTO review_batch_reviewers/i, [{ id: 'rbr-new' }]);
}
const reassign = (body = {}) => call('POST', `/review/batches/${BID}/reassign`, { old_reviewer_assignment_id: RA_OLD, new_reviewer_assignment_id: RA_NEW, ...body }, 'hod');
test('reassign: a reviewer who completed (their verdicts count) cannot be swapped out', async () => {
  scriptReassign({ oldStatus: 'completed' });
  const r = await reassign({ reason: 'disagrees with me' });
  assert.equal(r.status, 409); assert.match(r.data.error, /has not completed/);
  assert.equal(log.some((l) => /UPDATE review_batch_reviewers|INSERT INTO review_batch_reviewers/.test(l.text)), false);
  scriptReassign({ oldStatus: 'revoked' });
  assert.equal((await reassign()).status, 409);
});
test('reassign: refused on a closed batch; a pending reviewer is replaced conditionally and audited', async () => {
  scriptReassign({ batchStatus: 'closed' });
  assert.equal((await reassign()).status, 409);
  scriptReassign({ oldStatus: 'assigned' });
  const r = await reassign({ reason: 'on leave' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(log.find((l) => /UPDATE review_batch_reviewers SET status = 'revoked'/.test(l.text)).text, /status IN \('assigned', 'in_progress'\)/);
  const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'review_batch_reassigned');
  assert.deepEqual(JSON.parse(audit.params[4]), { old_reviewer_assignment_id: RA_OLD, new_reviewer_assignment_id: RA_NEW, old_status: 'assigned', reason: 'on leave' });
  log.length = 0;
  scriptReassign({ revoked: false }); // the reviewer completed between the check and the update
  assert.equal((await reassign()).status, 409);
  assert.equal(log.some((l) => /INSERT INTO review_batch_reviewers/.test(l.text)), false);
});

// ---- batch detail: independence + decision state ----
function scriptDetail(myStatus) {
  sql(/SELECT \* FROM review_batches WHERE id/i, [{ id: BID, course_offering_id: IDS.off, status: 'review_complete' }]);
  sql(/^SELECT 1 FROM review_batch_reviewers rbr JOIN reviewer_assignments ra/i, [{ '?column?': 1 }]);
  sql(/SELECT rbr\.\*, u.email as reviewer_email, u.id as reviewer_id/i, () => [{ id: 'rbr1', reviewer_id: USERS.reviewer.id, status: myStatus },
    { id: 'rbr2', reviewer_id: OTHER, status: 'completed' }]);
  sql(/SELECT q\.\*, u.email as teacher_email, rbi.outcome AS review_outcome/i, [{ id: QID, question_status: 'UNDER_REVIEW', submitted_by: USERS.teacher.id, review_outcome: null }]);
  sql(/LEFT JOIN course_outcomes co ON co.id = qr.verified_course_outcome_id/i, [verdictRow(), verdictRow({ reviewer_id: OTHER })]);
  sql(/SELECT \* FROM review_resolutions WHERE question_id = \$1 ORDER BY/i, []);
  sql(/WHERE rbi.question_id = \$1 AND rbi.outcome IS NULL/i, [{ id: 'rbi1', review_batch_id: BID, submitted_by: USERS.teacher.id }]);
  sql(/SELECT ra.reviewer_id, rbr.status, u.email FROM review_batch_reviewers/i, () => [{ reviewer_id: USERS.reviewer.id, status: myStatus, email: 'r' }]);
}
test('batch detail: a reviewer sees only their own verdict until they complete; then the decision state', async () => {
  scriptDetail('in_progress');
  let r = await call('GET', `/review/batches/${BID}`, null, 'reviewer');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.questions[0].verdicts.length, 1); assert.equal(r.data.questions[0].decision, null);
  assert.equal(r.data.questions[0].disagreement, false);
  scriptDetail('completed');
  r = await call('GET', `/review/batches/${BID}`, null, 'reviewer');
  assert.equal(r.data.questions[0].verdicts.length, 2);
  assert.deepEqual(r.data.questions[0].decision.allowed, ['APPROVED'], JSON.stringify(r.data.questions[0].decision));
  assert.deepEqual(r.data.questions[0].decision.blockers, []);
});
test('assign: a closed batch is refused; a reviewer joining a completed batch reopens it', async () => {
  let st = 'closed';
  sql(/SELECT \* FROM review_batches WHERE id/i, () => [{ id: BID, course_offering_id: IDS.off, status: st, title: 'Round 1' }]);
  assert.equal((await call('POST', `/review/batches/${BID}/assign`, { reviewer_assignment_ids: [RA1] }, 'hod')).status, 409);
  st = 'review_complete';
  sql(/SELECT ra\.\* FROM reviewer_assignments ra JOIN users u ON u.id = ra.reviewer_id WHERE ra.id = \$1 AND ra.course_offering_id/i, [{ id: RA1, reviewer_id: USERS.reviewer.id }]);
  sql(/INSERT INTO review_batch_reviewers/i, [{ id: 'rbr-new' }]);
  const r = await call('POST', `/review/batches/${BID}/assign`, { reviewer_assignment_ids: [RA1] }, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(log.some((l) => /UPDATE review_batches SET status = 'in_progress', completed_at = NULL WHERE id = \$1 AND status = 'review_complete'/.test(l.text)));
});
