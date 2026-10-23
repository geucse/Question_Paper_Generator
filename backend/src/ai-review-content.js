// What the advisory AI review looks at (routes/ai-review.js), for each of the 13 question types (spec §8, §10).
// Pure: the prompt text and the deterministic fallback checks used when no ANTHROPIC_API_KEY is configured (and
// whenever the model call fails). Only question content goes in; never the author's name, email or id.
import { normalizeQuestionType, parseAnswerData, validateQuestionByType, mcqCorrectText, typeLabel, ASSERTION_REASON_OPTIONS } from './question-types.js';

const t = (v) => (v == null ? '' : String(v).trim());

// The type-specific part of the prompt: everything a reviewer needs to judge the marked answer.
export function typeSpecificBlock(q) {
  const type = normalizeQuestionType(q.question_type);
  const d = parseAnswerData(q.answer_data) || {};
  const model = `Model answer / solution: ${t(q.model_answer) || '(none provided)'}`;
  switch (type) {
    case 'mcq':
      return `Options: A) ${t(q.option_a)} B) ${t(q.option_b)} C) ${t(q.option_c)} D) ${t(q.option_d)}\nMarked correct answer: ${mcqCorrectText(q) || '(none)'}\n${model}`;
    case 'true_false':
      return `Marked correct answer: ${t(q.correct_answer).toUpperCase() || '(none)'}\n${model}`;
    case 'assertion_reason': {
      const key = t(q.correct_answer).toUpperCase();
      return `Assertion (A): ${t(d.assertion)}\nReason (R): ${t(d.reason)}\nStandard choices: ${Object.entries(ASSERTION_REASON_OPTIONS).map(([k, v]) => `(${k}) ${v}`).join(' ')}\nMarked correct choice: ${key ? `(${key}) ${ASSERTION_REASON_OPTIONS[key] || '(not a standard choice)'}` : '(none)'}\n${model}`;
    }
    case 'numerical':
      return `Expected numeric answer: ${d.expected_value ?? '(none)'}${t(d.unit) ? ` ${t(d.unit)}` : ''}${d.tolerance != null && d.tolerance !== '' ? ` (tolerance ± ${d.tolerance})` : ''}\n${model}`;
    case 'fill_blank':
      return `Accepted answers, one per blank (___) in order: ${Array.isArray(d.answers) && d.answers.length ? d.answers.map((a, i) => `${i + 1}) ${a}`).join(' ') : '(none)'}\n${model}`;
    case 'programming':
      return `Language: ${t(d.language) || '(not given)'}${t(d.constraints) ? `\nConstraints: ${t(d.constraints)}` : ''}\nReference solution:\n${t(q.model_answer) || '(none provided)'}`;
    case 'case_study':
      return `Case text (shown to students before the question):\n${t(d.case_text) || '(none)'}\n${model}`;
    case 'diagram':
      return `The question refers to an attached diagram (${Number(q.attachment_count) || 0} file(s) attached; the image itself is not included here).\n${model}`;
    default:
      return model;
  }
}

export function reviewPrompt(q) {
  const type = normalizeQuestionType(q.question_type);
  return `You are reviewing one exam question for quality issues before it enters a question bank.
Question type: ${typeLabel(type)}.
Check for: (1) spelling or grammar errors, (2) ambiguous or unclear phrasing, (3) whether the marked answer, key or
solution below is plausible and consistent with the question for this question type (for example the MCQ key, the
Assertion-Reason choice, the numerical value and unit, every blank's answer, or that the reference solution solves
the programming task).
Respond with ONLY valid JSON, no other text: {"issues": [{"type": "spelling|grammar|clarity|answer_mismatch", "detail": "short explanation"}]}
If there are no issues, return {"issues": []}.

Question: ${t(q.question_text)}
${typeSpecificBlock(q)}`;
}

// Deterministic checks: the type rules the question would fail before it could become ACTIVE (the same shared rules
// as the preview and the quality gate), plus type-specific plausibility checks a model would also flag.
// The shared type rules (what the question still lacks before it could become ACTIVE). Deterministic, so they are
// reported whether or not the model is used.
export const typeRuleIssues = (q) => validateQuestionByType(q, { forActivation: true, requireAssets: q.attachment_count != null })
  .map((detail) => ({ type: 'incomplete', detail }));

export function heuristicReview(q) {
  const issues = [];
  const type = normalizeQuestionType(q.question_type);
  const text = String(q.question_text || '');
  const d = parseAnswerData(q.answer_data) || {};
  if (/\s{2,}/.test(text) && type !== 'programming') issues.push({ type: 'formatting', detail: 'Double spaces found in question text' });
  if (text.trim().length < 15) issues.push({ type: 'clarity', detail: 'Question text seems unusually short' });
  issues.push(...typeRuleIssues(q));
  if (type === 'mcq') {
    const opts = [q.option_a, q.option_b, q.option_c, q.option_d].map(t).filter(Boolean);
    if (new Set(opts.map((o) => o.toLowerCase())).size < opts.length) issues.push({ type: 'duplicate_options', detail: 'Two or more options are identical' });
    if (/\b(all|none) of the above\b/i.test(opts.join(' '))) issues.push({ type: 'clarity', detail: '"All/None of the above" options make the key fragile when options are shuffled' });
  }
  if (type === 'true_false' && /\b(always|never)\b/i.test(text)) {
    issues.push({ type: 'clarity', detail: 'Absolute words (always/never) in a True/False statement often make it ambiguous' });
  }
  if (type === 'assertion_reason' && t(d.assertion) && t(d.assertion).toLowerCase() === t(d.reason).toLowerCase()) {
    issues.push({ type: 'answer_mismatch', detail: 'The assertion and the reason are the same statement' });
  }
  if (type === 'numerical' && d.expected_value != null && d.expected_value !== '' && !t(d.unit) && /\b(how (long|far|much|fast)|speed|distance|mass|time|length)\b/i.test(text)) {
    issues.push({ type: 'clarity', detail: 'A physical quantity is asked for but no unit is given for the expected answer' });
  }
  if (type === 'fill_blank' && Array.isArray(d.answers) && d.answers.some((a) => t(a) && text.toLowerCase().includes(t(a).toLowerCase()))) {
    issues.push({ type: 'answer_mismatch', detail: 'An accepted answer already appears in the question text' });
  }
  if (type === 'case_study' && t(d.case_text) && text.trim().length > t(d.case_text).length) {
    issues.push({ type: 'clarity', detail: 'The question is longer than its case text; check that the case carries the scenario' });
  }
  return issues;
}
