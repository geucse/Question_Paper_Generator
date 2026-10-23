import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sql, log, baseRules, start, call, USERS, IDS } from './harness.mjs';
import { TRANSITIONS } from '../src/routes/questions-lifecycle.js';

const QID = '90000000-0000-0000-0000-000000000001';
const ctx = (over = {}) => ({ id: QID, submitted_by: USERS.teacher.id, course_offering_id: IDS.off, campus_id: IDS.campusA, program_id: IDS.prog, department_id: IDS.dept, ...over });
const OTHER_REVIEWER = '0000000a-0000-0000-0000-000000000000';
const accept = (over = {}) => ({
  reviewer_id: USERS.reviewer.id, reviewer_email: USERS.reviewer.email, decision: 'accept', verified_difficulty: 'easy', verified_bloom_level: 'apply',
  verified_course_outcome_id: 'co1', verified_syllabus_unit_id: 'u1', verified_syllabus_topic_id: 't1', answer_approved: true,
  flagged_ambiguous: false, flagged_duplicate: false, comment: null, updated_at: '2026-01-02T00:00:00Z', ...over,
});
let status = 'UNDER_REVIEW';
let assigned = true;
let gate = { valid: true, errors: [] };
let round;

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => {
  baseRules();
  status = 'UNDER_REVIEW'; assigned = true; gate = { valid: true, errors: [] };
  // Default: a single-reviewer round on which the reviewer completed and accepted with full classification.
  round = {
    item: { id: 'rbi1', review_batch_id: 'rb1', created_at: '2026-01-01T00:00:00Z', batch_status: 'review_complete', submitted_by: USERS.teacher.id },
    reviewers: [{ reviewer_id: USERS.reviewer.id, status: 'completed', email: USERS.reviewer.email }],
    verdicts: [accept()], resolutions: [],
  };
  sql(/SELECT id, question_status, submitted_by FROM questions WHERE id/i, () => [{ id: QID, question_status: status, submitted_by: USERS.teacher.id }]);
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p/i, () => [ctx()]);
  sql(/FROM reviewer_assignments/i, () => (assigned ? [{ id: 'ra' }] : []));
  sql(/validate_question_for_active/i, () => [gate]);
  sql(/UPDATE questions SET/i, () => [{ id: QID }]);
  sql(/FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id JOIN questions q ON q.id = rbi.question_id WHERE rbi.question_id = \$1 AND rbi.outcome IS NULL/i,
    () => (round.item ? [round.item] : []));
  sql(/FROM review_batches WHERE id = \$1 FOR UPDATE/i, [{ id: 'rb1' }]);
  sql(/FROM review_batch_reviewers rbr JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id JOIN users u/i, () => round.reviewers);
  sql(/FROM question_reviews qr JOIN users u/i, () => round.verdicts);
  sql(/FROM review_resolutions/i, () => round.resolutions);
  sql(/UPDATE review_batch_items SET outcome/i, () => [{ id: 'rbi1' }]);
  sql(/UPDATE review_batch_items SET outcome = 'SUPERSEDED'/i, () => round.openRounds || []);
});

const transition = (body, who = 'reviewer') => call('POST', `/questions/${QID}/transition`, body, who);
const updateOf = () => log.find((l) => /UPDATE questions SET/.test(l.text));
const auditOf = (action) => log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === action);

test('assigned reviewer applies the batch decision: approval recorded on the round, conditional UPDATE, author notified', async () => {
  const r = await transition({ target_status: 'APPROVED' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const upd = updateOf();
  assert.equal(upd.params[0], 'APPROVED');
  assert.equal(upd.params[2], USERS.reviewer.id);
  assert.equal(upd.params[4], 'UNDER_REVIEW', 'conditional on the state that was checked');
  assert.match(upd.text, /WHERE id = \$2 AND question_status = \$5/);
  const rec = log.find((l) => /UPDATE review_batch_items SET outcome/.test(l.text));
  assert.deepEqual(rec.params, ['APPROVED', USERS.reviewer.id, 'rbi1']);
  assert.ok(log.indexOf(rec) < log.indexOf(upd), 'the round is recorded before the status changes');
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.teacher.id));
  assert.equal(r.data.review_batch_id, 'rb1');
});
test('illegal transition is refused with the allowed list', async () => {
  const r = await transition({ target_status: 'ACTIVE' });
  assert.equal(r.status, 400); assert.deepEqual(r.data.allowed, ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED']);
});
test('submission targets are refused on /transition (they go through /submit)', async () => {
  status = 'DRAFT';
  const a = await transition({ target_status: 'SUBMITTED' }, 'teacher');
  assert.equal(a.status, 400); assert.match(a.data.error, /\/submit/);
  status = 'CHANGES_REQUESTED';
  const b = await transition({ target_status: 'RESUBMITTED' }, 'teacher');
  assert.equal(b.status, 400); assert.match(b.data.error, /\/submit/);
  assert.equal(log.some((l) => /UPDATE questions SET/.test(l.text)), false);
  // and they are not offered as allowed moves either
  status = 'DRAFT';
  assert.deepEqual((await transition({ target_status: 'APPROVED' })).data.allowed, []);
  status = 'CHANGES_REQUESTED';
  assert.deepEqual((await transition({ target_status: 'APPROVED' })).data.allowed, []);
});
test('author withdraws a submitted question to draft; someone else cannot', async () => {
  status = 'SUBMITTED';
  assert.equal((await transition({ target_status: 'DRAFT' }, 'teacher')).status, 200);
  const sup = log.find((l) => /UPDATE review_batch_items SET outcome = 'SUPERSEDED'/.test(l.text));
  assert.ok(sup, 'a review round the question is still in ends with the withdrawal');
  assert.match(sup.text, /WHERE question_id = \$1 AND outcome IS NULL/);
  assert.ok(log.indexOf(updateOf()) < log.indexOf(sup), 'only after the conditional status change');
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p/i, () => [ctx({ submitted_by: 'someone-else' })]);
  // Another teacher cannot see the question at all: answered like an unknown id.
  const other = await transition({ target_status: 'DRAFT' }, 'teacher');
  assert.equal(other.status, 404); assert.doesNotMatch(JSON.stringify(other.data), /SUBMITTED/);
});
test('withdrawing a question that is still in a (pre-038) review round supersedes the round, audited', async () => {
  status = 'SUBMITTED'; round.openRounds = [{ review_batch_id: 'rb-old' }];
  assert.equal((await transition({ target_status: 'DRAFT' }, 'teacher')).status, 200);
  const details = JSON.parse(auditOf('question_transition_draft').params[4]);
  assert.deepEqual(details.superseded_review_batch_ids, ['rb-old']);
  log.length = 0;
  sql(/UPDATE questions SET/i, []);
  assert.equal((await transition({ target_status: 'DRAFT' }, 'teacher')).status, 409, 'a concurrent change: nothing superseded');
  assert.equal(log.some((l) => /SUPERSEDED/.test(l.text)), false);
});
test('a reviewer retires or restores only questions of an offering they are assigned to', async () => {
  assigned = false;
  status = 'ACTIVE';
  const a = await transition({ target_status: 'RETIRED', reason: 'Outdated' });
  assert.equal(a.status, 404, 'an unassigned reviewer does not see the question'); assert.doesNotMatch(JSON.stringify(a.data), /ACTIVE/);
  assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[4] === 'deny' && /Not assigned/.test(l.params[5])), 'the denial is logged');
  status = 'RETIRED';
  assert.equal((await transition({ target_status: 'ACTIVE', reason: 'Back in the syllabus' })).status, 404);
  assert.equal(log.some((l) => /UPDATE questions SET/.test(l.text)), false);
  assigned = true;
  assert.equal((await transition({ target_status: 'ACTIVE', reason: 'Back in the syllabus' })).status, 200);
  // the HOD needs only the department scope
  assigned = false; status = 'ACTIVE';
  assert.equal((await transition({ target_status: 'RETIRED', reason: 'Outdated' }, 'hod')).status, 200);
});
test('old state names (IN_REVIEW/DEPRECATED) are no longer accepted', async () => {
  assert.equal((await transition({ target_status: 'IN_REVIEW' }, 'hod')).status, 400);
});
test('reviewer cannot review a question they authored', async () => {
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p/i, () => [ctx({ submitted_by: USERS.reviewer.id })]);
  const r = await transition({ target_status: 'APPROVED' });
  assert.equal(r.status, 403); assert.match(r.data.error, /own question/);
});
test('reviewer not assigned to the offering is denied, before learning the question status', async () => {
  assigned = false;
  for (const body of [{ target_status: 'APPROVED' }, { target_status: 'BOGUS' }, { target_status: 'REJECTED' }]) {
    const r = await transition(body);
    assert.equal(r.status, 404, JSON.stringify(body)); assert.equal(r.data.allowed, undefined);
    assert.doesNotMatch(JSON.stringify(r.data), /UNDER_REVIEW|reason/i);
  }
});
test('out-of-scope (cross-campus) reviewer is denied (logged), before learning the question status', async () => {
  sql(/user_has_scope/i, [{ has_scope: false }]);
  const r = await transition({ target_status: 'BOGUS' });
  assert.equal(r.status, 404); assert.doesNotMatch(JSON.stringify(r.data), /UNDER_REVIEW/);
  assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[1] === 'view_question_workflow' && l.params[4] === 'deny' && /scope/i.test(l.params[5])));
});
test('teacher cannot approve; admin cannot take academic decisions', async () => {
  assert.equal((await transition({ target_status: 'APPROVED' }, 'teacher')).status, 403);
  const a = await transition({ target_status: 'APPROVED' }, 'admin');
  assert.equal(a.status, 403); assert.match(a.data.error, /technical-only/);
});
test('rejection / retirement need a reason', async () => {
  assert.equal((await transition({ target_status: 'REJECTED' })).status, 400);
  status = 'ACTIVE';
  assert.equal((await transition({ target_status: 'RETIRED' })).status, 400);
});
test('ACTIVE is blocked, with reasons, when the quality gate fails', async () => {
  status = 'APPROVED'; gate = { valid: false, errors: ['Missing Bloom level'] };
  const r = await transition({ target_status: 'ACTIVE' });
  assert.equal(r.status, 400); assert.deepEqual(r.data.validation_errors, ['Missing Bloom level']);
  assert.equal(log.some((l) => /UPDATE questions SET/.test(l.text)), false, 'must not write when gate fails');
});
test('ACTIVE succeeds when the gate passes and records who activated it', async () => {
  status = 'APPROVED';
  assert.equal((await transition({ target_status: 'ACTIVE' })).status, 200);
  const upd = updateOf();
  assert.match(upd.text, /activated_by = CASE WHEN \$1 = 'ACTIVE' THEN \$3::uuid/);
  assert.equal(upd.params[2], USERS.reviewer.id);
});
test('retire records who and why', async () => {
  status = 'ACTIVE';
  const r = await transition({ target_status: 'RETIRED', reason: 'Outdated' });
  assert.equal(r.status, 200);
  const upd = updateOf();
  assert.deepEqual([upd.params[0], upd.params[2], upd.params[3]], ['RETIRED', USERS.reviewer.id, 'Outdated']);
});
test('a concurrent change makes the conditional UPDATE miss: 409, nothing audited', async () => {
  status = 'APPROVED';
  sql(/UPDATE questions SET/i, []);
  const r = await transition({ target_status: 'ACTIVE' });
  assert.equal(r.status, 409); assert.match(r.data.error, /changed state meanwhile/);
  assert.equal(log.some((l) => /INSERT INTO audit_log/.test(l.text) && /question_transition/.test(l.params[2])), false);
  status = 'UNDER_REVIEW';
  assert.equal((await transition({ target_status: 'APPROVED' })).status, 409, 'review decision path too');
});

// ---- restore (RETIRED -> ACTIVE) ----
test('restore needs a reason', async () => {
  status = 'RETIRED';
  const r = await transition({ target_status: 'ACTIVE' }, 'hod');
  assert.equal(r.status, 400); assert.match(r.data.error, /restore/);
  assert.equal(log.some((l) => /UPDATE questions SET/.test(l.text)), false);
});
test('restore re-runs the gate, records who restored it, and is audited as a restore', async () => {
  status = 'RETIRED';
  const r = await transition({ target_status: 'ACTIVE', reason: 'Re-validated for the new term' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(log.some((l) => /validate_question_for_active/.test(l.text)));
  const upd = updateOf();
  assert.deepEqual([upd.params[0], upd.params[2], upd.params[4]], ['ACTIVE', USERS.reviewer.id, 'RETIRED']);
  assert.match(upd.text, /activated_by/);
  const audit = auditOf('question_transition_restore');
  assert.ok(audit, 'audited as question_transition_restore');
  const details = JSON.parse(audit.params[4]);
  assert.equal(details.restore, true); assert.equal(details.reason, 'Re-validated for the new term');
});
test('restore blocked when the gate fails', async () => {
  status = 'RETIRED'; gate = { valid: false, errors: ['Syllabus version is not approved'] };
  const r = await transition({ target_status: 'ACTIVE', reason: 'Back in the syllabus' }, 'hod');
  assert.equal(r.status, 400); assert.deepEqual(r.data.validation_errors, ['Syllabus version is not approved']);
  assert.equal(log.some((l) => /UPDATE questions SET/.test(l.text)), false);
});
test('teacher cannot restore', async () => {
  status = 'RETIRED';
  assert.equal((await transition({ target_status: 'ACTIVE', reason: 'Back in the syllabus' }, 'teacher')).status, 403);
});
test('DB lifecycle refusals are surfaced, not masked', async () => {
  status = 'ACTIVE';
  sql(/UPDATE questions SET/i, () => { throw new Error('Question content is locked while the question is ACTIVE (changed: marks); request changes to revise it'); });
  const a = await transition({ target_status: 'RETIRED', reason: 'Outdated' });
  assert.equal(a.status, 400); assert.match(a.data.error, /content is locked/);
  status = 'UNDER_REVIEW';
  sql(/UPDATE questions SET/i, () => { throw new Error("Review decision required: UNDER_REVIEW -> APPROVED must be applied from the question's review batch"); });
  const b = await transition({ target_status: 'APPROVED' });
  assert.equal(b.status, 400); assert.match(b.data.error, /Review decision required/);
  sql(/UPDATE questions SET/i, () => { throw new Error('some internal detail'); });
  assert.equal((await transition({ target_status: 'APPROVED' })).data.error, 'Transition rejected');
});

// ---- review decisions come from the review batch ----
test('approval needs an open review batch', async () => {
  round.item = null;
  const r = await transition({ target_status: 'APPROVED' });
  assert.equal(r.status, 409); assert.match(r.data.error, /not in an open review batch/);
  assert.equal(log.some((l) => /UPDATE questions SET/.test(l.text)), false);
});
test('approval waits for every reviewer on the batch', async () => {
  round.reviewers.push({ reviewer_id: OTHER_REVIEWER, status: 'in_progress', email: 'other@t.edu' });
  const r = await transition({ target_status: 'APPROVED' });
  assert.equal(r.status, 409); assert.match(r.data.error, /Waiting for 1 reviewer/);
  assert.equal(log.some((l) => /UPDATE questions SET|UPDATE review_batch_items/.test(l.text)), false);
});
test('a reviewer not on the batch cannot apply its decision', async () => {
  round.reviewers = [{ reviewer_id: OTHER_REVIEWER, status: 'completed', email: 'other@t.edu' }];
  round.verdicts = [accept({ reviewer_id: OTHER_REVIEWER })];
  const r = await transition({ target_status: 'APPROVED' });
  assert.equal(r.status, 403); assert.match(r.data.error, /not a reviewer on this question's review batch/);
});
test('split decisions block approval and rejection but allow changes', async () => {
  round.reviewers.push({ reviewer_id: OTHER_REVIEWER, status: 'completed', email: 'other@t.edu' });
  round.verdicts = [accept(), accept({ reviewer_id: OTHER_REVIEWER, decision: 'reject', comment: 'wrong key' })];
  const a = await transition({ target_status: 'APPROVED' });
  assert.equal(a.status, 409); assert.match(a.data.error, /disagree on the decision/);
  assert.equal((await transition({ target_status: 'REJECTED', reason: 'wrong key' })).status, 409);
  const c = await transition({ target_status: 'CHANGES_REQUESTED', reason: 'fix the key' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(log.filter((l) => /UPDATE review_batch_items SET outcome/.test(l.text)).at(-1).params[0], 'CHANGES_REQUESTED');
  const details = JSON.parse(auditOf('question_transition_changes_requested').params[4]);
  assert.deepEqual(details.verdicts.map((v) => v.decision), ['accept', 'reject']);
  assert.equal(details.review_batch_id, 'rb1');
});
test('a request_revision verdict cannot become an approval; a unanimous reject can become a rejection', async () => {
  round.verdicts = [accept({ decision: 'request_revision', comment: 'clarify' })];
  assert.equal((await transition({ target_status: 'APPROVED' })).status, 409);
  const cr = await transition({ target_status: 'CHANGES_REQUESTED', reason: 'clarify the wording' });
  assert.equal(cr.status, 200);
  const upd = updateOf();
  assert.match(upd.text, /change_request_reason = CASE WHEN \$1 = 'CHANGES_REQUESTED' THEN \$4/);
  assert.equal(upd.params[3], 'clarify the wording');
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.teacher.id && /clarify the wording/.test(l.params[2])));
  log.length = 0;
  round.verdicts = [accept({ decision: 'reject', comment: 'off syllabus' })];
  assert.equal((await transition({ target_status: 'REJECTED', reason: 'off syllabus' })).status, 200);
  assert.match(updateOf().text, /rejection_reason = CASE WHEN \$1 = 'REJECTED' THEN \$4/);
});
test('all accept -> CHANGES_REQUESTED refused', async () => {
  const r = await transition({ target_status: 'CHANGES_REQUESTED', reason: 'just because' });
  assert.equal(r.status, 409); assert.match(r.data.error, /Every reviewer accepted/);
});
test('classification disagreement needs a fresh explicit resolution', async () => {
  round.reviewers.push({ reviewer_id: OTHER_REVIEWER, status: 'completed', email: 'other@t.edu' });
  round.verdicts = [accept(), accept({ reviewer_id: OTHER_REVIEWER, verified_course_outcome_id: 'co2' })];
  const a = await transition({ target_status: 'APPROVED' });
  assert.equal(a.status, 409); assert.match(a.data.error, /disagree on the course outcome/);
  round.resolutions = [{ resolution_method: 'single_reviewer_consensus', final_difficulty: 'easy', created_at: '2026-01-03T00:00:00Z' }];
  assert.equal((await transition({ target_status: 'APPROVED' })).status, 409, 'a partial consensus row is not a resolution');
  round.resolutions = [{ resolution_method: 'hod_override', final_course_outcome_id: 'co2', created_at: '2026-01-03T00:00:00Z' }, ...round.resolutions];
  assert.equal((await transition({ target_status: 'APPROVED' })).status, 200);
});
test('approval needs a verified CO and topic and an approved answer', async () => {
  round.verdicts = [accept({ verified_syllabus_topic_id: null })];
  const a = await transition({ target_status: 'APPROVED' });
  assert.equal(a.status, 409); assert.match(a.data.error, /reviewer-verified topic/);
  round.verdicts = [accept({ answer_approved: false })];
  const b = await transition({ target_status: 'APPROVED' });
  assert.equal(b.status, 409); assert.match(b.data.error, /approve the answer/);
});
// Review issue: a split round (accept + request_revision) allows only CHANGES_REQUESTED; neither reviewer may
// then reject alone. And a reviewer who sent an ACTIVE question back cannot finish it off as REJECTED.
test('nobody rejects alone after a split round: CHANGES_REQUESTED -> REJECTED is refused for every reviewer', async () => {
  round.reviewers.push({ reviewer_id: OTHER_REVIEWER, status: 'completed', email: 'other@t.edu' });
  round.verdicts = [accept(), accept({ reviewer_id: OTHER_REVIEWER, decision: 'request_revision', comment: 'clarify' })];
  assert.equal((await transition({ target_status: 'REJECTED', reason: 'wrong' })).status, 409, 'split verdicts never reject');
  assert.equal((await transition({ target_status: 'CHANGES_REQUESTED', reason: 'clarify' })).status, 200);
  status = 'CHANGES_REQUESTED'; log.length = 0;
  for (const who of ['reviewer', 'hod', 'teacher']) {
    const r = await transition({ target_status: 'REJECTED', reason: 'never mind, reject it' }, who);
    assert.equal(r.status, 400, who); assert.deepEqual(r.data.allowed, [], who);
  }
  assert.equal(log.some((l) => /UPDATE questions SET|UPDATE review_batch_items/.test(l.text)), false, 'nothing written');
});
test('ACTIVE -> CHANGES_REQUESTED -> REJECTED by one reviewer is refused', async () => {
  status = 'ACTIVE';
  assert.equal((await transition({ target_status: 'CHANGES_REQUESTED', reason: 'answer key is outdated' })).status, 200);
  status = 'CHANGES_REQUESTED'; log.length = 0;
  const r = await transition({ target_status: 'REJECTED', reason: 'answer key is outdated' });
  assert.equal(r.status, 400); assert.match(r.data.error, /Invalid transition from CHANGES_REQUESTED to REJECTED/);
  assert.equal(log.some((l) => /UPDATE questions SET/.test(l.text)), false);
});
test('approved/active questions can be sent back for changes without a batch (reviewer only)', async () => {
  status = 'ACTIVE';
  const r = await transition({ target_status: 'CHANGES_REQUESTED', reason: 'answer key is outdated' });
  assert.equal(r.status, 200);
  assert.equal(log.some((l) => /UPDATE review_batch_items/.test(l.text)), false);
  assert.equal((await transition({ target_status: 'CHANGES_REQUESTED', reason: 'answer key is outdated' }, 'hod')).status, 403);
});

test('lifecycle history is access-checked (no IDOR)', async () => {
  sql(/SELECT question_status, created_at, submitted_at/i, [{ question_status: 'ACTIVE' }]);
  sql(/user_has_scope/i, [{ has_scope: false }]);
  sql(/SELECT DISTINCT campus_id FROM user_scopes/i, [{ campus_id: IDS.campusB }]); // viewer's campus != question's campus
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p/i, () => [ctx()]);
  assert.equal((await call('GET', `/questions/${QID}/lifecycle`, null, 'hod')).status, 403);
});
test('lifecycle history: only the author, assigned reviewers and in-scope HODs (not other teachers, COE, validators, admin)', async () => {
  sql(/SELECT question_status, created_at, submitted_at/i, [{ question_status: 'CHANGES_REQUESTED', change_request_reason: 'private reason' }]);
  sql(/SELECT action, created_at, details FROM audit_log/i, []);
  // same campus as the question, so the old campus-only rule would have let all of them in
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p/i, () => [ctx({ submitted_by: 'someone-else' })]);
  for (const who of ['teacher', 'coe', 'v1', 'admin']) {
    const r = await call('GET', `/questions/${QID}/lifecycle`, null, who);
    assert.equal(r.status, 403, who); assert.equal(r.data.change_request_reason, undefined, who);
  }
  assigned = false;
  assert.equal((await call('GET', `/questions/${QID}/lifecycle`, null, 'reviewer')).status, 403, 'reviewer not assigned to the offering');
  assigned = true;
  assert.equal((await call('GET', `/questions/${QID}/lifecycle`, null, 'reviewer')).status, 200);
  assert.equal((await call('GET', `/questions/${QID}/lifecycle`, null, 'hod')).status, 200);
  sql(/user_has_scope/i, [{ has_scope: false }]);
  assert.equal((await call('GET', `/questions/${QID}/lifecycle`, null, 'hod')).status, 403, 'HOD of another department');
});
test('teachers reach the lifecycle screens under /question-bank (the analytics guard covers only /analytics)', async () => {
  sql(/AS in_review_batch/i, []); sql(/GROUP BY q.question_status/i, []);
  assert.equal((await call('GET', '/question-bank/lifecycle?status=CHANGES_REQUESTED', null, 'teacher')).status, 200);
  sql(/SELECT question_status, created_at, submitted_at/i, [{ question_status: 'CHANGES_REQUESTED' }]);
  sql(/SELECT action, created_at, details FROM audit_log/i, []);
  assert.equal((await call('GET', `/question-bank/${QID}/lifecycle`, null, 'teacher')).status, 200);
});
test('lifecycle history includes create, edit, submit and resubmit events, each with a normalised event', async () => {
  sql(/SELECT question_status, created_at, submitted_at/i, [{ question_status: 'RESUBMITTED', change_request_reason: 'clarify' }]);
  sql(/SELECT action, created_at, details FROM audit_log/i, [
    { action: 'question_resubmitted', created_at: '2026-01-04', details: '{"version_number":2}' },
    { action: 'draft_updated', created_at: '2026-01-03', details: '{}' },
    { action: 'question_transition_changes_requested', created_at: '2026-01-02', details: '{}' },
    { action: 'draft_created', created_at: '2026-01-01', details: '{}' },
  ]);
  const r = await call('GET', `/questions/${QID}/lifecycle`, null, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const q = log.find((l) => /SELECT action, created_at, details FROM audit_log/.test(l.text));
  for (const a of ['draft_created', 'draft_updated', 'question_final_submit', 'question_resubmitted', 'question_bulk_imported', 'ai_review_completed']) {
    assert.ok(q.params[1].includes(a), a);
  }
  assert.match(q.text, /action LIKE 'question_transition_%'/);
  assert.deepEqual(r.data.audit_trail.map((e) => e.event), ['resubmitted', 'draft_updated', 'transition', 'draft_created']);
  assert.equal(r.data.change_request_reason, 'clarify');
});
test('unauthenticated request is rejected', async () => {
  assert.equal((await transition({ target_status: 'APPROVED' }, null)).status, 401);
});

// ---- the DB transition table (migration 038) allows every route transition ----
test('migration 038 transition table allows every route transition', () => {
  const text = fs.readFileSync(new URL('../migrations/038_question_workflow_hardening.sql', import.meta.url), 'utf8');
  const from = text.indexOf('v_allowed := CASE OLD.question_status');
  const block = text.slice(from, text.indexOf('END;', from));
  const sqlTable = {};
  for (const m of block.matchAll(/WHEN '(\w+)'\s+THEN ARRAY\[([^\]]*)\]/g)) {
    sqlTable[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  }
  for (const [state, targets] of Object.entries(TRANSITIONS)) {
    for (const t of targets) assert.ok((sqlTable[state] || []).includes(t), `${state} -> ${t} missing in 038`);
  }
  const dbOnly = Object.entries(sqlTable).flatMap(([s, ts]) => ts.filter((t) => !(TRANSITIONS[s] || []).includes(t)).map((t) => `${s}->${t}`));
  for (const e of dbOnly) assert.ok(['DRAFT->SUBMITTED', 'CHANGES_REQUESTED->RESUBMITTED'].includes(e), `unexpected DB-only edge ${e}`);
  assert.equal(sqlTable.REJECTED, undefined, 'REJECTED is terminal');
  assert.deepEqual(sqlTable.CHANGES_REQUESTED, ['RESUBMITTED'], 'REJECTED only from UNDER_REVIEW (with a recorded decision)');
  assert.ok(Object.entries(sqlTable).every(([st, ts]) => st === 'UNDER_REVIEW' || !ts.includes('REJECTED')), 'no other edge into REJECTED');
});

// ---- scoped lifecycle list (feeds the lifecycle screens) ----
function placeholdersMatch(entry) {
  const used = new Set([...entry.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  return used.size === entry.params.length && [...used].every((n) => n >= 1 && n <= entry.params.length);
}
test('lifecycle list: question-bank roles only; status validated; every bind parameter used', async () => {
  sql(/LEFT\(q.question_text, 300\)/i, [{ id: QID, question_status: 'UNDER_REVIEW' }]);
  sql(/GROUP BY q.question_status/i, [{ question_status: 'UNDER_REVIEW', n: 1 }]);
  for (const who of ['teacher', 'reviewer', 'hod']) {
    log.length = 0;
    const r = await call('GET', '/questions/lifecycle', null, who);
    assert.equal(r.status, 200, `${who} ${JSON.stringify(r.data)}`);
    assert.equal(r.data.counts.UNDER_REVIEW, 1);
    for (const l of log.filter((x) => /FROM questions q/.test(x.text))) assert.ok(placeholdersMatch(l), `${who}: ${l.text.slice(0, 120)}`);
  }
  for (const who of ['coe', 'admin', 'v1']) assert.equal((await call('GET', '/questions/lifecycle', null, who)).status, 403, who);
  assert.equal((await call('GET', '/questions/lifecycle?status=IN_REVIEW', null, 'hod')).status, 400);
});
test('lifecycle list: reviewer sees assigned offerings only and never own questions; HOD never sees drafts; review-batch flag and change request exposed', async () => {
  sql(/AS in_review_batch/i, []); sql(/GROUP BY q.question_status/i, []);
  await call('GET', '/questions/lifecycle', null, 'reviewer');
  const rv = log.find((l) => /AS in_review_batch/.test(l.text));
  assert.match(rv.text, /q.submitted_by <> \$1/); assert.match(rv.text, /reviewer_assignments ra/);
  assert.match(rv.text, /AS in_review_batch/); assert.match(rv.text, /q.change_request_reason/);
  // Phase 4a: the full question for the review screens (text, type data, answer key, clean attachments only).
  assert.match(rv.text, /SELECT q.id, q.question_text, /); assert.match(rv.text, /q.answer_data/); assert.match(rv.text, /q.correct_answer/);
  assert.match(rv.text, /FROM question_attachments a WHERE a.question_id = q.id AND a.scan_status = 'clean'/);
  log.length = 0;
  await call('GET', '/questions/lifecycle?status=active', null, 'hod');
  const hd = log.find((l) => /AS in_review_batch/.test(l.text));
  assert.match(hd.text, /question_status <> 'DRAFT'/); assert.equal(hd.params[2], 'ACTIVE');
});

test('non question-bank roles are refused before the question is even looked up (no state leak)', async () => {
  for (const who of ['admin', 'coe', 'v1']) {
    log.length = 0;
    const r = await transition({ target_status: 'REJECTED', reason: 'probe' }, who);
    assert.equal(r.status, 403, who);
    assert.equal(log.some((l) => /FROM questions WHERE id/.test(l.text)), false, `${who} must not trigger a question lookup`);
  }
});
