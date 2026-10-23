// Phase 4b route tests (migration 042): the syllabus version state machine, immutable content, copy-forward, change
// detection with targeted question moves at activation, the change report, the HOD's question mapping (scope,
// validation, cross-department denial), topic / subtopic placement of drafts, and the generator's verified-only pool.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, log, baseRules, start, call, USERS, IDS, oid, installWorld, WORLD, writes, PLACEMENT } from './harness.mjs';
import { SCOPE_SQL } from '../src/scopes.js';

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => { baseRules(); installWorld(); trees = {}; });

const A = '/academic';
const DRAFT = () => oid('sv_draft', 'A1');
const PENDING = () => oid('sv_pending', 'A1');
const audits = (action) => log.filter((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === action).map((l) => ({ entity: l.params[3], ...JSON.parse(l.params[4]) }));

// ---- state machine ----
test('create: HOD only; a concurrent create of the same version number is 409, not 500; the new version is a DRAFT', async () => {
  const refused = await call('POST', `${A}/syllabus-versions`, { course_offering_id: IDS.off, notes: 'Unit 1: trees' }, 'teacher');
  assert.equal(refused.status, 403, 'teachers cannot create (replace) the official syllabus'); assert.deepEqual(writes(), []);
  sql(/^INSERT INTO syllabus_versions/i, () => { throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }); });
  const r = await call('POST', `${A}/syllabus-versions`, { course_offering_id: IDS.off, notes: 'Unit 1: trees' }, 'hod');
  assert.equal(r.status, 409); assert.match(r.data.error, /at the same time/);
  baseRules(); installWorld();
  sql(/^INSERT INTO syllabus_versions/i, (p) => [{ id: 'v-new', version_number: p[1] }]);
  const ok = await call('POST', `${A}/syllabus-versions`, { course_offering_id: IDS.off, notes: 'Unit 1: trees' }, 'hod');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const ins = log.find((l) => /^INSERT INTO syllabus_versions/.test(l.text));
  assert.match(ins.text, /'pending', 'pending', 'pending', 'DRAFT'\)/);
  assert.equal(audits('syllabus_version_created')[0].status, 'DRAFT');
});

test('verify: HOD only, DRAFT only, with complete content; conditional on the state; audited', async () => {
  assert.equal((await call('POST', `${A}/syllabus-versions/${DRAFT()}/verify`, null, 'teacher')).status, 403); assert.deepEqual(writes(), []);
  sql(/^SELECT syllabus_version_content_problems\(\$1\) AS problems/i, [{ problems: ['at least one active unit with at least one active topic'] }]);
  let r = await call('POST', `${A}/syllabus-versions/${DRAFT()}/verify`, null, 'hod');
  assert.equal(r.status, 400); assert.match(r.data.error, /at least one active unit/); assert.deepEqual(writes(), []);
  baseRules(); installWorld();
  r = await call('POST', `${A}/syllabus-versions/${PENDING()}/verify`, null, 'hod');
  assert.equal(r.status, 409); assert.match(r.data.error, /Only a DRAFT version/);
  r = await call('POST', `${A}/syllabus-versions/${DRAFT()}/verify`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const upd = log.find((l) => /^UPDATE syllabus_versions SET/.test(l.text));
  assert.match(upd.text, /status = 'TEACHER_VERIFIED', verified_by = \$3, updated_at = now\(\) WHERE id = \$1 AND status = \$2/);
  assert.deepEqual(upd.params, [DRAFT(), 'DRAFT', USERS.hod.id]);
  assert.deepEqual(audits('syllabus_version_verified').map((a) => [a.from, a.to]), [['DRAFT', 'TEACHER_VERIFIED']]);
  // Moved meanwhile: the conditional UPDATE matches nothing.
  sql(/^UPDATE syllabus_versions SET status = 'TEACHER_VERIFIED'/i, []);
  assert.equal((await call('POST', `${A}/syllabus-versions/${DRAFT()}/verify`, null, 'hod')).status, 409);
});

test('submit for HOD review: HOD only, only TEACHER_VERIFIED; a DB refusal is shown as 400', async () => {
  assert.equal((await call('POST', `${A}/syllabus-versions/${DRAFT()}/submit-review`, null, 'hod')).status, 409);
  WORLD.versions[DRAFT()].status = 'TEACHER_VERIFIED';
  assert.equal((await call('POST', `${A}/syllabus-versions/${DRAFT()}/submit-review`, null, 'reviewer')).status, 403);
  WORLD.versions[DRAFT()].uploaded_by = USERS.teacher.id;
  assert.equal((await call('POST', `${A}/syllabus-versions/${DRAFT()}/submit-review`, null, 'teacher')).status, 403, 'not even the uploading teacher');
  assert.deepEqual(writes(), []);
  const r = await call('POST', `${A}/syllabus-versions/${DRAFT()}/submit-review`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(log.find((l) => /^UPDATE syllabus_versions SET/.test(l.text)).params, [DRAFT(), 'TEACHER_VERIFIED', USERS.hod.id]);
  sql(/^UPDATE syllabus_versions SET status = 'HOD_REVIEW'/i, () => { throw new Error('Invalid syllabus version transition: DRAFT -> HOD_REVIEW'); });
  const db = await call('POST', `${A}/syllabus-versions/${DRAFT()}/submit-review`, null, 'hod');
  assert.equal(db.status, 400); assert.match(db.data.error, /Invalid syllabus version transition/);
});

test('return to draft: HOD only, with a reason, from TEACHER_VERIFIED or HOD_REVIEW; the creator is told', async () => {
  assert.equal((await call('POST', `${A}/syllabus-versions/${PENDING()}/return`, { reason: 'Unit 3 missing' }, 'teacher')).status, 403);
  assert.equal((await call('POST', `${A}/syllabus-versions/${PENDING()}/return`, { reason: 'Unit 3 missing' }, 'hodA2')).status, 403);
  assert.equal((await call('POST', `${A}/syllabus-versions/${PENDING()}/return`, { reason: '' }, 'hod')).status, 400);
  assert.equal((await call('POST', `${A}/syllabus-versions/${DRAFT()}/return`, { reason: 'Unit 3 missing' }, 'hod')).status, 409);
  assert.deepEqual(writes(), []);
  const r = await call('POST', `${A}/syllabus-versions/${PENDING()}/return`, { reason: 'Unit 3 missing' }, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const upd = log.find((l) => /^UPDATE syllabus_versions SET/.test(l.text));
  assert.match(upd.text, /status = 'DRAFT', returned_reason = \$3/); assert.deepEqual(upd.params, [PENDING(), 'HOD_REVIEW', 'Unit 3 missing']);
  assert.ok(log.some((l) => /INSERT INTO notifications/.test(l.text) && l.params[0] === USERS.teacher.id));
  assert.equal(audits('syllabus_version_returned')[0].reason, 'Unit 3 missing');
});

test('reject: needs a reason; the ACTIVE version is never rejected; a superseded or rejected one is final', async () => {
  let r = await call('POST', `${A}/syllabus-versions/${IDS.sv}/reject`, { reason: 'outdated' }, 'hod');
  assert.equal(r.status, 409); assert.match(r.data.error, /ACTIVE syllabus version cannot be rejected/);
  for (const st of ['SUPERSEDED', 'REJECTED']) {
    WORLD.versions[DRAFT()].status = st;
    assert.equal((await call('POST', `${A}/syllabus-versions/${DRAFT()}/reject`, { reason: 'outdated' }, 'hod')).status, 409, st);
  }
  WORLD.versions[DRAFT()].status = 'DRAFT';
  r = await call('POST', `${A}/syllabus-versions/${DRAFT()}/reject`, {}, 'hod');
  assert.equal(r.status, 400); assert.match(r.data.error, /reason/);
  assert.deepEqual(writes(), []);
  r = await call('POST', `${A}/syllabus-versions/${DRAFT()}/reject`, { reason: 'Wrong syllabus file' }, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const upd = log.find((l) => /^UPDATE syllabus_versions SET/.test(l.text));
  assert.match(upd.text, /status = 'REJECTED', rejected_by = \$3, rejection_reason = \$4/);
  assert.deepEqual(upd.params, [DRAFT(), 'DRAFT', USERS.hod.id, 'Wrong syllabus file']);
  assert.equal(audits('syllabus_version_rejected')[0].from, 'DRAFT');
});

// ---- approved content is immutable ----
test('content of a version that is not DRAFT cannot be created, changed or deactivated (409, nothing written)', async () => {
  for (const status of ['ACTIVE', 'SUPERSEDED', 'HOD_REVIEW', 'TEACHER_VERIFIED', 'REJECTED']) {
    WORLD.versions[IDS.sv].status = status;
    const cases = [
      ['POST', `${A}/syllabus-versions/${IDS.sv}/units`, { code: 'U9', title: 'Graphs' }],
      ['POST', `${A}/syllabus-versions/${IDS.sv}/course-outcomes`, { code: 'CO9', description: 'Explain' }],
      ['POST', `${A}/units/${oid('unit', 'A1')}/topics`, { title: 'BFS' }],
      ['POST', `${A}/units/${oid('unit', 'A1')}/deactivate`, null],
      ['POST', `${A}/topics/${oid('topic', 'A1')}/deactivate`, null],
      ['POST', `${A}/topics/${oid('topic', 'A1')}/subtopics`, { title: 'Rotations' }],
      ['POST', `${A}/subtopics/${oid('subtopic', 'A1')}/deactivate`, null],
      ['POST', `${A}/course-outcomes/${oid('co', 'A1')}/deactivate`, null],
    ];
    for (const [m, path, body] of cases) {
      log.length = 0;
      const r = await call(m, path, body, 'hod');
      assert.equal(r.status, 409, `${status} ${path}`); assert.match(r.data.error, /content is locked/);
      assert.deepEqual(writes(), [], `${status} ${path}`);
    }
  }
  // The DB guard's refusal (a race past the route check) is a 409 too, never database text.
  WORLD.versions[DRAFT()].status = 'DRAFT';
  sql(/^INSERT INTO syllabus_units/i, () => { throw new Error('Syllabus content is locked: version 3 is HOD_REVIEW'); });
  const r = await call('POST', `${A}/syllabus-versions/${DRAFT()}/units`, { code: 'U9', title: 'Graphs' }, 'hod');
  assert.equal(r.status, 409); assert.doesNotMatch(r.data.error, /version 3 is/);
});

// ---- new version from the current one ----
const UNIT = '11110000-0000-0000-0000-0000000000c1'; const TOPIC = '22220000-0000-0000-0000-0000000000c1';
const SUB = '33330000-0000-0000-0000-0000000000c1'; const CO = '44440000-0000-0000-0000-0000000000c1';
// Trees by version id, served by one set of rules (a later rule would hide an earlier version's tree).
let trees = {};
function scriptTree(versionId, tree) {
  if (!Object.keys(trees).length || !trees.__installed) {
    trees = { __installed: true };
    const of = (fn) => (p) => (trees[p[0]] ? fn(trees[p[0]]) : []);
    sql(/^SELECT id, code, title, sequence FROM syllabus_units WHERE syllabus_version_id = \$1/i, of((t) => t.units.map(({ topics, ...u }) => u)));
    sql(/^SELECT t.id, t.title, t.sequence, t.syllabus_unit_id FROM syllabus_topics/i,
      of((t) => t.units.flatMap((u) => u.topics.map(({ subtopics, ...x }) => ({ ...x, syllabus_unit_id: u.id })))));
    sql(/^SELECT st.id, st.title, st.sort_order, st.syllabus_topic_id FROM syllabus_subtopics/i,
      of((t) => t.units.flatMap((u) => u.topics.flatMap((x) => (x.subtopics || []).map((st) => ({ ...st, syllabus_topic_id: x.id }))))));
    sql(/^SELECT id, code, description, sequence FROM course_outcomes WHERE syllabus_version_id = \$1/i, of((t) => t.cos));
  }
  trees[versionId] = tree;
}

test('new version from current: HOD only; copies units, topics, subtopics and COs into a new DRAFT; 409 without an ACTIVE version', async () => {
  scriptTree(IDS.sv, { units: [{ id: UNIT, code: 'U1', title: 'Trees', sequence: 1, topics: [{ id: TOPIC, title: 'AVL', sequence: 1, subtopics: [{ id: SUB, title: 'Rotations', sort_order: 0 }] }] }],
    cos: [{ id: CO, code: 'CO1', description: 'Explain trees', sequence: 1 }] });
  sql(/COALESCE\(MAX\(version_number\), 0\) \+ 1 AS n/i, [{ n: 4 }]);
  sql(/^INSERT INTO syllabus_versions/i, (p) => [{ id: 'v4', version_number: p[1], course_offering_id: p[0], based_on_version_id: p[4], status: 'DRAFT' }]);
  const path = `${A}/course-offerings/${IDS.off}/syllabus-versions/from-current`;
  for (const who of ['teacher', 'reviewer', 'hodA2', 'hodB', 'admin']) {
    log.length = 0;
    assert.equal((await call('POST', path, {}, who)).status, 403, who);
    assert.deepEqual(writes(), [], who);
  }
  const r = await call('POST', path, {}, 'hod');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.copied, { units: 1, topics: 1, subtopics: 1, cos: 1 });
  const ins = log.find((l) => /^INSERT INTO syllabus_versions/.test(l.text));
  assert.deepEqual([ins.params[0], ins.params[1], ins.params[4]], [IDS.off, 4, IDS.sv]); assert.match(ins.text, /'DRAFT'\)/);
  const unitIns = log.find((l) => /^INSERT INTO syllabus_units/.test(l.text));
  assert.deepEqual(unitIns.params.slice(0, 3), ['v4', 'U1', 'Trees']);
  assert.ok(log.some((l) => /^INSERT INTO syllabus_subtopics/.test(l.text) && l.params[1] === 'Rotations'));
  assert.ok(log.some((l) => /^INSERT INTO course_outcomes/.test(l.text) && l.params[1] === 'CO1' && l.params[2] === 'Explain trees'));
  assert.equal(audits('syllabus_version_created')[0].based_on_version_id, IDS.sv);
  WORLD.offerings[IDS.off].syllabus_version_id = null;
  const none = await call('POST', path, {}, 'hod');
  assert.equal(none.status, 409); assert.match(none.data.error, /no ACTIVE syllabus version/);
});

// ---- activation: change detection and targeted question moves ----
const NEW_UNIT = '11110000-0000-0000-0000-0000000000d1'; const NEW_TOPIC = '22220000-0000-0000-0000-0000000000d1';
const GONE_TOPIC = '22220000-0000-0000-0000-0000000000c2'; const CO2 = '44440000-0000-0000-0000-0000000000c2';
const NEW_CO = '44440000-0000-0000-0000-0000000000d1'; const NEW_CO2 = '44440000-0000-0000-0000-0000000000d2';
const Q = (n) => `9a420000-0000-0000-0000-00000000000${n}`;
const prevQ = (n, over) => ({ id: Q(n), submitted_by: USERS.teacher.id, canonical_question_id: `cq${n}`, topic: null, subtopic: null, subtopic_id: null,
  verified_syllabus_unit_id: UNIT, verified_syllabus_topic_id: TOPIC, verified_syllabus_subtopic_id: null, co_ids: [CO], canonical_shared: false, in_review_round: false, ...over });

function scriptActivation(questions) {
  scriptTree(IDS.sv, { units: [{ id: UNIT, code: 'U1', title: 'Trees', topics: [{ id: TOPIC, title: 'AVL', subtopics: [] }, { id: GONE_TOPIC, title: 'Heaps', subtopics: [] }] }],
    cos: [{ id: CO, code: 'CO1', description: 'Explain trees' }, { id: CO2, code: 'CO2', description: 'Apply graphs' }] });
  scriptTree(PENDING(), { units: [{ id: NEW_UNIT, code: 'u1', title: 'trees', topics: [{ id: NEW_TOPIC, title: 'avl', subtopics: [] }] }],
    cos: [{ id: NEW_CO, code: 'CO1', description: 'explain  trees' }, { id: NEW_CO2, code: 'CO2', description: 'Apply graph algorithms' }] });
  sql(/FROM questions q LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id WHERE q.course_offering_id = \$1 AND q.syllabus_version_id = \$2/i,
    (p) => (p[1] === IDS.sv ? questions : []));
  let changeId = 100;
  sql(/^INSERT INTO syllabus_changes/i, () => [{ id: String(changeId++) }]);
  sql(/^SELECT set_config\('app.syllabus_remap', 'on', true\)/i, [{ set_config: 'on' }]);
  sql(/^UPDATE questions SET syllabus_version_id = \$1, subtopic_id = \$2 WHERE id = \$3 AND syllabus_version_id = \$4 RETURNING id/i, (p) => [{ id: p[2] }]);
  sql(/^UPDATE questions SET question_status = 'CHANGES_REQUESTED'/i, (p) => [{ id: p[0] }]);
  sql(/^UPDATE canonical_questions SET/i, []);
  sql(/^INSERT INTO question_course_outcomes/i, []);
  sql(/^INSERT INTO question_syllabus_remaps/i, []);
  sql(/^INSERT INTO affected_questions/i, []);
}

test('approve: one transaction supersedes, activates, records the changes and moves only the affected questions', async () => {
  scriptActivation([
    prevQ(1, { question_status: 'APPROVED' }),                                           // every item unchanged -> re-mapped
    prevQ(2, { question_status: 'APPROVED', verified_syllabus_topic_id: GONE_TOPIC }),    // topic removed -> CHANGES_REQUESTED
    prevQ(3, { question_status: 'ACTIVE', co_ids: [CO2] }),                               // CO modified -> flagged, stays ACTIVE
    prevQ(4, { question_status: 'UNDER_REVIEW', in_review_round: true }),                 // in an open round -> left for mapping
    prevQ(5, { question_status: 'ACTIVE', verified_syllabus_unit_id: null, verified_syllabus_topic_id: null, topic: 'Quantum' }), // unmapped
    prevQ(6, { question_status: 'DRAFT', canonical_question_id: null, verified_syllabus_unit_id: null, verified_syllabus_topic_id: null, topic: 'AVL', co_ids: [] }), // text topic, unchanged
  ]);
  const r = await call('POST', `${A}/syllabus-versions/${PENDING()}/approve`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.changes, r.data.questions_remapped, r.data.questions_sent_back, r.data.questions_flagged, r.data.questions_unmapped, r.data.questions_skipped],
    [2, 2, 1, 1, 1, 1]);

  // Changes: topic Heaps REMOVED, CO2 MODIFIED (case/space-insensitive matches are UNCHANGED).
  const changes = log.filter((l) => /^INSERT INTO syllabus_changes/.test(l.text)).map((l) => [l.params[3], l.params[2], l.params[4]]);
  assert.deepEqual(changes.sort(), [['course_outcome', 'MODIFIED', 'CO2'], ['topic', 'REMOVED', 'Heaps']]);

  // Unchanged: moved through the re-mapping hatch, verified ids and CO mapping carried over, history row.
  const hatch = log.findIndex((l) => /^SELECT set_config\('app.syllabus_remap'/.test(l.text));
  const moves = log.filter((l) => /^UPDATE questions SET syllabus_version_id = \$1, subtopic_id = \$2/.test(l.text));
  assert.deepEqual(moves.map((l) => l.params[2]).sort(), [Q(1), Q(6)]);
  assert.ok(hatch >= 0 && hatch < log.indexOf(moves[0]));
  assert.deepEqual(moves[0].params.slice(0, 4).filter((_, i) => i !== 2), [PENDING(), null, IDS.sv]);
  const cq = log.find((l) => /^UPDATE canonical_questions SET/.test(l.text));
  assert.deepEqual(cq.params, [NEW_UNIT, NEW_TOPIC, null, 'cq1']);
  const qco = log.find((l) => /^INSERT INTO question_course_outcomes/.test(l.text));
  assert.deepEqual(qco.params, ['cq1', [CO], [NEW_CO]]);
  const remaps = log.filter((l) => /^INSERT INTO question_syllabus_remaps/.test(l.text));
  assert.equal(remaps.length, 2); assert.match(remaps[0].text, /'auto_unchanged'/);

  // Affected APPROVED: the lifecycle move with the specific reason; affected row; transition audit.
  const sent = log.filter((l) => /^UPDATE questions SET question_status = 'CHANGES_REQUESTED'/.test(l.text));
  assert.deepEqual(sent.map((l) => l.params[0]), [Q(2)]);
  assert.match(sent[0].params[1], /topic "Heaps" removed/); assert.equal(sent[0].params[2], USERS.hod.id);
  const aff = log.filter((l) => /^INSERT INTO affected_questions/.test(l.text));
  assert.deepEqual(aff.map((l) => [l.params[1], l.params[3], l.params[6]]).sort(),
    [[Q(2), 'needs_review', 'changes_requested'], [Q(3), 'needs_remapping', 'flagged']]);
  const tr = audits('question_transition_changes_requested');
  assert.deepEqual(tr.map((a) => [a.entity, a.from, a.to]), [[Q(2), 'APPROVED', 'CHANGES_REQUESTED']]); assert.match(tr[0].reason, /Heaps/);
  // Affected ACTIVE: flagged only (no status write), audited.
  assert.equal(log.some((l) => /^UPDATE questions SET question_status/.test(l.text) && l.params[0] === Q(3)), false);
  assert.deepEqual(audits('question_syllabus_flagged').map((a) => [a.entity, a.question_status]), [[Q(3), 'ACTIVE']]);
  // In review: not moved, audited with the reason. Unmapped: untouched.
  assert.match(audits('question_syllabus_remap_skipped')[0].reason, /open review round/);
  assert.equal(log.some((l) => /^UPDATE questions/.test(l.text) && (l.params.includes(Q(4)) || l.params.includes(Q(5)))), false);
  // Version moves and audits.
  assert.deepEqual(audits('syllabus_version_superseded').map((a) => [a.entity, a.to]), [[IDS.sv, 'SUPERSEDED']]);
  const ap = audits('syllabus_version_approved')[0];
  assert.deepEqual([ap.previous_version_id, ap.questions_remapped, ap.questions_sent_back, ap.questions_flagged], [IDS.sv, 2, [Q(2)], [Q(3)]]);
  assert.equal(audits('question_syllabus_remapped').length, 2);
  // Every audit row is written inside the transaction after the data changes.
  const lastData = Math.max(...log.map((l, i) => (/^(UPDATE|INSERT INTO) (questions|canonical_questions|question_course_outcomes|question_syllabus_remaps|affected_questions|syllabus_changes)/.test(l.text) ? i : -1)));
  assert.ok(log.findIndex((l) => /INSERT INTO audit_log/.test(l.text)) > lastData);
  // The author and the offering's reviewers are told.
  const notes = log.filter((l) => /INSERT INTO notifications/.test(l.text)).map((l) => l.params[0]);
  assert.ok(notes.includes(USERS.teacher.id) && notes.includes(USERS.reviewer.id));
});

test('approve: a question whose canonical record is shared is not re-mapped (left for the HOD)', async () => {
  scriptActivation([prevQ(1, { question_status: 'ACTIVE', canonical_shared: true })]);
  const r = await call('POST', `${A}/syllabus-versions/${PENDING()}/approve`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.questions_skipped, 1); assert.equal(r.data.questions_remapped, 0);
  assert.equal(log.some((l) => /^UPDATE questions SET syllabus_version_id/.test(l.text)), false);
  assert.match(audits('question_syllabus_remap_skipped')[0].reason, /shared/);
});

// ---- change report ----
test('change report: the HOD in scope and assigned reviewers (never drafts or their own questions); others 403', async () => {
  sql(/FROM syllabus_changes WHERE new_version_id = \$1 ORDER BY/i, [{ id: '7', change_type: 'REMOVED', entity_type: 'topic', entity_id: 'Heaps' }]);
  sql(/FROM affected_questions aq JOIN questions q ON q.id = aq.question_id/i, [{ syllabus_change_id: 7, question_id: Q(2), question_status: 'CHANGES_REQUESTED', resolved: false }]);
  sql(/SELECT id, version_number, status FROM syllabus_versions WHERE id = COALESCE/i, [{ id: 'old', version_number: 1, status: 'SUPERSEDED' }]);
  sql(/FROM question_syllabus_remaps WHERE to_version_id = \$1 AND kind = 'auto_unchanged'/i, [{ n: 3 }]);
  const path = `${A}/syllabus-versions/${IDS.sv}/changes`;
  const r = await call('GET', path, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.changes[0].affected_questions[0].question_id, Q(2)); assert.equal(r.data.questions_remapped_unchanged, 3);
  const q = log.find((l) => /FROM affected_questions aq JOIN questions q/.test(l.text));
  assert.equal(q.params[3], false, 'HOD sees every affected question');
  log.length = 0;
  assert.equal((await call('GET', path, null, 'reviewer')).status, 200);
  const rq = log.find((l) => /FROM affected_questions aq JOIN questions q/.test(l.text));
  assert.equal(rq.params[3], true); assert.match(rq.text, /q.question_status <> 'DRAFT' AND q.submitted_by <> \$3/);
  for (const who of ['teacher', 'hodA2', 'hodB', 'reviewerA2', 'admin', 'coe']) assert.equal((await call('GET', path, null, who)).status, 403, who);
  // By offering (the reviewers' screen): the offering's ACTIVE version; the same scope rules.
  const byOff = `${A}/course-offerings/${IDS.off}/syllabus-changes`;
  for (const who of ['hod', 'reviewer']) {
    const x = await call('GET', byOff, null, who);
    assert.equal(x.status, 200, who); assert.equal(x.data.version.id, IDS.sv); assert.equal(x.data.changes.length, 1);
  }
  for (const who of ['teacher', 'hodA2', 'reviewerB', 'admin']) assert.equal((await call('GET', byOff, null, who)).status, 403, who);
  WORLD.offerings[IDS.off].syllabus_version_id = null;
  const none = await call('GET', byOff, null, 'hod');
  assert.equal(none.status, 200); assert.equal(none.data.version, null);
});

// ---- question mapping (legacy / superseded / unverified) ----
test('mapping list: HOD scope (SCOPE_SQL), optional offering checked by authorize(); other roles refused', async () => {
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p ON p.id = co.program_id LEFT JOIN subjects s/i, []);
  const r = await call('GET', `${A}/question-mapping`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const q = log.find((l) => /question_has_verified_mapping\(q.id\)/.test(l.text));
  assert.ok(q.text.includes(SCOPE_SQL.replace(/\s+/g, ' ').trim()));
  assert.match(q.text, /q.syllabus_version_id IS NULL OR sv.status = 'SUPERSEDED'/);
  assert.match(q.text, /q.question_status <> 'REJECTED'/);
  assert.deepEqual(q.params, [USERS.hod.id, 'hod', null, null]);
  assert.equal((await call('GET', `${A}/question-mapping?course_offering_id=${IDS.off}`, null, 'hod')).status, 200);
  assert.equal((await call('GET', `${A}/question-mapping?course_offering_id=${IDS.offA2}`, null, 'hod')).status, 403, 'another department');
  assert.equal((await call('GET', `${A}/question-mapping?course_offering_id=${IDS.offB}`, null, 'hod')).status, 403, 'another campus');
  assert.equal((await call('GET', `${A}/question-mapping?course_offering_id=abc`, null, 'hod')).status, 400);
  assert.equal((await call('GET', `${A}/question-mapping?kind=everything`, null, 'hod')).status, 400);
  for (const who of ['teacher', 'reviewer', 'admin', 'coe']) assert.equal((await call('GET', `${A}/question-mapping`, null, who)).status, 403, who);
});

const QM = '9a430000-0000-0000-0000-000000000001'; const OLD_SV = 'b0000000-0000-0000-0000-0000000000f0';
const MT = '22220000-0000-0000-0000-0000000000e1'; const MU = '11110000-0000-0000-0000-0000000000e1';
const MS = '33330000-0000-0000-0000-0000000000e1'; const MC = '44440000-0000-0000-0000-0000000000e1'; const MC2 = '44440000-0000-0000-0000-0000000000e2';
let mq;
function scriptMapping() {
  mq = { id: QM, course_offering_id: IDS.off, question_status: 'ACTIVE', canonical_question_id: 'cqm', syllabus_version_id: OLD_SV, subtopic_id: null };
  sql(/^SELECT id, course_offering_id, question_status, canonical_question_id, syllabus_version_id, subtopic_id FROM questions WHERE id = \$1/i, (p) => (p[0] === QM ? [mq] : []));
  sql(/^SELECT t.id, t.title, u.id AS unit_id FROM syllabus_topics t JOIN syllabus_units u/i, (p) => (p[0] === MT && p[1] === IDS.sv ? [{ id: MT, title: 'AVL', unit_id: MU }] : []));
  sql(/^SELECT id, title FROM syllabus_subtopics WHERE id = \$1 AND syllabus_topic_id = \$2 AND is_active/i, (p) => (p[0] === MS && p[1] === MT ? [{ id: MS, title: 'Rotations' }] : []));
  sql(/^SELECT id, code FROM course_outcomes WHERE id = ANY\(\$1::uuid\[\]\) AND syllabus_version_id = \$2/i, (p) => p[0].filter((id) => [MC, MC2].includes(id) && p[1] === IDS.sv).map((id) => ({ id })));
  sql(/^SELECT id, question_status, syllabus_version_id, subtopic_id, canonical_question_id FROM questions WHERE id = \$1 FOR UPDATE/i, () => [mq]);
  sql(/^SELECT 1 AS x FROM review_batch_items rbi/i, []);
  sql(/^SELECT 1 AS x FROM questions WHERE canonical_question_id = \$1 AND id <> \$2/i, []);
  sql(/FROM canonical_questions WHERE id = \$1 FOR UPDATE/i, [{ verified_syllabus_unit_id: null, verified_syllabus_topic_id: null, verified_syllabus_subtopic_id: null, verified_bloom_level: 'apply' }]);
  sql(/FROM question_course_outcomes qco JOIN course_outcomes oc ON oc.id = qco.course_outcome_id WHERE qco.canonical_question_id = \$1$/i, []);
  sql(/^SELECT set_config\('app.syllabus_remap', 'on', true\)/i, [{ set_config: 'on' }]);
  sql(/^UPDATE canonical_questions SET/i, []);
  sql(/^DELETE FROM question_course_outcomes/i, []);
  sql(/^INSERT INTO question_course_outcomes/i, []);
  sql(/^INSERT INTO question_syllabus_remaps/i, []);
  sql(/^UPDATE affected_questions SET reviewed = TRUE/i, [{ id: 1 }]);
  sql(/^SELECT question_has_verified_mapping\(\$1\) AS ok/i, [{ ok: true }]);
}
const mapBody = (over = {}) => ({ syllabus_unit_id: MU, syllabus_topic_id: MT, syllabus_subtopic_id: MS, primary_course_outcome_id: MC,
  secondary_course_outcome_ids: [MC2], reason: 'Topic AVL is unchanged in the new syllabus', ...over });

test('mapping: the HOD maps a question onto the ACTIVE version with verified unit/topic/subtopic/COs, a reason and an audit row', async () => {
  scriptMapping();
  const r = await call('POST', `${A}/questions/${QM}/syllabus-mapping`, mapBody(), 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.syllabus_version_id, r.data.generation_eligible], [IDS.sv, true]);
  const at = (re) => log.findIndex((l) => re.test(l.text));
  assert.ok(at(/^SELECT set_config\('app.syllabus_remap'/) < at(/^UPDATE questions SET syllabus_version_id = \$1, subtopic_id = \$2 WHERE id = \$3/));
  assert.deepEqual(log[at(/^UPDATE questions SET syllabus_version_id = \$1/)].params, [IDS.sv, MS, QM]);
  const cq = log[at(/^UPDATE canonical_questions SET/)];
  assert.deepEqual(cq.params.slice(0, 5), [MU, MT, MS, null, USERS.hod.id]);
  const cos = log.filter((l) => /^INSERT INTO question_course_outcomes/.test(l.text)).map((l) => [l.params[1], l.params[2], l.params[3]]);
  assert.deepEqual(cos, [[MC, 'primary', USERS.hod.id], [MC2, 'secondary', USERS.hod.id]]);
  assert.match(log[at(/^INSERT INTO question_syllabus_remaps/)].text, /'hod_mapping'/);
  const [a] = audits('question_syllabus_mapped');
  assert.equal(a.reason, 'Topic AVL is unchanged in the new syllabus'); assert.equal(a.old.syllabus_version_id, OLD_SV); assert.equal(a.new.topic_id, MT);
  assert.equal(a.affected_rows_resolved, 1);
});

test('mapping: every id must belong to the ACTIVE version; reason and states checked; nothing written on a refusal', async () => {
  scriptMapping();
  const bad = [
    [mapBody({ reason: 'short' }), 400, /reason/],
    [mapBody({ syllabus_topic_id: null }), 400, /required/],
    [mapBody({ syllabus_topic_id: 'x' }), 400, /valid ids/],
    [mapBody({ syllabus_topic_id: '22220000-0000-0000-0000-0000000000e9' }), 400, /topic is not part/],
    [mapBody({ syllabus_unit_id: '11110000-0000-0000-0000-0000000000e9' }), 400, /unit does not contain/],
    [mapBody({ syllabus_subtopic_id: '33330000-0000-0000-0000-0000000000e9' }), 400, /subtopic is not under/],
    [mapBody({ primary_course_outcome_id: '44440000-0000-0000-0000-0000000000e9' }), 400, /Course outcome/],
    [mapBody({ bloom_level: 'memorize' }), 400, /bloom_level/],
  ];
  for (const [body, status, re] of bad) {
    log.length = 0;
    const r = await call('POST', `${A}/questions/${QM}/syllabus-mapping`, body, 'hod');
    assert.equal(r.status, status, JSON.stringify(body)); assert.match(r.data.error, re);
    assert.deepEqual(writes(), []);
  }
  for (const [st, re] of [['DRAFT', /editing/], ['CHANGES_REQUESTED', /editing/], ['UNDER_REVIEW', /cannot be mapped/], ['REJECTED', /cannot be mapped/]]) {
    mq.question_status = st; log.length = 0;
    const r = await call('POST', `${A}/questions/${QM}/syllabus-mapping`, mapBody(), 'hod');
    assert.equal(r.status, 409, st); assert.match(r.data.error, re); assert.deepEqual(writes(), [], st);
  }
  mq.question_status = 'ACTIVE';
  sql(/^SELECT 1 AS x FROM review_batch_items rbi/i, [{ x: 1 }]);
  assert.equal((await call('POST', `${A}/questions/${QM}/syllabus-mapping`, mapBody(), 'hod')).status, 409, 'open review round');
  sql(/^SELECT 1 AS x FROM review_batch_items rbi/i, []);
  sql(/^SELECT 1 AS x FROM questions WHERE canonical_question_id = \$1 AND id <> \$2/i, [{ x: 1 }]);
  assert.equal((await call('POST', `${A}/questions/${QM}/syllabus-mapping`, mapBody(), 'hod')).status, 409, 'shared canonical');
  sql(/^SELECT 1 AS x FROM questions WHERE canonical_question_id = \$1 AND id <> \$2/i, []);
  sql(/FROM canonical_questions WHERE id = \$1 FOR UPDATE/i, [{ verified_bloom_level: null }]);
  const nb = await call('POST', `${A}/questions/${QM}/syllabus-mapping`, mapBody(), 'hod');
  assert.equal(nb.status, 400); assert.match(nb.data.error, /Bloom/);
  assert.equal((await call('POST', `${A}/questions/9a430000-0000-0000-0000-0000000000ff/syllabus-mapping`, mapBody(), 'hod')).status, 404);
});

test('mapping: another department\'s or campus\'s HOD, teachers, reviewers and admin are refused (403) and nothing is written', async () => {
  scriptMapping();
  for (const who of ['hodA2', 'hodB', 'teacher', 'reviewer', 'admin', 'coe']) {
    log.length = 0;
    const r = await call('POST', `${A}/questions/${QM}/syllabus-mapping`, mapBody(), who);
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.data)}`);
    assert.deepEqual(writes(), [], who);
    assert.equal(log.some((l) => /FROM syllabus_topics t JOIN syllabus_units u/.test(l.text)), false, `${who}: nothing about the syllabus is read`);
    if (who === 'hodA2') {
      assert.ok(log.some((l) => /INSERT INTO authorization_log/.test(l.text) && l.params[1] === 'manage_academic_context' && l.params[4] === 'deny'), 'the denial is logged');
    }
  }
});

// ---- syllabus trees (the question form's selects) ----
test('syllabus tree: the offering\'s ACTIVE version for its HOD, teachers and reviewers; others 403', async () => {
  scriptTree(IDS.sv, { units: [{ id: UNIT, code: 'U1', title: 'Trees', topics: [{ id: TOPIC, title: 'AVL', subtopics: [{ id: SUB, title: 'Rotations' }] }] }], cos: [{ id: CO, code: 'CO1', description: 'x' }] });
  sql(/^SELECT id, version_number, status FROM syllabus_versions WHERE id = \$1/i, [{ id: IDS.sv, version_number: 1, status: 'ACTIVE' }]);
  for (const who of ['hod', 'teacher', 'reviewer']) {
    const r = await call('GET', `${A}/course-offerings/${IDS.off}/syllabus-tree`, null, who);
    assert.equal(r.status, 200, who);
    assert.equal(r.data.units[0].topics[0].subtopics[0].id, SUB); assert.equal(r.data.course_outcomes[0].code, 'CO1');
  }
  for (const who of ['teacherA2', 'hodB', 'admin', 'coe']) assert.equal((await call('GET', `${A}/course-offerings/${IDS.off}/syllabus-tree`, null, who)).status, 403, who);
  const v = await call('GET', `${A}/syllabus-versions/${IDS.sv}/tree`, null, 'reviewer');
  assert.equal(v.status, 200); assert.equal(v.data.status, 'ACTIVE');
});

// ---- topic / subtopic placement of drafts ----
const QD = '9a440000-0000-0000-0000-000000000001';
let existing;
function scriptDraft() {
  existing = null;
  sql(/FROM teacher_course_assignments tca/i, [{ course_offering_id: IDS.off, section_id: null, subject_id: IDS.subj }]);
  sql(/^INSERT INTO questions/i, [{ id: QD }]);
  sql(/SELECT \* FROM questions WHERE id = \$1$/i, () => (existing ? [existing] : []));
  sql(/UPDATE questions SET question_type=\$1/i, () => [{ id: QD, question_status: existing?.question_status || 'DRAFT' }]);
  sql(/^INSERT INTO question_syllabus_remaps/i, []);
}
const draft = { question_type: 'short_answer', question_text: 'Explain AVL rotations', difficulty: 'easy', marks: 2, course_offering_id: IDS.off, model_answer: 'A long enough answer' };

test('draft: topic and subtopic must belong to the offering\'s current syllabus; ids from the selects are stored', async () => {
  baseRules(); scriptDraft();
  let r = await call('POST', '/questions/draft', { ...draft, topic: 'Quantum' }, 'teacher');
  assert.equal(r.status, 400); assert.match(r.data.details[0], /not part of the current syllabus/);
  r = await call('POST', '/questions/draft', { ...draft, topic: 'Trees', subtopic: 'Hashing' }, 'teacher');
  assert.equal(r.status, 400); assert.match(r.data.details[0], /not under topic 'Trees'/);
  r = await call('POST', '/questions/draft', { ...draft, subtopic: 'Rotations' }, 'teacher');
  assert.equal(r.status, 400); assert.match(r.data.details[0], /topic before the subtopic/);
  r = await call('POST', '/questions/draft', { ...draft, syllabus_topic_id: '22220000-0000-0000-0000-000000000099' }, 'teacher');
  assert.equal(r.status, 400, 'a topic id from another syllabus');
  r = await call('POST', '/questions/draft', { ...draft, syllabus_topic_id: 'nope' }, 'teacher');
  assert.equal(r.status, 400, 'malformed id');
  assert.equal(log.some((l) => /^INSERT INTO questions/.test(l.text)), false);
  r = await call('POST', '/questions/draft', { ...draft, syllabus_topic_id: PLACEMENT.topic, subtopic_id: PLACEMENT.subtopic, topic: 'ignored' }, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ins = log.find((l) => /^INSERT INTO questions/.test(l.text));
  assert.deepEqual([ins.params[14], ins.params[19], ins.params[20], ins.params[21]], ['Trees', 'Rotations', IDS.sv, PLACEMENT.subtopic]);
  r = await call('POST', '/questions/draft', { ...draft, topic: ' trees ', subtopic: 'ROTATIONS' }, 'teacher');
  assert.equal(r.status, 200, 'titles match case-insensitively and are stored with the syllabus spelling');
  const ins2 = log.filter((l) => /^INSERT INTO questions/.test(l.text)).pop();
  assert.deepEqual([ins2.params[14], ins2.params[19]], ['Trees', 'Rotations']);
});

test('draft edit: a question left on a superseded version moves to the current one (history row + audit)', async () => {
  baseRules(); scriptDraft();
  existing = { id: QD, submitted_by: USERS.teacher.id, question_status: 'CHANGES_REQUESTED', course_offering_id: IDS.off, section_id: null,
    syllabus_version_id: OLD_SV, topic: 'Heaps', subtopic: null, subtopic_id: null, question_type: 'short_answer', question_text: draft.question_text, difficulty: 'easy', marks: 2 };
  const r = await call('POST', '/questions/draft', { ...draft, id: QD, topic: 'Trees' }, 'teacher');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.syllabus_version_id, IDS.sv);
  const upd = log.find((l) => /^UPDATE questions SET question_type=\$1/.test(l.text));
  assert.deepEqual([upd.params[10], upd.params[18], upd.params[19]], ['Trees', IDS.sv, null]);
  const remap = log.find((l) => /^INSERT INTO question_syllabus_remaps/.test(l.text));
  assert.match(remap.text, /'author_edit'/); assert.deepEqual(remap.params.slice(0, 3), [QD, OLD_SV, IDS.sv]);
  const a = audits('draft_updated')[0];
  assert.deepEqual(a.syllabus_version_moved, { from: OLD_SV, to: IDS.sv });
  // On the current version already: no move, no history row.
  log.length = 0; existing.syllabus_version_id = IDS.sv;
  assert.equal((await call('POST', '/questions/draft', { ...draft, id: QD, topic: 'Trees' }, 'teacher')).status, 200);
  assert.equal(log.some((l) => /^INSERT INTO question_syllabus_remaps/.test(l.text)), false);
});

// ---- generation uses verified mappings only ----
test('generator pool: verified mapping required, verified COs and Bloom only, auto re-mapped questions stay eligible for the old version', async () => {
  const { loadEligiblePool } = await import('../src/exam-generator.js');
  let captured;
  await loadEligiblePool({ id: 'e1', course_offering_id: IDS.off, syllabus_version_id: IDS.sv, subject_id: IDS.subj, campus_id: IDS.campusA, program_id: IDS.prog },
    { all: async (text, params) => { captured = { text: text.replace(/\s+/g, ' '), params }; return []; } });
  assert.match(captured.text, /AND question_has_verified_mapping\(q.id\)/);
  assert.match(captured.text, /cq.verified_bloom_level AS bloom/);
  assert.match(captured.text, /qco.verified_by IS NOT NULL AND oc.syllabus_version_id = q.syllabus_version_id/);
  assert.match(captured.text, /q.syllabus_version_id = \$2 OR EXISTS \(SELECT 1 FROM question_syllabus_remaps r WHERE r.question_id = q.id AND r.from_version_id = \$2 AND r.kind = 'auto_unchanged'\)/);
  assert.match(captured.text, /\$2::uuid AS syllabus_version_id, q.syllabus_version_id AS mapped_syllabus_version_id/);
  assert.doesNotMatch(captured.text, /COALESCE\(cq.verified_bloom_level, q.bloom_level/);
  assert.equal(captured.params[1], IDS.sv);
});
