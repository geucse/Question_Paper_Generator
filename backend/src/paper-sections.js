// The section view of a generated paper, for the COE/validator previews, the automated-validation summary and
// the PDF. Built ONLY from exam_papers.format_config.sections (the normalised section rules frozen at generation,
// immutable since migration 039) and the paper_questions snapshots, never from the live blueprint (spec §21).
// The per-section check is exam-generator.js checkSections, the same function the generator runs, so a paper
// generated before a rule existed still gets a real pass/fail from its own snapshot.
import { checkSections } from './exam-generator.js';

const num = (v) => (v == null ? 0 : Number(v));

// format_config is TEXT (migration 005); sections were added to it with migration 037. Older shapes give [].
export function paperSectionRules(formatConfig) {
  let fc = formatConfig;
  if (typeof fc === 'string') { try { fc = JSON.parse(fc); } catch { fc = null; } }
  return Array.isArray(fc?.sections) ? fc.sections.filter((s) => s && s.name) : [];
}

// questions: [{ section_name, slot_number, marks, question_type, difficulty }] in slot order.
export function paperSectionsView(formatConfig, questions) {
  const rules = paperSectionRules(formatConfig);
  const checks = new Map(checkSections(rules, questions).map((c) => [c.name, c]));
  const view = rules.map((s) => build(s, questions.filter((q) => q.section_name === s.name), checks.get(s.name)));
  for (const q of questions) {
    if (q.section_name && !view.some((v) => v.name === q.section_name)) {
      // No rule recorded for this section (older paper): show it, but never a made-up pass.
      view.push(build({ name: q.section_name, index: view.length }, questions.filter((x) => x.section_name === q.section_name), null));
    }
  }
  return view;
}

function build(s, qs, check) {
  const printed = qs.reduce((a, q) => a + num(q.marks), 0);
  const attempt = s.attempt != null ? num(s.attempt) : null;
  const mpq = s.mpq != null ? num(s.mpq) : null;
  const counted = attempt != null && mpq != null ? attempt * mpq : printed;
  const heading = attempt != null
    ? `${s.name}  (Attempt any ${attempt} of ${qs.length} questions, ${counted} marks)`
    : `${s.name}  (${qs.length} question${qs.length === 1 ? '' : 's'}, ${counted} marks)`;
  const lines = [];
  if (attempt != null) lines.push(`Attempt any ${attempt} of the ${qs.length} questions in this section. Each question carries ${mpq} marks.`);
  if (s.instructions) lines.push(String(s.instructions));
  const difficulty = s.diff
    ? Object.fromEntries(Object.entries(s.diff).map(([d, want]) => [d, { expected: num(want), got: qs.filter((q) => String(q.difficulty || '').toLowerCase() === d).length }]))
    : null;
  return {
    index: s.index ?? null, name: s.name, instructions: s.instructions || null, question_count: s.question_count ?? null, questions: qs.length,
    marks_per_question: mpq, total_marks: s.total ?? null, attempt_count: attempt, allowed_types: s.types || null, difficulty_split: s.diff || null,
    difficulty, printed_marks: printed, marks_counted: counted, heading, instruction_lines: lines,
    check: check ? { passed: check.passed, errors: check.errors } : null,
  };
}

// Maximum marks a candidate can score: counted marks per section plus every question outside a section.
export function paperCountedMarks(view, questions) {
  const named = new Set(view.map((v) => v.name));
  return view.reduce((a, v) => a + v.marks_counted, 0) + questions.filter((q) => !named.has(q.section_name)).reduce((a, q) => a + num(q.marks), 0);
}
