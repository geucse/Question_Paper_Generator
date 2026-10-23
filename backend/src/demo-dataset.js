// The 14-subject demo dataset built from the official 2023 CSE syllabus (data/syllabus-2023):
//   catalog.json        subjects, COs and units exactly as extracted from the PDF (syllabus-parse.js), with pages
//   questions/<CODE>.json  per subject: the HOD-verified topic list (each topic verbatim from its unit's text) and
//                          20 SAMPLE questions grounded in those topics and the subject's own COs
// Every generated question is DEMO / SAMPLE content, not an official examination question. validateDemoDataset()
// is the single check used by the seed and the tests: it refuses the dataset rather than seeding anything invalid.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQuestionByType, ASSERTION_REASON_OPTIONS } from './question-types.js';
import { BLOOM_LEVELS, DIFFICULTIES } from './taxonomy.js';

export const DEMO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'syllabus-2023');
export const DEMO_LABEL = 'DEMO / SAMPLE — NOT AN OFFICIAL EXAM QUESTION';
export const QUESTIONS_PER_SUBJECT = 20;

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const fileFor = (code) => path.join(DEMO_DIR, 'questions', `${code.replace(/\s+/g, '')}.json`);

export function loadCatalog(dir = DEMO_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
}

// Compact authoring record -> the fields a question row carries (question-types.js conventions).
export function toQuestionFields(q) {
  const base = {
    question_type: q.type, question_text: q.q, marks: q.marks, difficulty: q.diff, bloom_level: q.bloom,
    model_answer: q.model || null, option_a: null, option_b: null, option_c: null, option_d: null, correct_answer: null, answer_data: {},
  };
  switch (q.type) {
    case 'mcq': {
      const [a, b, c, d] = q.opts || [];
      Object.assign(base, { option_a: a ?? null, option_b: b ?? null, option_c: c ?? null, option_d: d ?? null });
      base.correct_answer = (q.opts || [])['ABCD'.indexOf(String(q.ans).toUpperCase())] ?? null; // stored as the option text
      break;
    }
    case 'true_false': base.correct_answer = String(q.ans).toUpperCase(); break;
    case 'assertion_reason': base.correct_answer = String(q.ans).toUpperCase(); base.answer_data = { assertion: q.assertion, reason: q.reason }; break;
    case 'numerical': base.answer_data = { expected_value: q.val, ...(q.tol != null ? { tolerance: q.tol } : {}), ...(q.unit ? { unit: q.unit } : {}) }; break;
    case 'fill_blank': base.answer_data = { answers: q.answers }; break;
    case 'programming': base.answer_data = { language: q.lang, ...(q.constraints ? { constraints: q.constraints } : {}) }; break;
    case 'case_study': base.answer_data = { case_text: q.case }; break;
    default: break;
  }
  return base;
}

// Returns { subjects: [{ ...catalogSubject, topics: {unit: [titles]}, questions: [...] }], errors: [] }.
export function loadDemoDataset(dir = DEMO_DIR) {
  const catalog = loadCatalog(dir);
  const errors = [];
  const subjects = catalog.subjects.map((src) => {
    let s = src;
    const file = fileFor(s.code);
    if (!fs.existsSync(file)) { errors.push(`${s.code}: questions file missing (${path.basename(file)})`); return { ...s, topics: {}, questions: [] }; }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.code !== s.code) errors.push(`${path.basename(file)}: code ${data.code} does not match ${s.code}`);
    // HOD verification corrections of extraction errors: each names the exact source text it replaces.
    const corrections = data.source_corrections || [];
    const units = s.units.map((u) => {
      let text = u.text;
      for (const c of corrections.filter((x) => x.unit === u.number)) {
        if (!text.includes(c.from)) errors.push(`${s.code} unit ${u.number}: correction source "${c.from}" not found`);
        else if (!c.reason) errors.push(`${s.code} unit ${u.number}: correction "${c.from}" has no reason`);
        else text = text.replace(c.from, c.to);
      }
      return text === u.text ? u : { ...u, text, source_text: u.text };
    });
    s = { ...s, units, corrections };
    const topics = data.verified_topics || {};
    const coCodes = new Set(s.course_outcomes.map((c) => c.code));
    // Verified topics: verbatim phrases of their unit's source text, every unit verified.
    for (const u of s.units) {
      const list = topics[String(u.number)] || [];
      if (!list.length) errors.push(`${s.code} unit ${u.number}: no verified topics`);
      for (const t of list) if (!norm(u.text).includes(norm(t))) errors.push(`${s.code} unit ${u.number}: topic "${t}" is not in the syllabus text`);
      if (new Set(list.map(norm)).size !== list.length) errors.push(`${s.code} unit ${u.number}: duplicate topics`);
    }
    for (const k of Object.keys(topics)) if (!s.units.some((u) => String(u.number) === k)) errors.push(`${s.code}: topics for unknown unit ${k}`);
    const questions = (data.questions || []).map((q, i) => {
      const where = `${s.code} Q${i + 1}`;
      const unit = s.units.find((u) => u.number === q.u);
      if (!unit) errors.push(`${where}: unit ${q.u} is not in the syllabus`);
      else if (!(topics[String(q.u)] || []).includes(q.t)) errors.push(`${where}: topic "${q.t}" is not a verified topic of unit ${q.u}`);
      const cos = Array.isArray(q.co) ? q.co : [];
      if (!cos.length) errors.push(`${where}: no CO mapped`);
      for (const c of cos) if (!coCodes.has(c)) errors.push(`${where}: ${c} is not a CO of ${s.code}`);
      if (!BLOOM_LEVELS.includes(q.bloom)) errors.push(`${where}: Bloom level "${q.bloom}" is not one of ${BLOOM_LEVELS.join(', ')}`);
      if (!DIFFICULTIES.includes(q.diff)) errors.push(`${where}: difficulty "${q.diff}" is not one of ${DIFFICULTIES.join(', ')}`);
      if (!Number.isInteger(q.marks) || q.marks < 1 || q.marks > 20) errors.push(`${where}: marks must be a whole number from 1 to 20`);
      if (q.type === 'assertion_reason' && !ASSERTION_REASON_OPTIONS[String(q.ans).toUpperCase()]) errors.push(`${where}: assertion-reason answer must be A-D`);
      const fields = toQuestionFields(q);
      for (const e of validateQuestionByType(fields, { forActivation: true, requireAssets: false })) errors.push(`${where}: ${e}`);
      return { ...fields, unit_number: q.u, topic_title: q.t, cos: [...new Set(cos)].sort(), key: `${s.code.replace(/\s+/g, '')}-Q${String(i + 1).padStart(2, '0')}` };
    });
    if (questions.length !== QUESTIONS_PER_SUBJECT) errors.push(`${s.code}: ${questions.length} questions (expected ${QUESTIONS_PER_SUBJECT})`);
    // Type-specific content counts too: assertion-reason and case-study questions carry it in answer_data.
    const texts = questions.map((q) => norm(q.question_text) + '|' + norm(JSON.stringify(q.answer_data)));
    if (new Set(texts).size !== texts.length) errors.push(`${s.code}: duplicate question text`);
    for (const u of s.units) if (!questions.some((q) => q.unit_number === u.number)) errors.push(`${s.code}: unit ${u.number} has no question`);
    // Every CO is covered by a question, or carries an HOD flag explaining why it cannot be (never silently missing).
    const flags = data.hod_flags || [];
    for (const c of s.course_outcomes) {
      const covered = questions.some((q) => q.cos.includes(c.code));
      const flagged = flags.some((f) => f.co === c.code && String(f.issue || '').length > 20);
      if (!covered && !flagged) errors.push(`${s.code}: ${c.code} has no question and no HOD flag`);
      if (covered && flagged) errors.push(`${s.code}: ${c.code} is flagged but also covered`);
    }
    s = { ...s, hod_flags: flags };
    return { ...s, topics, questions };
  });
  return { catalog, subjects, errors };
}

// Counts used by the catalog document and the tests.
export function datasetSummary(subjects) {
  const by = (list, key) => list.reduce((m, x) => { const k = typeof key === 'function' ? key(x) : x[key]; m[k] = (m[k] || 0) + 1; return m; }, {});
  const questions = subjects.flatMap((s) => s.questions);
  return {
    subjects: subjects.length, questions: questions.length,
    course_outcomes: subjects.reduce((a, s) => a + s.course_outcomes.length, 0),
    units: subjects.reduce((a, s) => a + s.units.length, 0),
    topics: subjects.reduce((a, s) => a + Object.values(s.topics).reduce((b, l) => b + l.length, 0), 0),
    by_type: by(questions, 'question_type'), by_bloom: by(questions, 'bloom_level'), by_difficulty: by(questions, 'difficulty'),
  };
}

// The lifecycle state the demo seed gives each question (by 1-based position). Four questions per subject stay out
// of the ACTIVE bank, one each in APPROVED, CHANGES_REQUESTED, SUBMITTED and DRAFT, so every workflow state is
// visible. They are chosen from the end of the list such that the ACTIVE questions still cover every unit and
// every CO the subject's questions cover: the bank stays complete wherever the syllabus allows (the one deliberate
// gap is a CO with an HOD flag, e.g. TCS 409 CO3, which no question can cover). `keepActive` positions (the
// revision showcase) are never chosen.
export const NON_ACTIVE_STATES = ['DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED'];
export function lifecyclePlan(subject, { keepActive = [] } = {}) {
  const qs = subject.questions;
  const coverOf = (list) => ({ units: new Set(list.map((q) => q.unit_number)), cos: new Set(list.flatMap((q) => q.cos)) });
  const full = coverOf(qs);
  const out = new Set();
  for (let i = qs.length - 1; i >= 0 && out.size < NON_ACTIVE_STATES.length; i--) {
    if (keepActive.includes(i + 1)) continue;
    const rest = qs.filter((_, k) => k !== i && !out.has(k + 1));
    const c = coverOf(rest);
    if ([...full.units].every((u) => c.units.has(u)) && [...full.cos].every((x) => c.cos.has(x))) out.add(i + 1);
  }
  const plan = new Map(qs.map((_, k) => [k + 1, 'ACTIVE']));
  [...out].forEach((pos, k) => plan.set(pos, NON_ACTIVE_STATES[k]));
  return plan;
}
