// The 13 question types of PIVOT_SPEC_V2 §8 (mirror of backend/src/question-types.js; the server
// re-validates everything). Grouped under the existing Objective / Subjective tabs.
export const QUESTION_TYPES = [
  { code: 'mcq', label: 'MCQ', group: 'objective' },
  { code: 'true_false', label: 'True/False', group: 'objective' },
  { code: 'assertion_reason', label: 'Assertion-Reason', group: 'objective' },
  { code: 'fill_blank', label: 'Fill in the Blank', group: 'objective' },
  { code: 'numerical', label: 'Numerical', group: 'objective' },
  { code: 'short_answer', label: 'Short Answer', group: 'subjective' },
  { code: 'long_answer', label: 'Long Answer', group: 'subjective' },
  { code: 'descriptive', label: 'Descriptive', group: 'subjective' },
  { code: 'derivation', label: 'Derivation', group: 'subjective' },
  { code: 'proof', label: 'Proof', group: 'subjective' },
  { code: 'programming', label: 'Programming', group: 'subjective' },
  { code: 'case_study', label: 'Case Study', group: 'subjective' },
  { code: 'diagram', label: 'Diagram', group: 'subjective' },
];
const LEGACY = { objective: 'mcq', subjective: 'descriptive' };
export const normalizeType = (t) => LEGACY[t] || t;
export const typeLabel = (t) => (QUESTION_TYPES.find((x) => x.code === normalizeType(t)) || {}).label || t;
export const typesInGroup = (g) => QUESTION_TYPES.filter((t) => t.group === g);
export const ASSERTION_REASON_OPTIONS = {
  A: 'Both A and R are true, and R is the correct explanation of A',
  B: 'Both A and R are true, but R is not the correct explanation of A',
  C: 'A is true, but R is false',
  D: 'A is false, but R is true',
};

// Which answer fields each type uses (mirror of backend/src/question-types.js TYPE_DATA_KEYS). The server drops
// the rest on save; the form drops them when the type changes, so nothing stale is shown or sent.
export const TYPE_DATA_KEYS = {
  mcq: [], true_false: [], assertion_reason: ['assertion', 'reason'], numerical: ['expected_value', 'tolerance', 'unit'],
  fill_blank: ['answers'], programming: ['language', 'constraints'], case_study: ['case_text'],
};
const USES_OPTIONS = ['mcq'];

// A question form switched to another type keeps what every type shares (text, marks, difficulty, Bloom, topic,
// model answer) and clears the answer fields the new type reads differently (an answer key is option text for an
// MCQ, TRUE/FALSE or A-D otherwise, so it never carries over).
export function withQuestionType(form, type) {
  const next = { ...form, question_type: type };
  if (normalizeType(form.question_type) === type) return next;
  if (!USES_OPTIONS.includes(type)) Object.assign(next, { option_a: '', option_b: '', option_c: '', option_d: '' });
  next.correct_answer = '';
  const keep = TYPE_DATA_KEYS[type] || [];
  next.answer_data = Object.fromEntries(Object.entries(form.answer_data || {}).filter(([k]) => keep.includes(k)));
  delete next.fill_blank_text;
  return next;
}

// answer_data as an object, whatever the API returned (JSONB object, JSON text, or nothing). Never throws.
export function parseAnswerData(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
  }
  return {};
}

// The option letter an MCQ key names: stored as the option text (current rule) or a letter (older rows).
export function mcqKeyLetter(q) {
  const ans = String(q.correct_answer ?? '').trim();
  if (/^[A-Da-d]$/.test(ans) && q[`option_${ans.toLowerCase()}`]) return ans.toUpperCase();
  const hit = ['a', 'b', 'c', 'd'].find((k) => ans && String(q[`option_${k}`] ?? '').trim() === ans);
  return hit ? hit.toUpperCase() : null;
}

// A paper question (GET /examinations/papers/:id: snapshot text, marks, meta, attachments) in the question shape.
export const fromPaperQuestion = (pq) => ({ ...(pq.meta || {}), question_text: pq.text, marks: pq.marks, attachments: pq.attachments || [] });
