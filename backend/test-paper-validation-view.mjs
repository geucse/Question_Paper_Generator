// Pure tests for the validation summary shown to validators and the COE (spec §25):
//   node --test test-paper-validation-view.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { paperValidationView } from './src/paper-validation-view.js';

const report = (summary = {}) => ({ passed: true, errors: [], warnings: ['w1'], summary: { question_count: 4, total_marks: 10, co: {}, bloom: {}, ...summary } });
const q = (section_name, marks, difficulty) => ({ section_name, marks, meta: { difficulty } });

test('a null report (legacy paper) gives no view', () => {
  assert.equal(paperValidationView({ report: null, blueprint: {}, formatConfig: {}, questions: [] }), null);
});

test('CO target vs achieved: missed, met, and achieved without a target', () => {
  const v = paperValidationView({ report: report({ co: { CO1: 1, CO3: 2 } }), blueprint: { co_distribution: { CO1: 2, CO2: 0 } }, formatConfig: null, questions: [] });
  assert.deepEqual(v.co, [
    { key: 'CO1', target: 2, achieved: 1, met: false },
    { key: 'CO2', target: 0, achieved: 0, met: true },
    { key: 'CO3', target: null, achieved: 2, met: null },
  ]);
  assert.deepEqual(v.warnings, ['w1']);
});

test('Bloom 100% targets go through bloomTargetCounts, levels with 0 included', () => {
  const v = paperValidationView({ report: report({ bloom: { apply: 3, analyze: 1 } }), blueprint: { bloom_distribution: { apply: 75, analyze: 25 } }, formatConfig: null, questions: [] });
  const by = Object.fromEntries(v.bloom.map((b) => [b.key, b]));
  assert.equal(by.apply.target, 3); assert.equal(by.apply.met, true);
  assert.equal(by.analyze.target, 1); assert.equal(by.analyze.met, true);
  assert.equal(by.remember.target, 0); assert.equal(by.remember.met, true);
  assert.equal(v.bloom.length, 6);
});

test('snapshotted targets are preferred over the blueprint', () => {
  const v = paperValidationView({ report: report({ co: { CO1: 1 } }), blueprint: { co_distribution: { CO1: 3 } }, formatConfig: null, questions: [], targets: { co: { CO1: 1 } } });
  assert.equal(v.co[0].met, true);
});

test('sections: count, marks and difficulty mismatches are not ok', () => {
  const formatConfig = { sections: [
    { name: 'A', question_count: 2, mpq: 2, total: null, diff: { easy: 2, medium: 0, hard: 0 } },
    { name: 'B', question_count: 2, mpq: null, total: 6, diff: null },
    { name: 'C', question_count: 1, mpq: null, total: null, diff: { easy: 0, medium: 1, hard: 0 } },
  ] };
  const questions = [q('A', 2, 'easy'), q('A', 2, 'easy'), q('B', 4, 'medium'), q('C', 4, 'hard')];
  const v = paperValidationView({ report: report(), blueprint: {}, formatConfig, questions });
  const [a, b, c] = v.sections;
  assert.equal(a.ok, true); assert.equal(a.expected_marks, 4); assert.equal(a.marks, 4);
  assert.equal(b.ok, false, 'one question short and 4 of 6 marks'); assert.equal(b.questions, 1);
  assert.equal(c.ok, false, 'difficulty mismatch'); assert.deepEqual(c.difficulty.medium, { expected: 1, got: 0 });
});

test('legacy format_config without sections gives sections = []', () => {
  assert.deepEqual(paperValidationView({ report: report(), blueprint: {}, formatConfig: { easy: 1 }, questions: [] }).sections, []);
});
