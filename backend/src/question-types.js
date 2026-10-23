// The 13 question types of PIVOT_SPEC_V2 §8, with the type-specific rules of §10.
// Single source of truth for the API, bulk upload, generator validation and PDF rendering.
// The database mirrors the code list (migration 037 CHECK constraint and quality gate);
// test-question-types.mjs fails if they drift apart.

export const QUESTION_TYPES = [
  { code: 'mcq', label: 'MCQ' },
  { code: 'short_answer', label: 'Short Answer' },
  { code: 'long_answer', label: 'Long Answer' },
  { code: 'numerical', label: 'Numerical' },
  { code: 'derivation', label: 'Derivation' },
  { code: 'proof', label: 'Proof' },
  { code: 'programming', label: 'Programming' },
  { code: 'case_study', label: 'Case Study' },
  { code: 'diagram', label: 'Diagram' },
  { code: 'assertion_reason', label: 'Assertion-Reason' },
  { code: 'fill_blank', label: 'Fill in the Blank' },
  { code: 'true_false', label: 'True/False' },
  { code: 'descriptive', label: 'Descriptive' },
];
export const QUESTION_TYPE_CODES = QUESTION_TYPES.map((t) => t.code);

// Pre-pivot values, still accepted from older clients and files; stored data was migrated (037).
const LEGACY = { objective: 'mcq', subjective: 'descriptive' };

// Standard Assertion-Reason options (fixed wording, so only the key is stored).
export const ASSERTION_REASON_OPTIONS = {
  A: 'Both A and R are true, and R is the correct explanation of A',
  B: 'Both A and R are true, but R is not the correct explanation of A',
  C: 'A is true, but R is false',
  D: 'A is false, but R is true',
};

export function normalizeQuestionType(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim().toLowerCase().replace(/[\s/-]+/g, '_');
  if (LEGACY[v]) return LEGACY[v];
  const byLabel = QUESTION_TYPES.find((t) => t.label.toLowerCase().replace(/[\s/-]+/g, '_') === v);
  if (byLabel) return byLabel.code;
  if (v === 'fill_in_the_blank') return 'fill_blank';
  return QUESTION_TYPE_CODES.includes(v) ? v : null;
}

export const typeLabel = (code) => (QUESTION_TYPES.find((t) => t.code === code) || {}).label || code;

const text = (v) => (v == null ? '' : String(v).trim());
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Parses answer_data from a request/row (object or JSON text). Returns {} when absent.
export function parseAnswerData(value) {
  if (value == null || value === '') return {};
  if (isObj(value)) return value;
  try { const o = JSON.parse(String(value)); return isObj(o) ? o : {}; } catch { return null; }
}

// q: { question_type, question_text, option_a..d, correct_answer, model_answer, answer_data, attachment_count? }
// options.forActivation: also require what is only needed before a question becomes ACTIVE
// (model answer, all four MCQ options, a diagram asset).
// Returns a list of human-readable errors (empty = valid). Never throws.
export function validateQuestionByType(q, { forActivation = false, requireAssets = forActivation } = {}) {
  const errors = [];
  const type = normalizeQuestionType(q.question_type);
  if (!type) return [`question_type must be one of: ${QUESTION_TYPE_CODES.join(', ')}`];
  const data = parseAnswerData(q.answer_data);
  if (data === null) return ['answer_data must be a JSON object'];
  const ans = text(q.correct_answer).toUpperCase();
  // Model answers: the quality gate requires one for every type before ACTIVE (unchanged rule);
  // drafts may be saved without one (the preview shows a warning).
  const needModel = () => {};

  switch (type) {
    case 'mcq': {
      // Existing convention: options A and B required while drafting (C, D optional), all four before ACTIVE;
      // the correct answer is the exact text of one option.
      const opts = ['a', 'b', 'c', 'd'].map((k) => text(q[`option_${k}`])).filter(Boolean);
      if (!text(q.option_a) || !text(q.option_b)) errors.push('MCQ needs at least options A and B');
      if (forActivation && opts.length < 4) errors.push('MCQ needs all four options before it can become ACTIVE');
      // A letter (A-D) naming a provided option is accepted too; mcqCorrectText() resolves it.
      if (!text(q.correct_answer)) errors.push('MCQ must have a correct answer set');
      else if (!opts.includes(text(q.correct_answer)) && !text(q[`option_${text(q.correct_answer).toLowerCase()}`])) {
        errors.push('MCQ correct answer must exactly match one of the provided options');
      }
      break;
    }
    case 'true_false':
      if (!['TRUE', 'FALSE'].includes(ans)) errors.push('True/False needs a correct answer of TRUE or FALSE');
      break;
    case 'assertion_reason':
      if (!text(data.assertion)) errors.push('Assertion-Reason needs answer_data.assertion');
      if (!text(data.reason)) errors.push('Assertion-Reason needs answer_data.reason');
      if (!Object.keys(ASSERTION_REASON_OPTIONS).includes(ans)) errors.push('Assertion-Reason needs a correct answer of A, B, C or D');
      break;
    case 'numerical': {
      const v = data.expected_value;
      if (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) errors.push('Numerical needs answer_data.expected_value (a number)');
      if (data.tolerance != null && data.tolerance !== '' && !(Number(data.tolerance) >= 0)) errors.push('Numerical answer_data.tolerance must be a non-negative number');
      break;
    }
    case 'fill_blank': {
      const answers = Array.isArray(data.answers) ? data.answers.map(text).filter(Boolean) : [];
      if (!answers.length) errors.push('Fill in the Blank needs answer_data.answers (one accepted answer per blank)');
      const blanks = (String(q.question_text || '').match(/_{3,}/g) || []).length;
      if (!blanks) errors.push('Fill in the Blank question text must mark each blank with ___');
      else if (answers.length && answers.length !== blanks) errors.push(`Fill in the Blank has ${blanks} blank(s) but ${answers.length} answer(s)`);
      break;
    }
    case 'programming':
      if (!text(data.language)) errors.push('Programming needs answer_data.language');
      needModel();
      break;
    case 'case_study':
      if (text(data.case_text).length < 20) errors.push('Case Study needs answer_data.case_text (the case, at least 20 characters)');
      needModel();
      break;
    case 'diagram':
      needModel();
      if (requireAssets && !(Number(q.attachment_count) > 0)) errors.push('Diagram question needs an attached diagram before it can become ACTIVE');
      // diagram_image_count (clean PNG/JPEG files), when the caller knows it: the PDF can embed only those (migration 041).
      else if (requireAssets && q.diagram_image_count != null && !(Number(q.diagram_image_count) > 0)) {
        errors.push('Diagram question needs its diagram as a PNG or JPEG image (the printed paper can only embed those)');
      }
      break;
    default: // short_answer, long_answer, derivation, proof, descriptive
      needModel();
  }
  if (forActivation && text(q.model_answer).length < 5) errors.push(`${typeLabel(type)} needs a model answer/solution`);
  return errors;
}

// Objective types are auto-markable; used for PDF answer keys and analytics.
export const OBJECTIVE_TYPES = ['mcq', 'true_false', 'assertion_reason', 'fill_blank', 'numerical'];

// Resolves an MCQ answer given as a letter to the option text (the stored convention).
export function mcqCorrectText(q) {
  const a = text(q.correct_answer);
  if (/^[A-Da-d]$/.test(a) && text(q[`option_${a.toLowerCase()}`])) return text(q[`option_${a.toLowerCase()}`]);
  return a || null;
}

// Which stored fields each type uses (spec §10). Everything else is dropped when a question is saved, so a type
// change never leaves stale options, answers or answer_data keys behind.
export const TYPE_DATA_KEYS = {
  mcq: [], true_false: [], assertion_reason: ['assertion', 'reason'], numerical: ['expected_value', 'tolerance', 'unit'],
  fill_blank: ['answers'], programming: ['language', 'constraints'], case_study: ['case_text'],
};
const USES_OPTIONS = ['mcq'];
const USES_CORRECT_ANSWER = ['mcq', 'true_false', 'assertion_reason'];
export const PRINTABLE_IMAGE_TYPES = ['image/png', 'image/jpeg']; // what the PDF (pdfkit) can embed

// The per-type normal form of a question's answer fields, used by every write path (draft save, bulk import):
// MCQ letter -> option text (mcqCorrectText), True/False and Assertion-Reason keys upper-cased, numbers as numbers,
// fill-blank answers as a trimmed list, text trimmed, and options / correct_answer / answer_data keys the type does
// not use removed. Returns null when the type or answer_data is invalid (validateQuestionByType reports why).
export function normalizeQuestionData(q) {
  const type = normalizeQuestionType(q.question_type);
  const raw = parseAnswerData(q.answer_data);
  if (!type || raw === null) return null;
  const out = { question_type: type, option_a: null, option_b: null, option_c: null, option_d: null, correct_answer: null, answer_data: {} };
  if (USES_OPTIONS.includes(type)) for (const k of ['a', 'b', 'c', 'd']) out[`option_${k}`] = text(q[`option_${k}`]) || null;
  if (USES_CORRECT_ANSWER.includes(type)) {
    out.correct_answer = (type === 'mcq' ? mcqCorrectText(q) : text(q.correct_answer).toUpperCase()) || null;
  }
  for (const k of TYPE_DATA_KEYS[type] || []) {
    const v = raw[k];
    if (k === 'answers') {
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split('|') : [];
      const answers = list.map(text).filter(Boolean);
      if (answers.length) out.answer_data.answers = answers;
    } else if (k === 'expected_value' || k === 'tolerance') {
      // Kept as typed when it is not a number, so validation names the problem instead of the value vanishing.
      if (v !== undefined && v !== null && text(v) !== '') out.answer_data[k] = Number.isFinite(Number(v)) ? Number(v) : v;
    } else if (text(v)) {
      out.answer_data[k] = text(v);
    }
  }
  return out;
}

// Spreadsheet rows carry type-specific data as plain columns (or an answer_data JSON column).
export function answerDataFromRow(row) {
  const fromJson = parseAnswerData(row.answer_data);
  const d = fromJson && Object.keys(fromJson).length ? { ...fromJson } : {};
  const put = (k, v) => { if (text(v) && d[k] === undefined) d[k] = text(v); };
  if (text(row.expected_value) && d.expected_value === undefined) d.expected_value = Number(row.expected_value);
  if (text(row.tolerance) && d.tolerance === undefined) d.tolerance = Number(row.tolerance);
  put('unit', row.unit); put('language', row.language); put('constraints', row.constraints);
  put('case_text', row.case_text); put('assertion', row.assertion); put('reason', row.reason);
  if (text(row.answers) && d.answers === undefined) d.answers = String(row.answers).split('|').map(text).filter(Boolean);
  return d;
}
