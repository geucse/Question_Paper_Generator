// What validators and the COE see of the automated validation (PIVOT_SPEC_V2 §25): targets vs achieved for
// CO and Bloom, and per-section results. Pure, and built only from data frozen at generation: the paper's
// validation report (candidate_metrics.validation), its blueprint version (frozen once used, migrations 031/039),
// format_config.sections and the paper_questions snapshots. The per-section results come from
// paper-sections.js (exam-generator.js checkSections, the generator's own check, re-run on the snapshot).
// targets: resolved targets snapshotted on the paper (candidate_metrics.targets = { co, bloom } counts), when the
// generator recorded them; preferred over recomputing from the blueprint.
import { bloomTargetCounts } from './exam-generator.js';
import { paperSectionsView } from './paper-sections.js';

function pair(targets, got) {
  return [...new Set([...Object.keys(targets || {}), ...Object.keys(got || {})])].sort().map((key) => {
    const target = targets?.[key] == null ? null : Number(targets[key]);
    const achieved = Number(got?.[key] || 0);
    return { key, target, achieved, met: target == null ? null : achieved === target };
  });
}

// Snapshot rows (GET /papers/:id shape, metadata in `meta`) -> the shape checkSections reads.
export const snapshotForCheck = (q) => ({ section_name: q.section_name, slot_number: q.slot_number, marks: q.marks,
  question_type: q.meta?.question_type ?? q.question_type, difficulty: q.meta?.difficulty ?? q.difficulty });

export function paperValidationView({ report, blueprint, formatConfig, questions = [], targets = null }) {
  if (!report) return null;
  const s = report.summary || {};
  const n = s.question_count ?? questions.length;
  const co = pair(targets?.co || blueprint?.co_distribution || {}, s.co || {});
  const bloom = pair(targets?.bloom || bloomTargetCounts(blueprint?.bloom_distribution, n).targets, s.bloom || {});
  const sections = paperSectionsView(formatConfig, questions.map(snapshotForCheck)).filter((v) => v.check).map((v) => ({
    name: v.name, instructions: v.instructions, expected_questions: v.question_count, questions: v.questions,
    expected_marks: v.total_marks ?? (v.marks_per_question != null ? v.marks_per_question * (v.attempt_count ?? v.question_count) : null),
    marks: v.marks_counted, printed_marks: v.printed_marks, attempt_count: v.attempt_count, difficulty: v.difficulty,
    ok: v.check.passed, errors: v.check.errors,
  }));
  return {
    passed: report.passed, errors: report.errors || [], warnings: report.warnings || [], hard_targets: s.hard_targets || null,
    target_mode: s.target_mode || null, total_marks: s.total_marks, printed_marks: s.printed_marks ?? s.total_marks, question_count: n,
    units_covered: s.units_covered, internal_choices: Array.isArray(s.internal_choices) ? s.internal_choices : null,
    co, bloom, sections,
  };
}
