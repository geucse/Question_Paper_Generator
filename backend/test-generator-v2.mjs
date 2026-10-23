// Sections, exact CO/Bloom targets, feasibility and overrides (no database): node --test test-generator-v2.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectQuestions, validateSelection, GenerationError, bloomTargetCounts, blueprintConfigErrors, normalizeOverride, planSelection, explainFeasibility,
  normalizeCoDistribution, blueprintContextErrors, blueprintTargetNotes, legacyTargetError, checkSections, normalizeSections,
} from './src/exam-generator.js';

const exam = { campus_id: 'c', program_id: 'p', subject_id: 's', course_offering_id: 'o', syllabus_version_id: 'v' };
let n = 0;
const mk = (o) => ({ id: `q${++n}`, canonical_question_id: `cq${n}`, question_text: `Question ${n} text`, question_type: 'descriptive',
  difficulty: 'easy', marks: 2, topic: `T${n % 5}`, model_answer: 'an answer', bloom: 'apply', cos: ['CO1'], question_status: 'ACTIVE',
  campus_id: 'c', program_id: 'p', subject_id: 's', course_offering_id: 'o', syllabus_version_id: 'v', times_used: 0, ...o });
const mcq = (o) => mk({ question_type: 'mcq', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'b', marks: 1, ...o });

function bank() {
  const p = [];
  for (let i = 0; i < 12; i++) p.push(mcq({ difficulty: i % 4 === 0 ? 'medium' : 'easy', bloom: ['remember', 'understand', 'apply'][i % 3], cos: [`CO${(i % 3) + 1}`] }));
  for (let i = 0; i < 10; i++) p.push(mk({ question_type: i % 2 ? 'long_answer' : 'numerical', answer_data: { expected_value: 3 }, difficulty: i % 2 ? 'hard' : 'medium', marks: 5, bloom: ['apply', 'analyze'][i % 2], cos: [`CO${(i % 3) + 1}`] }));
  return p;
}
const sectioned = {
  easy_count: 4, medium_count: 3, hard_count: 1, total_marks: 20, hard_targets: true,
  sections: [
    { name: 'Section A', question_count: 5, marks_per_question: 1, question_types: ['mcq'] },
    { name: 'Section B', question_count: 3, marks_per_question: 5, question_types: ['numerical', 'long_answer'] },
  ],
  co_distribution: { CO1: 3, CO2: 3 },
  bloom_distribution: { remember: 25, understand: 12.5, apply: 50, analyze: 12.5 },
};

test('sections: counts, types and marks are enforced; numbering runs across sections', () => {
  const r = selectQuestions(bank(), sectioned, 'seed');
  const a = r.questions.filter((q) => q.section_name === 'Section A'); const b = r.questions.filter((q) => q.section_name === 'Section B');
  assert.equal(a.length, 5); assert.equal(b.length, 3);
  assert.ok(a.every((q) => q.question_type === 'mcq' && q.marks === 1));
  assert.ok(b.every((q) => ['numerical', 'long_answer'].includes(q.question_type) && q.marks === 5));
  assert.deepEqual(r.questions.map((q) => q.slot_number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(r.questions.slice(0, 5).every((q) => q.section_name === 'Section A'), 'section A first');
  const v = validateSelection(r.questions, sectioned, exam);
  assert.equal(v.passed, true, v.errors.join('; '));
});

test('hard CO and Bloom targets are met exactly', () => {
  for (const seed of ['a', 'b', 'c', 'd']) {
    const r = selectQuestions(bank(), sectioned, seed);
    const co = {}; const bl = {};
    r.questions.forEach((q) => { q.cos.forEach((c) => { co[c] = (co[c] || 0) + 1; }); bl[q.bloom] = (bl[q.bloom] || 0) + 1; });
    assert.equal(co.CO1, 3); assert.equal(co.CO2, 3);
    assert.deepEqual(bl, { remember: 2, understand: 1, apply: 4, analyze: 1 });
  }
});

test('same seed => same paper', () => {
  const p = bank();
  assert.deepEqual(selectQuestions(p, sectioned, 'x').questions.map((q) => q.id), selectQuestions(p, sectioned, 'x').questions.map((q) => q.id));
});

test('insufficient inventory fails before search with an actionable reason', () => {
  const bp = { ...sectioned, co_distribution: { CO1: 3, CO4: 1 } };
  assert.throws(() => selectQuestions(bank(), bp, 's'), (e) => e instanceof GenerationError && e.reasons.some((r) => /CO4=1 but only 0/.test(r)));
  const types = { ...sectioned, sections: [{ ...sectioned.sections[0], question_types: ['true_false'] }, sectioned.sections[1]] };
  assert.throws(() => selectQuestions(bank(), types, 's'), (e) => e.reasons.some((r) => /Section A: needs 5 question\(s\) \(type true_false/.test(r)));
});

test('jointly infeasible targets fail after a complete search, never a partial paper', () => {
  // Enough CO1 and enough "remember" questions separately, but not CO1 AND remember together.
  // CO1 has 8 questions and every Bloom level has enough on its own, but CO1 MCQs are all "remember"
  // (only 2 allowed) and section B holds 3 questions, so at most 5 CO1 questions fit: 6 is impossible.
  const bp = { ...sectioned, co_distribution: { CO1: 6 } };
  assert.throws(() => selectQuestions(bank(), bp, 's'), (e) => e instanceof GenerationError && /satisfies all hard constraints/.test(e.reasons[0]) && /Every combination was checked/.test(e.reasons[0]));
});

test('override relaxes only the named targets, needs a reason, and is reported to validators', () => {
  const bp = { ...sectioned, co_distribution: { CO1: 6 } };
  assert.throws(() => normalizeOverride({ relax: ['co'], reason: 'short' }), (e) => /10 characters/.test(e.reasons[0]));
  assert.throws(() => selectQuestions(bank(), bp, 's'), GenerationError, 'without the override it fails');
  const ov = normalizeOverride({ relax: ['co', 'bloom', 'difficulty'], reason: 'Bank still being built for this new course' });
  assert.deepEqual(ov.relax, ['co', 'bloom'], 'difficulty, sections and marks can never be relaxed');
  const r = selectQuestions(bank(), bp, 's', new Set(), { override: ov });
  const v = validateSelection(r.questions, bp, exam, { override: ov });
  assert.equal(v.passed, true, v.errors.join('; '));
  assert.ok(v.warnings.some((w) => /COE override/.test(w)));
  assert.ok(v.warnings.some((w) => /CO1: target 6/.test(w)), 'the miss is still reported');
  // Relaxing CO only keeps Bloom exact.
  const coOnly = normalizeOverride({ relax: ['co'], reason: 'Bank still being built for this new course' });
  const r2 = selectQuestions(bank(), bp, 's', new Set(), { override: coOnly });
  const bl = {}; r2.questions.forEach((q) => { bl[q.bloom] = (bl[q.bloom] || 0) + 1; });
  assert.deepEqual(bl, { remember: 2, understand: 1, apply: 4, analyze: 1 });
});

test('legacy (soft-target) blueprints with targets are refused, never softened; without targets they still generate', () => {
  const bp = { ...sectioned, hard_targets: false, version_number: 2, co_distribution: { CO1: 8 } };
  assert.throws(() => selectQuestions(bank(), bp, 's'), (e) => e instanceof GenerationError && e.code === 'LEGACY_BLUEPRINT' && /v2 .*Copy into editor/.test(e.reasons[0]));
  assert.match(legacyTargetError(bp), /legacy soft targets/);
  const plain = { ...sectioned, hard_targets: false, co_distribution: null, bloom_distribution: null };
  assert.equal(legacyTargetError(plain), null);
  const r = selectQuestions(bank(), plain, 's');
  assert.equal(validateSelection(r.questions, plain, exam).passed, true);
});

test('Bloom percentages become exact counts (largest remainder, sums to n)', () => {
  assert.deepEqual(bloomTargetCounts({ apply: 50, analyze: 50 }, 5).targets.apply + bloomTargetCounts({ apply: 50, analyze: 50 }, 5).targets.analyze, 5);
  const t = bloomTargetCounts({ remember: 33.3, understand: 33.3, apply: 33.4 }, 10).targets;
  assert.equal(t.remember + t.understand + t.apply, 10); assert.equal(t.create, 0);
  assert.equal(bloomTargetCounts({ apply: 50 }, 6).complete, false, 'partial percentages leave other levels free');
});

test('blueprint configuration errors are caught before anything else', () => {
  const errs = blueprintConfigErrors({ ...sectioned, sections: [{ name: 'A', question_count: 5, marks_per_question: 1, total_marks: 6, easy: 1, medium: 1, hard: 1 }, { name: 'a', question_count: 2 }] });
  assert.ok(errs.some((e) => /Duplicate section/.test(e)));
  assert.ok(errs.some((e) => /must equal question_count/.test(e)));
  assert.ok(errs.some((e) => /≠ section total/.test(e)));
  assert.ok(errs.some((e) => /Sections hold 7/.test(e)));
  assert.ok(blueprintConfigErrors({ easy_count: 2, bloom_distribution: { apply: 80, analyze: 40 } }).some((e) => /more than 100/.test(e)));
});

test('search stays fast on a large bank', () => {
  const p = [];
  // Every combination present, so the targets below are satisfiable (independent attributes).
  for (let rep = 0; rep < 6; rep++) for (const d of ['easy', 'medium']) for (const b of ['remember', 'understand', 'apply']) for (let c = 1; c <= 5; c++) p.push(mcq({ difficulty: d, bloom: b, cos: [`CO${c}`] }));
  for (let rep = 0; rep < 3; rep++) for (const d of ['medium', 'hard']) for (const b of ['analyze', 'evaluate', 'apply']) for (let c = 1; c <= 5; c++) for (const m of [5, 10]) p.push(mk({ question_type: 'long_answer', marks: m, difficulty: d, bloom: b, cos: [`CO${c}`, `CO${((c + 1) % 5) + 1}`] }));
  const bp = { easy_count: 10, medium_count: 8, hard_count: 2, total_marks: 60, hard_targets: true,
    sections: [{ name: 'A', question_count: 10, marks_per_question: 1, question_types: ['mcq'] }, { name: 'B', question_count: 10, question_types: ['long_answer'], total_marks: 50 }],
    co_distribution: { CO1: 4, CO2: 4, CO3: 4 }, bloom_distribution: { remember: 20, understand: 15, apply: 25, analyze: 25, evaluate: 15 } };
  const t0 = Date.now();
  const r = selectQuestions(p, bp, 'big');
  assert.equal(validateSelection(r.questions, bp, exam).passed, true);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

// ---- phase 2: targets, overrides, config integrity ----
test('partial Bloom percentages resolve by largest remainder and never exceed n', () => {
  const sum = (t) => Object.values(t).reduce((a, b) => a + b, 0);
  assert.ok(sum(bloomTargetCounts({ remember: 25, understand: 25, apply: 25, analyze: 24 }, 2).targets) <= 2, 'was 3 with per-level rounding');
  assert.equal(sum(bloomTargetCounts({ apply: 30, analyze: 30 }, 5).targets), 3);
  assert.equal(bloomTargetCounts({ apply: 50 }, 5).targets.apply, 3);
  const full = bloomTargetCounts({ remember: 25, understand: 12.5, apply: 50, analyze: 12.5 }, 8);
  assert.deepEqual(full.targets, { remember: 2, understand: 1, apply: 4, analyze: 1, evaluate: 0, create: 0 }); assert.equal(full.complete, true);
  assert.deepEqual(blueprintTargetNotes({ easy_count: 6, bloom_distribution: { apply: 90, create: 5 } }), ['Bloom create 5% of 6 question(s) resolves to 0 questions']);
});

test('blueprint configuration: sections, marks and Bloom integrity are checked at save', () => {
  const base = { easy_count: 4, medium_count: 3, hard_count: 1, total_marks: 20 };
  const errs = (sections, extra = {}) => blueprintConfigErrors({ ...base, sections, ...extra }).join(' | ');
  assert.match(errs([{ name: 'A', question_count: 5, easy: -1, medium: 6, hard: 0 }, { name: 'B', question_count: 3 }]), /non-negative whole numbers/);
  assert.match(errs([{ name: 'A', question_count: 5, easy: 2, medium: 1, hard: 2 }, { name: 'B', question_count: 3 }]), /Sections fix 2 hard question\(s\) but the blueprint asks for only 1/);
  assert.match(errs([{ name: 'A', question_count: 5, marks_per_question: 4 }, { name: 'B', question_count: 3 }]), /fix 20 mark\(s\) and the other 3 question\(s\) need at least 1 mark each/);
  assert.match(errs([{ name: 'A', question_count: 5, total_marks: 4 }, { name: 'B', question_count: 3, total_marks: 16 }]), /4 marks cannot hold 5 questions/);
  assert.match(errs([{ name: 'A', question_count: 5, marks_per_question: 1.5 }, { name: 'B', question_count: 3 }]), /marks_per_question must be a positive whole number/);
  assert.match(errs(null, { bloom_distribution: { apply: 120 } }), /percentage from 0 to 100/);
  assert.match(errs(null, { bloom_distribution: { Apply: 20, apply: 20 } }), /listed twice/);
  assert.match(errs([{ name: 'A'.repeat(61), question_count: 8 }]), /at most 60 characters/);
  assert.deepEqual(blueprintConfigErrors({ ...base, sections: [{ name: 'A', question_count: 5, marks_per_question: 1 }, { name: 'B', question_count: 3, total_marks: 15 }] }), []);
});

test('CO targets name active course outcomes of the syllabus version (case-insensitive, canonical code stored)', () => {
  assert.deepEqual(normalizeCoDistribution({ co1: 2, CO2: 1 }, ['CO1', 'CO2']), { value: { CO1: 2, CO2: 1 }, errors: [] });
  assert.match(normalizeCoDistribution({ CO9: 1 }, ['CO1', 'CO2']).errors[0], /CO9 is not an active course outcome .*\(active: CO1, CO2\)/);
  assert.match(normalizeCoDistribution({ CO1: 1, co1: 2 }, ['CO1']).errors[0], /"CO1" and "co1" name the same course outcome CO1/);
  assert.match(normalizeCoDistribution({ CO1: 1 }, []).errors[0], /active: none/);
  assert.deepEqual(normalizeCoDistribution(null, ['CO1']), { value: null, errors: [] });
  assert.match(blueprintContextErrors({ co_distribution: { CO3: 1 } }, ['CO1'])[0], /CO3 is not an active course outcome.*new blueprint version/);
  assert.deepEqual(blueprintContextErrors({ co_distribution: { CO1: 1 } }, ['CO1']), []);
});

test('planSelection: an override is accepted only when strict generation fails, the dimension has targets, and it is minimal', () => {
  const ov = (relax) => normalizeOverride({ relax, reason: 'Bank still being built for this new course' });
  assert.throws(() => planSelection(bank(), sectioned, 's', new Set(), ov(['co'])), (e) => e.code === 'OVERRIDE_NOT_NEEDED');
  const tight = { ...sectioned, co_distribution: { CO1: 6 } };
  assert.throws(() => planSelection(bank(), tight, 's', new Set(), ov(['co', 'bloom'])), (e) => e.code === 'OVERRIDE_NOT_MINIMAL' && /only the CO targets is enough/.test(e.reasons[0]));
  const plan = planSelection(bank(), tight, 's', new Set(), ov(['co']));
  assert.deepEqual(plan.override.relax, ['co']); assert.equal(plan.override.strict_failure.code, 'INFEASIBLE'); assert.equal(plan.override.strict_failure.proven, true);
  assert.equal(validateSelection(plan.questions, tight, exam, { override: plan.override }).passed, true);
  assert.throws(() => planSelection(bank(), { ...tight, bloom_distribution: null }, 's', new Set(), ov(['bloom'])), (e) => e.code === 'OVERRIDE_INVALID');
  assert.throws(() => planSelection(bank(), { ...tight, total_marks: 21 }, 's', new Set(), ov(['co'])), (e) => e.code === 'CONFIG', 'configuration errors are never relaxable');
  assert.equal(planSelection(bank(), sectioned, 's').override, null);
});

test('explainFeasibility: strict verdict, achieved counts, and the overrides that would work', () => {
  const ok = explainFeasibility(bank(), sectioned, 's', new Set(), exam);
  assert.equal(ok.feasible, true); assert.deepEqual([ok.achieved.co.CO1, ok.achieved.co.CO2], [3, 3]); assert.equal(ok.achieved.total_marks, 20);
  assert.deepEqual(ok.override_options, []);
  const tight = explainFeasibility(bank(), { ...sectioned, co_distribution: { CO1: 6 } }, 's', new Set(), exam);
  assert.equal(tight.feasible, false); assert.equal(tight.code, 'INFEASIBLE');
  assert.ok(tight.override_options.some((o) => o.relax.join() === 'co' && o.feasible), JSON.stringify(tight.override_options));
  assert.ok(tight.override_options.every((o) => o.relax.length === 1), 'both dimensions are offered only when neither alone is enough');
  const withOv = explainFeasibility(bank(), { ...sectioned, co_distribution: { CO1: 6 } }, 's', new Set(), exam, normalizeOverride({ relax: ['co'], reason: 'Bank still being built' }));
  assert.equal(withOv.feasible, true); assert.equal(withOv.override.accepted, true);
});

// ---- phase 2: sections in generation and output ----
const noTargets = { ...sectioned, co_distribution: null, bloom_distribution: null };
test('per-section difficulty split is met exactly', () => {
  const bp = { ...noTargets, easy_count: 4, medium_count: 3, hard_count: 1, sections: [
    { name: 'Section A', question_count: 5, marks_per_question: 1, question_types: ['mcq'], easy: 4, medium: 1, hard: 0 },
    { name: 'Section B', question_count: 3, marks_per_question: 5, question_types: ['numerical', 'long_answer'], easy: 0, medium: 2, hard: 1 }] };
  for (const seed of ['a', 'b', 'c']) {
    const r = selectQuestions(bank(), bp, seed);
    const split = (name) => ['easy', 'medium', 'hard'].map((d) => r.questions.filter((q) => q.section_name === name && q.difficulty === d).length);
    assert.deepEqual(split('Section A'), [4, 1, 0]); assert.deepEqual(split('Section B'), [0, 2, 1]);
    const v = validateSelection(r.questions, bp, exam);
    assert.equal(v.passed, true, v.errors.join('; ')); assert.ok(v.summary.sections.every((x) => x.passed));
  }
});
test('per-section split that the bank cannot fill -> named reason', () => {
  const bp = { ...noTargets, easy_count: 1, medium_count: 4, hard_count: 3, sections: [
    { name: 'Section A', question_count: 5, marks_per_question: 1, question_types: ['mcq'], easy: 1, medium: 4, hard: 0 },
    { name: 'Section B', question_count: 3, marks_per_question: 5, question_types: ['long_answer'], easy: 0, medium: 0, hard: 3 }] };
  assert.throws(() => selectQuestions(bank(), bp, 's'), (e) => e.code === 'INVENTORY' && e.reasons.some((r) => /Section A: needs 4 medium question\(s\) \(type mcq, 1 marks\) but only 3 eligible/.test(r)));
});
test('sections competing for the same questions -> named reason, not a generic search failure', () => {
  const p = [...Array(4)].map(() => mk({ question_type: 'long_answer', difficulty: 'hard', marks: 5 }))
    .concat([...Array(4)].map(() => mcq({ difficulty: 'hard' })), [...Array(4)].map(() => mcq({ difficulty: 'easy' })));
  const bp = { easy_count: 3, medium_count: 0, hard_count: 5, sections: [
    { name: 'Section X', question_count: 3, question_types: ['long_answer'] }, { name: 'Section Y', question_count: 2, question_types: ['long_answer'] },
    { name: 'Section Z', question_count: 3, question_types: ['mcq'] }] };
  assert.throws(() => selectQuestions(p, bp, 's'), (e) => e.reasons.some((r) => /Section X \+ Section Y: need 5 different question\(s\) together but only 4/.test(r))
    && !e.reasons.some((r) => /satisfies all hard constraints/.test(r)) && e.reasons.length === 1);
});
test('a section total (no marks each) that no combination reaches -> named reason', () => {
  const bp = { ...noTargets, total_marks: 19, sections: [sectioned.sections[0], { name: 'Section B', question_count: 3, question_types: ['numerical', 'long_answer'], total_marks: 14 }] };
  assert.throws(() => selectQuestions(bank(), bp, 's'), (e) => e.reasons.some((r) => /Section B: no 3 eligible question\(s\).*add up to the section total of 14 marks/.test(r)));
});
test('internal choice: attempt any k of n prints n questions and counts k', () => {
  const bp = { ...noTargets, easy_count: 5, medium_count: 2, hard_count: 2, total_marks: 20, sections: [
    sectioned.sections[0], { name: 'Section B', question_count: 4, marks_per_question: 5, question_types: ['numerical', 'long_answer'], attempt_count: 3 }] };
  const r = selectQuestions(bank(), bp, 'choice');
  assert.equal(r.questions.filter((q) => q.section_name === 'Section B').length, 4);
  const v = validateSelection(r.questions, bp, exam);
  assert.equal(v.passed, true, v.errors.join('; ')); assert.equal(v.summary.total_marks, 20); assert.equal(v.summary.printed_marks, 25);
  assert.deepEqual(v.summary.internal_choices, [{ section: 'Section B', attempt_count: 3, of: 4, marks_counted: 15, passed: true }]);
  const cfg = (b) => blueprintConfigErrors({ ...bp, sections: [bp.sections[0], { ...bp.sections[1], ...b }] }).join(' | ');
  assert.match(cfg({ attempt_count: 4 }), /must be fewer than/);
  assert.match(cfg({ marks_per_question: undefined, total_marks: 15 }), /needs marks_per_question/);
  assert.match(cfg({ total_marks: 20 }), /attempt any 3 × 5 marks ≠ section total 20/);
  assert.match(cfg({ attempt_count: 0 }), /positive whole number/); assert.match(cfg({ attempt_count: 1.5 }), /positive whole number/);
  // The frozen rules re-checked on a tampered snapshot (paper-sections.js uses this on every read).
  const rules = normalizeSections(bp);
  const tampered = r.questions.filter((q) => q.section_name === 'Section B').slice(0, 3).map((q, i) => ({ ...q, marks: i ? q.marks : 4 }));
  const [, b] = checkSections(rules, tampered);
  assert.equal(b.passed, false); assert.ok(b.errors.some((x) => /expected 4 question/.test(x)) && b.errors.some((x) => /has 4 marks, section requires 5/.test(x)));
});
test('no internal choice -> internal_choices is [] (no placeholder)', () => {
  const r = selectQuestions(bank(), sectioned, 's');
  assert.deepEqual(validateSelection(r.questions, sectioned, exam).summary.internal_choices, []);
});
