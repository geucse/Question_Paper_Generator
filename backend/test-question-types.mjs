// The 13 question types (spec §8) and their type-specific rules (spec §10): node --test test-question-types.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QUESTION_TYPES, QUESTION_TYPE_CODES, normalizeQuestionType, validateQuestionByType, answerDataFromRow, mcqCorrectText } from './src/question-types.js';

const SPEC = ['MCQ', 'Short Answer', 'Long Answer', 'Numerical', 'Derivation', 'Proof', 'Programming', 'Case Study', 'Diagram',
  'Assertion-Reason', 'Fill in the Blank', 'True/False', 'Descriptive'];

test('exactly the 13 types listed in PIVOT_SPEC_V2 §8', () => {
  assert.equal(QUESTION_TYPES.length, 13);
  assert.deepEqual(QUESTION_TYPES.map((t) => t.label), SPEC);
  const spec = fs.readFileSync(new URL('../docs/development/PIVOT_SPEC_V2.md', import.meta.url), 'utf8');
  for (const l of SPEC) assert.ok(spec.includes(l), `spec mentions ${l}`);
});

test('migration 037 CHECK constraint lists the same codes (no drift)', () => {
  const sql = fs.readFileSync(new URL('./migrations/037_question_types_sections_reservations.sql', import.meta.url), 'utf8');
  const m = sql.match(/questions_question_type_check CHECK \(question_type IN \(([^)]*)\)\)/);
  assert.ok(m, 'constraint found');
  assert.deepEqual([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort(), [...QUESTION_TYPE_CODES].sort());
});

test('legacy values and labels normalise; unknown types are rejected', () => {
  assert.equal(normalizeQuestionType('objective'), 'mcq');
  assert.equal(normalizeQuestionType('subjective'), 'descriptive');
  assert.equal(normalizeQuestionType('Fill in the Blank'), 'fill_blank');
  assert.equal(normalizeQuestionType('True/False'), 'true_false');
  assert.equal(normalizeQuestionType('Assertion-Reason'), 'assertion_reason');
  assert.equal(normalizeQuestionType('essay'), null);
  assert.match(validateQuestionByType({ question_type: 'essay' })[0], /must be one of/);
});

const ok = {
  mcq: { option_a: 'O(n)', option_b: 'O(log n)', correct_answer: 'O(log n)' },
  short_answer: {}, long_answer: {}, derivation: {}, proof: {}, descriptive: {},
  numerical: { answer_data: { expected_value: 11, tolerance: 0 } },
  programming: { answer_data: { language: 'Python' } },
  case_study: { answer_data: { case_text: 'A retailer has 3 warehouses and ...' } },
  diagram: {},
  assertion_reason: { correct_answer: 'A', answer_data: { assertion: 'Water boils at 100C at sea level', reason: 'Vapour pressure equals 1 atm' } },
  fill_blank: { question_text: 'A stack follows the ___ principle.', answer_data: { answers: ['LIFO'] } },
  true_false: { correct_answer: 'true' },
};

test('every type: a complete draft is valid; a draft missing its type data is not', () => {
  for (const code of QUESTION_TYPE_CODES) {
    const q = { question_type: code, question_text: 'Explain the following clearly', ...ok[code] };
    assert.deepEqual(validateQuestionByType(q), [], `${code} complete`);
  }
  const missing = {
    mcq: { option_a: 'x' }, numerical: { answer_data: { expected_value: 'abc' } }, programming: {}, case_study: { answer_data: { case_text: 'short' } },
    assertion_reason: { correct_answer: 'E', answer_data: { assertion: 'x' } }, fill_blank: { question_text: 'No blank here', answer_data: { answers: ['x'] } },
    true_false: { correct_answer: 'maybe' },
  };
  for (const [code, extra] of Object.entries(missing)) {
    assert.ok(validateQuestionByType({ question_type: code, question_text: 'Explain the following', ...extra }).length > 0, `${code} incomplete`);
  }
  assert.match(validateQuestionByType({ question_type: 'fill_blank', question_text: 'A ___ and a ___', answer_data: { answers: ['x'] } })[0], /2 blank\(s\) but 1 answer/);
});

test('activation needs a model answer for every type, four MCQ options, and a diagram asset', () => {
  for (const code of QUESTION_TYPE_CODES) {
    const q = { question_type: code, question_text: 'A stack follows the ___ principle.', ...ok[code], option_c: 'x', option_d: 'y', attachment_count: 1 };
    assert.ok(validateQuestionByType(q, { forActivation: true }).some((e) => /model answer/.test(e)), `${code} needs model answer to activate`);
    assert.deepEqual(validateQuestionByType({ ...q, model_answer: 'A full worked answer' }, { forActivation: true }), [], `${code} activatable`);
  }
  assert.ok(validateQuestionByType({ question_type: 'mcq', ...ok.mcq, model_answer: 'because' }, { forActivation: true }).some((e) => /all four options/.test(e)));
  assert.ok(validateQuestionByType({ question_type: 'diagram', model_answer: 'labelled parts', attachment_count: 0 }, { forActivation: true }).some((e) => /attached diagram/.test(e)));
});

test('spreadsheet columns become answer_data; MCQ letters resolve to option text', () => {
  assert.deepEqual(answerDataFromRow({ expected_value: '9.81', tolerance: '0.05', unit: 'm/s^2' }), { expected_value: 9.81, tolerance: 0.05, unit: 'm/s^2' });
  assert.deepEqual(answerDataFromRow({ answers: 'LIFO | last in first out' }), { answers: ['LIFO', 'last in first out'] });
  assert.deepEqual(answerDataFromRow({ answer_data: '{"language":"C"}', language: 'Python' }), { language: 'C' }, 'JSON column wins');
  assert.equal(mcqCorrectText({ correct_answer: 'B', option_b: 'O(log n)' }), 'O(log n)');
  assert.equal(mcqCorrectText({ correct_answer: 'O(1)', option_a: 'O(1)' }), 'O(1)');
});
