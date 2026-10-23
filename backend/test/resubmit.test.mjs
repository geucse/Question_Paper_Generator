// Edit / submit / resubmit pipeline (PIVOT_SPEC_V2 §7, §9, §12, §14): one /submit route for DRAFT -> SUBMITTED and
// CHANGES_REQUESTED -> RESUBMITTED; edits keep the state and never touch the lifecycle columns.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, log, baseRules, start, call, USERS, IDS } from './harness.mjs';

const QID = '91000000-0000-0000-0000-000000000001';
const CO1 = 'c1000000-0000-0000-0000-000000000001';
const CO2 = 'c1000000-0000-0000-0000-000000000002';
let q; let assigned; let lockedStatus; let moved; let currentCos; let validCos; let currentVersion; let currentAnswer; let candidates;

const baseQuestion = (over = {}) => ({
  id: QID, submitted_by: USERS.teacher.id, question_status: 'DRAFT', is_draft: true, status: 'pending', course_offering_id: IDS.off, section_id: null,
  subject_id: IDS.subj, syllabus_version_id: IDS.sv, question_type: 'descriptive', question_text: 'Explain the AVL rotations', marks: 2, difficulty: 'easy',
  submitted_bloom_level: 'apply', topic: 'Trees', subtopic: null, option_a: null, option_b: null, option_c: null, option_d: null, correct_answer: null,
  model_answer: 'A long enough model answer', answer_data: null, question_hash: 'hash-1', embedding: null, canonical_question_id: null,
  change_request_reason: null, submitted_cos: null, ...over,
});

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => {
  baseRules();
  q = baseQuestion(); assigned = true; lockedStatus = null; moved = true; currentCos = []; validCos = [CO1, CO2];
  currentVersion = null; currentAnswer = null; candidates = [];
  sql(/SELECT \* FROM questions WHERE id = \$1$/i, () => [q]);
  sql(/SELECT \* FROM questions WHERE id = \$1 AND submitted_by = \$2 FOR UPDATE/i, () => [{ ...q, question_status: lockedStatus || q.question_status }]);
  sql(/FROM teacher_course_assignments tca/i, () => (assigned ? [{ course_offering_id: IDS.off, section_id: null, subject_id: IDS.subj }] : []));
  sql(/SELECT scan_status FROM question_attachments/i, []);
  sql(/FROM question_attachments WHERE question_id/i, []);
  sql(/COUNT\(\*\)::int AS n FROM question_attachments/i, [{ n: 0 }]);
  sql(/FROM previous_year_papers/i, []);
  sql(/question_hash = \$2 AND id != \$3/i, () => candidates);
  sql(/embedding <=> \$4::vector/i, []);
  sql(/INSERT INTO question_relationships/i, (p) => [{ id: 'rel1', source_question_id: p[0], target_question_id: p[1], status: 'pending', classification: p[5], similarity_score: p[3] }]);
  sql(/FROM course_outcomes WHERE id = ANY/i, (p) => p[0].filter((id) => validCos.includes(id)).map((id) => ({ id })));
  sql(/FROM question_course_outcomes WHERE canonical_question_id/i, () => currentCos);
  sql(/DELETE FROM question_course_outcomes/i, []);
  sql(/INSERT INTO question_course_outcomes/i, []);
  sql(/INSERT INTO canonical_questions/i, [{ id: 'cq-new' }]);
  sql(/INSERT INTO question_versions/i, [{ id: 'qv-new' }]);
  sql(/UPDATE canonical_questions/i, []);
  sql(/UPDATE question_versions SET is_current = FALSE/i, []);
  sql(/SELECT id, current_version_id FROM canonical_questions WHERE id = \$1 FOR UPDATE/i, () => [{ id: q.canonical_question_id, current_version_id: 'qv1' }]);
  sql(/SELECT \* FROM question_versions WHERE id/i, () => (currentVersion ? [currentVersion] : []));
  sql(/COALESCE\(MAX\(version_number\), 0\) \+ 1 AS n FROM question_versions/i, [{ n: 2 }]);
  sql(/COALESCE\(MAX\(version_number\), 0\) \+ 1 AS n FROM canonical_answers/i, [{ n: 2 }]);
  sql(/SELECT id, answer_text FROM canonical_answers/i, () => (currentAnswer ? [currentAnswer] : []));
  sql(/UPDATE canonical_answers/i, []);
  sql(/INSERT INTO canonical_answers/i, []);
  sql(/INSERT INTO question_canonicalization_events/i, []);
  sql(/UPDATE questions SET canonical_question_id/i, []);
  sql(/UPDATE questions SET question_status = \$1/i, () => (moved ? [{ id: QID }] : []));
  sql(/JOIN user_scopes s ON s.user_id = u.id AND s.role = 'hod'/i, [{ id: USERS.hod.id }]);
  sql(/UPDATE questions SET question_type=\$1/i, () => [{ id: QID, question_status: q.question_status }]);
  sql(/lower\(code\) = ANY/i, (p) => (p[1].includes('co1') ? [{ id: CO1, code: 'co1' }] : []));
});

const editBody = (over = {}) => ({ id: QID, question_type: 'descriptive', question_text: 'Explain the AVL rotations in detail', difficulty: 'easy', marks: 4,
  bloom_level: 'apply', topic: 'Trees', model_answer: 'A long enough model answer', ...over });
const auditOf = (action) => log.filter((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === action).map((l) => JSON.parse(l.params[4]));
const indexOf = (re) => log.findIndex((l) => re.test(l.text));

// ---- edit ----
test('edit of a DRAFT writes content only, conditional on the editable states and the author', async () => {
  const r = await call('POST', '/questions/draft', editBody(), 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const upd = log.find((l) => /UPDATE questions SET question_type=\$1/.test(l.text));
  const set = upd.text.slice(0, upd.text.indexOf(' WHERE '));
  assert.doesNotMatch(set, /\bis_draft\b|\bstatus\s*=|question_status\s*=|submitted_at/);
  assert.match(upd.text, /question_status IN \('DRAFT', 'CHANGES_REQUESTED'\)/);
  assert.match(set, /ai_review_dispute=NULL/);
  assert.equal(upd.params[17], USERS.teacher.id);
  assert.match(upd.text, /syllabus_version_id=\$19, subtopic_id=\$20/);
  assert.equal(upd.params[18], IDS.sv, 'written against the offering\'s current syllabus version');
});
test('edit of a CHANGES_REQUESTED question keeps the state and records old/new metadata (spec §12)', async () => {
  q = baseQuestion({ question_status: 'CHANGES_REQUESTED', is_draft: false, status: 'needs_teacher_fix', canonical_question_id: 'cq1' });
  const r = await call('POST', '/questions/draft', editBody(), 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.question_status, 'CHANGES_REQUESTED');
  const [d] = auditOf('draft_updated');
  assert.equal(d.question_status, 'CHANGES_REQUESTED');
  assert.deepEqual(d.metadata_changes.marks, { old: 2, new: 4 });
  assert.ok(d.content_changed.includes('question_text'));
});
test('edit refused in every state after submission, including the old AI-review bypass on an ACTIVE question', async () => {
  for (const st of ['SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'RETIRED', 'REJECTED']) {
    log.length = 0;
    q = baseQuestion({ question_status: st, is_draft: false, status: st === 'ACTIVE' ? 'needs_teacher_fix' : 'pending' });
    const r = await call('POST', '/questions/draft', editBody(), 'teacher');
    assert.equal(r.status, 400, st);
    assert.equal(log.some((l) => /UPDATE questions SET/.test(l.text)), false, st);
  }
});
test('edit: a race returns 409; an unassigned teacher gets 403; another teacher\'s question 404', async () => {
  sql(/UPDATE questions SET question_type=\$1/i, []);
  assert.equal((await call('POST', '/questions/draft', editBody(), 'teacher')).status, 409);
  assigned = false;
  assert.equal((await call('POST', '/questions/draft', editBody(), 'teacher')).status, 403);
  assigned = true; q = baseQuestion({ submitted_by: 'someone-else' });
  assert.equal((await call('POST', '/questions/draft', editBody(), 'teacher')).status, 404);
});

// ---- submit ----
test('submit of a DRAFT creates the canonical question (with type data) and moves to SUBMITTED last', async () => {
  q = baseQuestion({ answer_data: { language: 'Python' }, subtopic: 'Rotations' });
  const r = await call('POST', `/questions/${QID}/submit`, { primary_course_outcome_id: CO1 }, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.question_status, 'SUBMITTED'); assert.equal(r.data.canonical_created, true);
  const lock = indexOf(/FOR UPDATE/); const canon = indexOf(/INSERT INTO canonical_questions/);
  const ver = log.find((l) => /INSERT INTO question_versions/.test(l.text));
  const move = log.find((l) => /UPDATE questions SET question_status = \$1/.test(l.text));
  assert.ok(lock >= 0 && lock < canon && canon < log.indexOf(move), 'lock -> canonical -> state change');
  assert.match(ver.text, /answer_data, subtopic/); assert.equal(ver.params[9], '{"language":"Python"}'); assert.equal(ver.params[10], 'Rotations');
  assert.deepEqual(move.params, ['SUBMITTED', QID, 'DRAFT']);
  const [a] = auditOf('question_final_submit');
  assert.equal(a.from, 'DRAFT'); assert.equal(a.to, 'SUBMITTED');
  assert.ok(log.some((l) => /INSERT INTO question_course_outcomes/.test(l.text) && l.params[1] === CO1 && l.params[3] === 'manual'));
});
test('resubmit of a CHANGES_REQUESTED question appends version 2 to the SAME canonical question and keeps its COs', async () => {
  q = baseQuestion({ question_status: 'CHANGES_REQUESTED', canonical_question_id: 'cq1', change_request_reason: 'clarify' });
  currentVersion = { id: 'qv1', version_number: 1, question_text: 'Old wording here', question_type: 'descriptive', marks: 2 };
  currentAnswer = { id: 'ca1', answer_text: 'A long enough model answer' };
  currentCos = [{ course_outcome_id: CO1, relationship_type: 'primary' }];
  const r = await call('POST', `/questions/${QID}/submit`, {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.question_status, 'RESUBMITTED'); assert.equal(r.data.version_number, 2); assert.equal(r.data.canonical_question_id, 'cq1');
  assert.equal(log.some((l) => /INSERT INTO canonical_questions/.test(l.text)), false, 'no second canonical question');
  assert.ok(indexOf(/UPDATE question_versions SET is_current = FALSE/) < indexOf(/INSERT INTO question_versions/));
  assert.ok(log.some((l) => /UPDATE canonical_questions SET current_version_id/.test(l.text)));
  assert.equal(log.some((l) => /DELETE FROM question_course_outcomes/.test(l.text)), false, 'CO mapping kept');
  assert.equal(log.some((l) => /INSERT INTO canonical_answers/.test(l.text)), false, 'unchanged answer not re-versioned');
  assert.deepEqual(log.find((l) => /UPDATE questions SET question_status = \$1/.test(l.text)).params, ['RESUBMITTED', QID, 'CHANGES_REQUESTED']);
  assert.match(log.find((l) => /INSERT INTO question_versions/.test(l.text)).params[13], /Revision after reviewer change request: clarify/);
  assert.equal(auditOf('question_resubmitted').length, 1);
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.hod.id), 'in-scope HOD told');
});
test('resubmit without content changes adds no version; a changed model answer supersedes the canonical answer', async () => {
  q = baseQuestion({ question_status: 'CHANGES_REQUESTED', canonical_question_id: 'cq1' });
  currentVersion = { id: 'qv1', version_number: 1, question_text: q.question_text, question_type: 'descriptive', marks: 2, answer_data: {} };
  currentAnswer = { id: 'ca1', answer_text: 'The previous answer' };
  const r = await call('POST', `/questions/${QID}/submit`, {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.version_unchanged, true); assert.equal(r.data.version_number, 1);
  assert.equal(log.some((l) => /INSERT INTO question_versions/.test(l.text)), false);
  assert.ok(log.some((l) => /UPDATE canonical_answers SET is_current = FALSE, status = 'superseded'/.test(l.text) && l.params[0] === 'ca1'));
  const ans = log.find((l) => /INSERT INTO canonical_answers/.test(l.text));
  assert.deepEqual([ans.params[1], ans.params[2]], [2, q.model_answer]);
});
test('a CO choice that differs replaces the mapping (audited old/new); the same choice changes nothing', async () => {
  q = baseQuestion({ question_status: 'CHANGES_REQUESTED', canonical_question_id: 'cq1' });
  currentVersion = { id: 'qv1', version_number: 1, question_text: q.question_text, question_type: 'descriptive', marks: 2 };
  currentCos = [{ course_outcome_id: CO1, relationship_type: 'primary' }];
  await call('POST', `/questions/${QID}/submit`, { primary_course_outcome_id: CO2 }, 'teacher');
  assert.ok(log.some((l) => /DELETE FROM question_course_outcomes/.test(l.text)));
  const [c] = auditOf('question_co_mapping_changed');
  assert.equal(c.old[0].course_outcome_id, CO1); assert.equal(c.new.primaryId, CO2);
  log.length = 0;
  await call('POST', `/questions/${QID}/submit`, { primary_course_outcome_id: CO1 }, 'teacher');
  assert.equal(log.some((l) => /DELETE FROM question_course_outcomes/.test(l.text)), false);
});
test('a bulk-imported draft with no CO mapping gets the codes typed in its spreadsheet row', async () => {
  q = baseQuestion({ submitted_cos: ['CO1', 'CO7'] });
  const r = await call('POST', `/questions/${QID}/submit`, {}, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(log.some((l) => /INSERT INTO question_course_outcomes/.test(l.text) && l.params[1] === CO1 && l.params[3] === 'bulk'));
  assert.deepEqual(r.data.unmapped_cos, ['CO7']);
});
test('CO input is validated before anything is written', async () => {
  for (const [body, re] of [[{ primary_course_outcome_id: 'not-a-uuid' }, /malformed/], [{ primary_course_outcome_id: 'c1000000-0000-0000-0000-0000000000ff' }, /not part of/],
    [{ secondary_course_outcome_ids: [CO2] }, /primary course outcome/]]) {
    log.length = 0;
    const r = await call('POST', `/questions/${QID}/submit`, body, 'teacher');
    assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.data.error, re);
    assert.equal(log.some((l) => /FOR UPDATE|UPDATE questions/.test(l.text)), false);
  }
});
test('submit: refused states, unclean attachment, duplicate, races, roles', async () => {
  for (const st of ['SUBMITTED', 'UNDER_REVIEW', 'ACTIVE', 'REJECTED']) {
    log.length = 0; q = baseQuestion({ question_status: st });
    assert.equal((await call('POST', `/questions/${QID}/submit`, {}, 'teacher')).status, 400, st);
    assert.equal(log.some((l) => /question_hash = \$2 AND id != \$3/.test(l.text)), false, `${st}: refused before the duplicate check`);
  }
  q = baseQuestion();
  sql(/SELECT scan_status FROM question_attachments/i, [{ scan_status: 'failed' }]);
  assert.equal((await call('POST', `/questions/${QID}/submit`, {}, 'teacher')).status, 400);
  sql(/SELECT scan_status FROM question_attachments/i, []);
  candidates = [{ id: 'other', question_hash: 'hash-1', canonical_question_id: 'cq-other', question_type: 'descriptive', marks: 2, question_text: 'x' }];
  assert.equal((await call('POST', `/questions/${QID}/submit`, {}, 'teacher')).status, 400, 'pending exact duplicate blocks');
  q = baseQuestion({ question_status: 'CHANGES_REQUESTED', canonical_question_id: 'cq1' });
  currentVersion = { id: 'qv1', version_number: 1, question_text: q.question_text, question_type: 'descriptive', marks: 2 };
  candidates = [{ id: 'sibling', question_hash: 'hash-1', canonical_question_id: 'cq1', question_type: 'descriptive', marks: 2, question_text: 'x' }];
  assert.equal((await call('POST', `/questions/${QID}/submit`, {}, 'teacher')).status, 200, 'a candidate of the same canonical question is ignored');
  candidates = [];
  log.length = 0; lockedStatus = 'RESUBMITTED';
  assert.equal((await call('POST', `/questions/${QID}/submit`, {}, 'teacher')).status, 409);
  lockedStatus = null; moved = false;
  assert.equal((await call('POST', `/questions/${QID}/submit`, {}, 'teacher')).status, 409);
  assert.equal(auditOf('question_resubmitted').length, 0, 'nothing audited for a refused submit');
  for (const who of ['reviewer', 'hod']) assert.equal((await call('POST', `/questions/${QID}/submit`, {}, who)).status, 403, who);
});

// ---- duplicate decision and preview ----
test('duplicate decision on a CHANGES_REQUESTED question: different is fine, withdrawing is not', async () => {
  q = baseQuestion({ question_status: 'CHANGES_REQUESTED' });
  sql(/SELECT \* FROM question_relationships WHERE id = \$1 AND source_question_id/i, [{ id: 'rel1', status: 'pending', classification: 'LIKELY_DUPLICATE', target_question_id: 't1', similarity_score: 0.95, source: 'lexical_embedding' }]);
  sql(/SELECT id, canonical_question_id FROM questions WHERE id/i, [{ id: 't1', canonical_question_id: 'cq-t' }]);
  sql(/UPDATE question_relationships/i, []);
  assert.equal((await call('POST', `/questions/${QID}/duplicate-decision`, { relationship_id: 'rel1', decision: 'different' }, 'teacher')).status, 200);
  log.length = 0;
  assert.equal((await call('POST', `/questions/${QID}/duplicate-decision`, { relationship_id: 'rel1', decision: 'use_existing' }, 'teacher')).status, 400);
  assert.equal(log.some((l) => /UPDATE questions/.test(l.text)), false);
  q = baseQuestion({ question_status: 'SUBMITTED' });
  assert.equal((await call('POST', `/questions/${QID}/duplicate-decision`, { relationship_id: 'rel1', decision: 'different' }, 'teacher')).status, 400);
});
test('preview tells the client whether this is a submit, a resubmit, or neither', async () => {
  q = baseQuestion({ question_status: 'CHANGES_REQUESTED' });
  assert.equal((await call('GET', `/questions/${QID}/preview`, null, 'teacher')).data.submit_mode, 'resubmit');
  q = baseQuestion({ question_status: 'UNDER_REVIEW' });
  const r = await call('GET', `/questions/${QID}/preview`, null, 'teacher');
  assert.equal(r.data.submit_mode, null); assert.equal(r.data.can_submit, false);
});

// Review issue: /preview had no scope for non-teacher roles and wrote pending duplicate rows for any question,
// which then blocked that question's activation / restore in the quality gate.
test('preview is the author\'s screen: other roles get 403, another teacher\'s question 404, nothing persisted', async () => {
  q = baseQuestion({ question_status: 'APPROVED' });
  for (const who of ['hod', 'reviewer', 'coe', 'v1', 'admin']) {
    assert.equal((await call('GET', `/questions/${QID}/preview`, null, who)).status, 403, who);
  }
  q = baseQuestion({ submitted_by: 'someone-else' });
  assert.equal((await call('GET', `/questions/${QID}/preview`, null, 'teacher')).status, 404);
  assert.equal(log.some((l) => /INSERT INTO question_relationships|FROM questions WHERE course_offering_id/.test(l.text)), false);
});
test('preview records duplicate candidates only while the question is editable', async () => {
  candidates = [{ id: 'other-q', question_text: 'Explain the AVL rotations', question_hash: 'hash-1', canonical_question_id: 'cq-other', course_offering_id: IDS.off }];
  for (const st of ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'RETIRED']) {
    q = baseQuestion({ question_status: st });
    const r = await call('GET', `/questions/${QID}/preview`, null, 'teacher');
    assert.equal(r.status, 200, `${st} ${JSON.stringify(r.data)}`);
    assert.deepEqual(r.data.duplicate_candidates, [], st);
  }
  assert.equal(log.some((l) => /INSERT INTO question_relationships/.test(l.text)), false, 'no pending rows written for a locked question');
  q = baseQuestion({ question_status: 'DRAFT' });
  const d = await call('GET', `/questions/${QID}/preview`, null, 'teacher');
  assert.equal(d.status, 200);
  assert.ok(log.some((l) => /INSERT INTO question_relationships/.test(l.text)), 'a draft still gets the duplicate pipeline');
  assert.equal(d.data.duplicate_candidates.length, 1);
});
// Review issue: SUBMITTED -> DRAFT (withdraw) then 'use existing' re-linked the question to another canonical
// question, orphaning its own canonical record, versions and CO mapping.
test('use_existing is refused for a withdrawn draft that already has its own canonical question; nothing written', async () => {
  q = baseQuestion({ question_status: 'DRAFT', canonical_question_id: 'cq-own' });
  sql(/SELECT \* FROM question_relationships WHERE id = \$1 AND source_question_id/i, [{ id: 'rel1', status: 'pending', classification: 'LIKELY_DUPLICATE', target_question_id: 't1', similarity_score: 0.95, source: 'lexical_embedding' }]);
  sql(/SELECT id, canonical_question_id FROM questions WHERE id/i, [{ id: 't1', canonical_question_id: 'cq-t' }]);
  sql(/UPDATE question_relationships/i, []);
  const r = await call('POST', `/questions/${QID}/duplicate-decision`, { relationship_id: 'rel1', decision: 'use_existing' }, 'teacher');
  assert.equal(r.status, 400); assert.match(r.data.error, /already submitted/);
  assert.equal(log.some((l) => /UPDATE questions|UPDATE question_relationships|question_canonicalization_events/.test(l.text)), false);
  assert.equal((await call('POST', `/questions/${QID}/duplicate-decision`, { relationship_id: 'rel1', decision: 'different' }, 'teacher')).status, 200, 'it can still be marked different');
});
test('use_existing on a never-submitted draft: conditional withdrawal, then link; a race leaves nothing half-done', async () => {
  q = baseQuestion({ question_status: 'DRAFT' });
  sql(/SELECT \* FROM question_relationships WHERE id = \$1 AND source_question_id/i, [{ id: 'rel1', status: 'pending', classification: 'LIKELY_DUPLICATE', target_question_id: 't1', similarity_score: 0.95, source: 'lexical_embedding' }]);
  sql(/SELECT id, canonical_question_id FROM questions WHERE id/i, [{ id: 't1', canonical_question_id: 'cq-t' }]);
  sql(/UPDATE question_relationships/i, []);
  let withdrawn = [{ id: QID }];
  sql(/UPDATE questions SET status = 'withdrawn_duplicate'/i, () => withdrawn);
  const ok = await call('POST', `/questions/${QID}/duplicate-decision`, { relationship_id: 'rel1', decision: 'use_existing' }, 'teacher');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(log.find((l) => /withdrawn_duplicate/.test(l.text)).text, /question_status = 'DRAFT' AND canonical_question_id IS NULL/);
  log.length = 0; withdrawn = [];
  assert.equal((await call('POST', `/questions/${QID}/duplicate-decision`, { relationship_id: 'rel1', decision: 'use_existing' }, 'teacher')).status, 409);
  assert.equal(log.some((l) => /UPDATE question_relationships|UPDATE questions SET canonical_question_id/.test(l.text)), false);
});
