// Unit tests for canonical versioning (spec §14) with a fake db handle (no database needed):
//   node --test test-canonical.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendCanonicalVersion, createCanonicalQuestion, resolveCourseOutcomeCodes, stableJson } from './src/canonical.js';

function fakeDb({ current = null, answer = null } = {}) {
  const log = [];
  const exec = (text, params) => {
    const t = text.replace(/\s+/g, ' ').trim();
    log.push({ text: t, params });
    if (/FROM canonical_questions WHERE id = \$1 FOR UPDATE/.test(t)) return [{ id: params[0], current_version_id: current ? current.id : null }];
    if (/SELECT \* FROM question_versions WHERE id/.test(t)) return current ? [current] : [];
    if (/MAX\(version_number\)/.test(t)) return [{ n: 3 }];
    if (/INSERT INTO question_versions/.test(t)) return [{ id: 'qv-new' }];
    if (/INSERT INTO canonical_questions/.test(t)) return [{ id: 'cq-new' }];
    if (/SELECT id, answer_text FROM canonical_answers/.test(t)) return answer ? [answer] : [];
    if (/FROM course_outcomes/.test(t)) return [{ id: 'co-1', code: 'co1' }, { id: 'co-3', code: 'co3' }].filter((r) => params[1].includes(r.code));
    return [];
  };
  return {
    log,
    get: async (t, p = []) => exec(t, p)[0] || null,
    all: async (t, p = []) => exec(t, p),
    run: async (t, p = []) => { const rows = exec(t, p); return { rowCount: rows.length, rows }; },
  };
}
const q = (over = {}) => ({ id: 'q1', canonical_question_id: 'cq1', question_text: 'Explain AVL rotations', question_type: 'descriptive', marks: 4,
  option_a: null, option_b: null, option_c: null, option_d: null, correct_answer: null, answer_data: { b: 1, a: 2 }, subtopic: 'Rotations',
  model_answer: 'New model answer', question_hash: 'h', embedding: null, submitted_by: 't1', subject_id: 's1', ...over });
const at = (db, re) => db.log.findIndex((l) => re.test(l.text));

test('stableJson ignores key order and treats {} and NULL alike', () => {
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.equal(stableJson('{"b":1,"a":2}'), stableJson({ a: 2, b: 1 }));
  assert.equal(stableJson({}), stableJson(null));
  assert.notEqual(stableJson({ a: 1 }), stableJson({ a: 2 }));
});

test('a changed resubmission appends a version: lock -> next number -> unset current -> insert -> point canonical at it', async () => {
  const db = fakeDb({ current: { id: 'qv1', version_number: 2, question_text: 'Old wording', question_type: 'descriptive', marks: 4 } });
  const r = await appendCanonicalVersion(q(), { actorId: 't1', changeReason: 'Revision' }, db);
  assert.deepEqual(r, { canonicalQuestionId: 'cq1', versionNumber: 3, versionUnchanged: false, answerVersioned: true });
  const order = [/FOR UPDATE/, /MAX\(version_number\), 0\) \+ 1 AS n FROM question_versions/, /UPDATE question_versions SET is_current = FALSE/,
    /INSERT INTO question_versions/, /UPDATE canonical_questions SET current_version_id/].map((re) => at(db, re));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), JSON.stringify(order));
  const ins = db.log.find((l) => /INSERT INTO question_versions/.test(l.text));
  assert.equal(ins.params[1], 3); assert.equal(ins.params[10], '{"b":1,"a":2}'); assert.equal(ins.params[11], 'Rotations');
});

test('identical content adds no version', async () => {
  const db = fakeDb({ current: { id: 'qv1', version_number: 2, question_text: 'Explain AVL rotations', question_type: 'descriptive', marks: 4,
    answer_data: { a: 2, b: 1 }, subtopic: 'Rotations' }, answer: { id: 'a1', answer_text: 'New model answer' } });
  const r = await appendCanonicalVersion(q(), { actorId: 't1', changeReason: 'x' }, db);
  assert.equal(r.versionUnchanged, true); assert.equal(r.versionNumber, 2); assert.equal(r.answerVersioned, false);
  assert.equal(at(db, /INSERT INTO question_versions/), -1);
  assert.equal(at(db, /canonical_answers SET is_current = FALSE/), -1);
});

test('a changed answer supersedes the current one; a removed answer is superseded without a replacement', async () => {
  const cur = { id: 'qv1', version_number: 1, question_text: 'Explain AVL rotations', question_type: 'descriptive', marks: 4, answer_data: { a: 2, b: 1 }, subtopic: 'Rotations' };
  let db = fakeDb({ current: cur, answer: { id: 'a1', answer_text: 'Old answer' } });
  await appendCanonicalVersion(q(), { actorId: 't1', changeReason: 'x' }, db);
  assert.ok(db.log.some((l) => /UPDATE canonical_answers SET is_current = FALSE, status = 'superseded'/.test(l.text) && l.params[0] === 'a1'));
  assert.ok(db.log.some((l) => /INSERT INTO canonical_answers/.test(l.text) && l.params[2] === 'New model answer'));
  db = fakeDb({ current: cur, answer: { id: 'a1', answer_text: 'Old answer' } });
  await appendCanonicalVersion(q({ model_answer: '' }), { actorId: 't1', changeReason: 'x' }, db);
  assert.ok(db.log.some((l) => /status = 'superseded'/.test(l.text)));
  assert.equal(at(db, /INSERT INTO canonical_answers/), -1);
});

test('version 1 of a new canonical question carries answer_data and subtopic', async () => {
  const db = fakeDb();
  await createCanonicalQuestion(q({ canonical_question_id: null }), db);
  const ins = db.log.find((l) => /INSERT INTO question_versions/.test(l.text));
  assert.match(ins.text, /answer_data, subtopic/);
  assert.equal(ins.params[9], '{"b":1,"a":2}'); assert.equal(ins.params[10], 'Rotations');
});

test('CO codes resolve against one syllabus version: first = primary, unknown codes reported', async () => {
  const db = fakeDb();
  const r = await resolveCourseOutcomeCodes('sv1', ['CO3', 'co1', 'CO1', 'CO9'], db);
  assert.deepEqual(r, { primaryId: 'co-3', secondaryIds: ['co-1'], missing: ['CO9'] });
  assert.deepEqual(await resolveCourseOutcomeCodes(null, ['CO1'], db), { primaryId: null, secondaryIds: [], missing: ['CO1'] });
});
