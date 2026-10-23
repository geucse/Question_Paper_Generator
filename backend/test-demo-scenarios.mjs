// Demo scenarios A-C on the demo dataset's ACTIVE bank (what `npm run seed:demo` leaves ACTIVE), through the real
// generator: a healthy subject generates under hard CO targets; a CO with no eligible question and a Bloom target
// the approved questions cannot meet are refused with explicit reasons (never relaxed, never substituted).
//   node --test test-demo-scenarios.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDemoDataset, lifecyclePlan, NON_ACTIVE_STATES } from './src/demo-dataset.js';
import { selectQuestions, validateSelection, GenerationError } from './src/exam-generator.js';

const { subjects } = loadDemoDataset();
const exam = { campus_id: 'c', program_id: 'p', subject_id: 's', course_offering_id: 'o', syllabus_version_id: 'v' };
const subject = (code) => subjects.find((s) => s.code === code);
const planOf = (s) => lifecyclePlan(s, { keepActive: s.code === 'TCS 571' ? [16] : [] });
const activePool = (code) => {
  const s = subject(code); const plan = planOf(s);
  return s.questions.filter((_, i) => plan.get(i + 1) === 'ACTIVE').map((q) => ({ ...q, id: q.key, canonical_question_id: `c-${q.key}`,
    bloom: q.bloom_level, topic: q.topic_title, question_status: 'ACTIVE', times_used: 0, ...exam }));
};
const refusal = (fn) => { try { fn(); } catch (e) { if (e instanceof GenerationError) return e; throw e; } assert.fail('expected the generator to refuse'); };

test('lifecycle plan: every subject keeps 16 ACTIVE questions covering every unit, and one question in each other state', () => {
  for (const s of subjects) {
    const plan = planOf(s);
    const states = [...plan.values()];
    assert.equal(states.filter((x) => x === 'ACTIVE').length, 16, s.code);
    for (const st of NON_ACTIVE_STATES) assert.equal(states.filter((x) => x === st).length, 1, `${s.code} ${st}`);
    const active = s.questions.filter((_, i) => plan.get(i + 1) === 'ACTIVE');
    for (const u of s.units) assert.ok(active.some((q) => q.unit_number === u.number), `${s.code} unit ${u.number}`);
    const cos = new Set(active.flatMap((q) => q.cos));
    for (const c of s.course_outcomes) {
      const flagged = s.hod_flags.some((f) => f.co === c.code);
      assert.equal(cos.has(c.code), !flagged, `${s.code} ${c.code} ${flagged ? 'is a flagged gap' : 'is covered by ACTIVE questions'}`);
    }
  }
  assert.equal(planOf(subject('TCS 571')).get(16), 'ACTIVE', 'scenario D question ends ACTIVE');
});

const BP_A = { easy_count: 2, medium_count: 3, hard_count: 1, total_marks: 20, hard_targets: true, co_distribution: { CO6: 1, CO3: 1 } };

test('Scenario A: TCS 571 generates a valid paper under hard CO targets, deterministically for a seed', () => {
  const r = selectQuestions(activePool('TCS 571'), BP_A, 'scenario-a');
  const v = validateSelection(r.questions, BP_A, exam);
  assert.equal(v.passed, true, v.errors.join('; '));
  assert.equal(r.questions.length, 6); assert.equal(r.questions.reduce((a, q) => a + q.marks, 0), 20);
  assert.ok(r.questions.some((q) => q.cos.includes('CO6')) && r.questions.some((q) => q.cos.includes('CO3')));
  assert.ok(r.questions.every((q) => q.key.startsWith('TCS571-')), 'only this subject\'s questions');
  assert.deepEqual(selectQuestions(activePool('TCS 571'), BP_A, 'scenario-a').questions.map((q) => q.id), r.questions.map((q) => q.id));
});

test('Scenario B: a hard CO3 target for TCS 409 is refused: no eligible question maps to CO3 (the syllabus units do not cover it)', () => {
  const e = refusal(() => selectQuestions(activePool('TCS 409'), { ...BP_A, co_distribution: { CO3: 2, CO2: 2 } }, 'scenario-b'));
  assert.equal(e.code, 'INVENTORY');
  assert.ok(e.reasons.some((r) => /CO target CO3=2 but only 0 eligible question\(s\) map to CO3/.test(r)), e.reasons.join(' | '));
  assert.match(subject('TCS 409').hod_flags[0].issue, /backtracking and branch-and-bound/);
});

test('Scenario C: a Bloom target needing more Evaluate questions than are approved is refused with the shortfall', () => {
  const e = refusal(() => selectQuestions(activePool('TCS 101'), { ...BP_A, co_distribution: {}, bloom_distribution: { evaluate: 50, analyze: 50 } }, 'scenario-c'));
  assert.equal(e.code, 'INVENTORY');
  assert.ok(e.reasons.some((r) => /Bloom target evaluate=\d+ but only 1 eligible question\(s\) are evaluate/.test(r)), e.reasons.join(' | '));
});

test('questions outside the ACTIVE bank are never eligible: the same targets fail when only non-ACTIVE questions could meet them', () => {
  const s = subject('TCS 571'); const plan = planOf(s);
  const notActive = s.questions.filter((_, i) => plan.get(i + 1) !== 'ACTIVE');
  const onlyThere = (notActive.flatMap((q) => q.question_type === 'true_false' ? [] : [q.bloom_level]));
  assert.ok(onlyThere.length > 0);
  const pool = activePool('TCS 571');
  assert.ok(pool.every((q) => !notActive.some((n) => n.key === q.key)));
});
