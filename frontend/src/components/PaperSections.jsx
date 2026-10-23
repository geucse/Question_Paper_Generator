import { labelDiffers } from '../lib/printLabels';
import { typeLabel } from '../lib/questionTypes';

// Section headings for a paper preview, from GET /examinations/papers/:id -> sections: the paper's frozen section
// rules (backend/src/paper-sections.js), the same text the PDF prints. Shows instructions, count, marks, allowed
// types, difficulty split, the internal choice and the automated per-section check. Every result is written as
// text; colour is never the only signal. Older API responses without `sections` fall back to a plain heading.
export function SectionHeader({ section: s }) {
  const d = s.difficulty_split;
  const facts = [
    s.attempt_count ? `attempt any ${s.attempt_count} of ${s.questions}` : `${s.questions} question${s.questions === 1 ? '' : 's'}`,
    `${s.marks_counted} marks counted`,
    s.marks_per_question != null ? `${s.marks_per_question} marks each` : 'marks vary',
    `types: ${s.allowed_types ? s.allowed_types.map(typeLabel).join(', ') : 'any'}`,
    d ? `easy/medium/hard ${d.easy}/${d.medium}/${d.hard}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div style={{ margin: '12px 0 4px' }}>
      <h5 style={{ margin: 0 }}>
        {s.name}{' '}
        {s.check == null ? <span className="badge badge-draft">No recorded rules</span>
          : s.check.passed ? <span className="badge badge-approved">Section check passed</span>
            : <span className="badge badge-rejected">Section check failed</span>}
      </h5>
      <div className="hint">{facts}</div>
      {(s.instruction_lines || []).map((l, i) => <div key={i} className="hint" style={{ fontStyle: 'italic' }}>{l}</div>)}
      {s.check && !s.check.passed && <ul className="hint" style={{ margin: '2px 0 0 18px' }}>{s.check.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
    </div>
  );
}

export function SectionedQuestions({ paper, renderQuestion }) {
  const byName = new Map((paper.sections || []).map((s) => [s.name, s]));
  return paper.questions.map((q, i) => (
    <div key={q.question_id}>
      {q.section_name && q.section_name !== paper.questions[i - 1]?.section_name && (byName.get(q.section_name)
        ? <SectionHeader section={byName.get(q.section_name)} />
        : <h5 style={{ margin: '10px 0 4px' }}>{q.section_name}</h5>)}
      {renderQuestion(q)}
    </div>
  ));
}

export function InternalChoiceSummary({ paper }) {
  if (!Array.isArray(paper.sections) || !paper.sections.length) return null;
  const c = paper.sections.filter((s) => s.attempt_count);
  return (
    <p className="hint">
      {c.length ? `Internal choices: ${c.map((s) => `${s.name}: attempt any ${s.attempt_count} of ${s.questions}`).join('; ')}.`
        : 'No internal choices: every question must be answered.'}
    </p>
  );
}

// What the COE relaxed, the original targets and what the paper achieved (shown to the COE and every validator).
export function OverrideNotice({ override: o }) {
  if (!o) return null;
  const fmt = (x) => (x ? Object.entries(x).map(([k, v]) => `${k} ${v}`).join(', ') : '—');
  return (
    <div className="alert alert-warn">
      Generated with relaxed {o.relax.join(' and ')} targets, approved by the generating COE: {o.reason}
      {(o.relax || []).map((d) => (
        <div key={d} className="hint">{d === 'co' ? 'CO' : 'Bloom'} targets {fmt(o.original_targets?.[d])}; achieved {fmt(o.achieved?.[d])}</div>
      ))}
      {o.strict_failure?.proven === false && <div className="hint">The exact search was not exhaustive (search limit reached), so the exact targets were not proven impossible.</div>}
    </div>
  );
}

// The printed paper's number for a question when it differs from its slot (lib/printLabels.js).
export function PrintedAs({ q }) {
  return labelDiffers(q) ? <span className="print-label">printed as {q.print_label}</span> : null;
}

// The CO codes recorded for the question when the paper was generated (what the printed CO column shows).
export function CoChips({ q }) {
  if (!Array.isArray(q.cos) || !q.cos.length) return null;
  return <span aria-label={`Course outcomes: ${q.cos.join(', ')}`}>{q.cos.map((c) => <span key={c} className="co-chip">{c}</span>)}</span>;
}
