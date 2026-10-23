// Pure-logic tests for the generator (no database needed): node --test test-generator.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectQuestions, validateSelection, GenerationError } from './src/exam-generator.js';

const exam = { campus_id: 'c', program_id: 'p', subject_id: 's', course_offering_id: 'o', syllabus_version_id: 'v', maximum_marks: 18 };
let n = 0;
const mk = (difficulty, marks, extra = {}) => ({
  id: `q${++n}`, canonical_question_id: `cq${n}`, question_text: `Question text number ${n}`, question_type: 'subjective',
  difficulty, marks, topic: `T${n % 4}`, model_answer: 'answer', bloom: 'apply', cos: [`CO${(n % 3) + 1}`],
  question_status: 'ACTIVE', campus_id: 'c', program_id: 'p', subject_id: 's', course_offering_id: 'o', syllabus_version_id: 'v', times_used: 0, ...extra,
});
const pool = () => [...Array(8)].map(() => mk('easy', 2)).concat([...Array(8)].map(() => mk('medium', 4)), [...Array(6)].map(() => mk('hard', 6)));
const bp = { easy_count: 2, medium_count: 2, hard_count: 1, total_marks: 18 };

test('same seed => same paper (reproducible)', () => {
  const p = pool();
  const a = selectQuestions(p, bp, 'seed-1').questions.map((q) => q.id);
  const b = selectQuestions(p, bp, 'seed-1').questions.map((q) => q.id);
  assert.deepEqual(a, b);
});
test('hits exact total marks (18) and passes validation', () => {
  const r = selectQuestions(pool(), bp, 'x');
  const v = validateSelection(r.questions, bp, exam);
  assert.equal(v.summary.total_marks, 18);
  assert.equal(v.passed, true, v.errors.join('; '));
});
test('fails with clear reason when too few eligible questions', () => {
  const few = pool().filter((q) => q.difficulty !== 'hard');
  assert.throws(() => selectQuestions(few, bp, 's'), (e) => e instanceof GenerationError && /HARD/.test(e.reasons[0]));
});
test('fails (never relaxes) when marks cannot be met', () => {
  assert.throws(() => selectQuestions(pool(), { ...bp, total_marks: 999 }, 's'), (e) => /999 marks/.test(e.reasons[0]));
});
test('validation rejects non-ACTIVE, wrong syllabus, wrong campus', () => {
  const qs = selectQuestions(pool(), bp, 's').questions;
  qs[0].question_status = 'APPROVED'; qs[1].syllabus_version_id = 'other'; qs[2].campus_id = 'zzz';
  const v = validateSelection(qs, bp, exam);
  assert.equal(v.passed, false);
  assert.ok(v.errors.some((e) => /only ACTIVE/.test(e)));
  assert.ok(v.errors.some((e) => /syllabus/.test(e)));
  assert.ok(v.errors.some((e) => /campus/.test(e)));
});
test('never picks two questions with the same canonical id', () => {
  const p = pool().map((q) => ({ ...q, canonical_question_id: q.difficulty + (Number(q.id.slice(1)) % 2) }));
  const r = selectQuestions(p, { easy_count: 2, medium_count: 0, hard_count: 0 }, 's');
  assert.equal(new Set(r.questions.map((q) => q.canonical_question_id)).size, 2);
});
