// Automated validation summary of a paper (spec §25), shown to validators and the COE.
// Built by the server (backend/src/paper-validation-view.js) from data frozen at generation.
// Every result is written as text; colour is never the only signal.

const metLabel = (r) => (r.met == null ? '— (no target)' : r.met ? 'Met'
  : `Missed (${r.achieved > r.target ? `${r.achieved - r.target} over` : `${r.target - r.achieved} short`})`);

function TargetTable({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <div className="table-scroll" style={{ minWidth: 220 }}>
      <h5 style={{ margin: '8px 0 4px' }}>{title}</h5>
      <table>
        <thead><tr><th scope="col">{title === 'Course outcomes' ? 'CO' : 'Level'}</th><th scope="col">Target</th><th scope="col">Achieved</th><th scope="col">Result</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td><td>{r.target ?? '—'}</td><td>{r.achieved}</td>
              <td><span className={`badge ${r.met === false ? 'badge-rejected' : r.met ? 'badge-approved' : 'badge-draft'}`}>{metLabel(r)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ValidationSummary({ view }) {
  if (!view) return null;
  const hard = view.hard_targets;
  const relaxed = hard && (hard.co === false || hard.bloom === false);
  return (
    <div className="card">
      <h4>Automated validation</h4>
      <p className="hint">
        {view.passed ? 'Passed' : 'Failed'} · {view.question_count} question(s) · {view.total_marks} marks
        {view.printed_marks != null && view.printed_marks !== view.total_marks ? ` counted (${view.printed_marks} printed, with internal choices)` : ''}
        {view.target_mode === 'legacy_soft' ? ' · legacy blueprint: CO/Bloom targets were advisory'
          : hard ? ` · ${relaxed ? `targets relaxed by COE override (${[hard.co === false && 'CO', hard.bloom === false && 'Bloom'].filter(Boolean).join(' and ')})` : 'CO and Bloom targets enforced exactly'}` : ''}
        {view.units_covered != null ? ` · ${view.units_covered} unit(s) covered` : ''}
      </p>
      {view.errors?.length > 0 && (
        <div className="alert alert-error"><strong>Errors:</strong><ul style={{ margin: '4px 0 0 18px' }}>{view.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>
      )}
      {!view.passed && (
        <div className="alert alert-info">
          <strong>How to resolve:</strong> these rules are enforced exactly and are never relaxed automatically, so this paper cannot go
          forward as it is. Regenerate it as a new revision (another seed can find a valid combination), save a new blueprint version
          with targets the Active questions can meet, or have the department activate more questions mapped to the missing CO or Bloom
          level. Relaxing CO or Bloom targets needs a recorded COE override with a reason, which every validator sees.
        </div>
      )}
      {view.warnings?.length > 0 && (
        <div className="alert alert-warn"><strong>Notes:</strong><ul style={{ margin: '4px 0 0 18px' }}>{view.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
      )}
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <TargetTable title="Course outcomes" rows={view.co} />
        <TargetTable title="Bloom levels" rows={view.bloom} />
      </div>
      {view.sections?.length > 0 && (
        <>
          <h5 style={{ margin: '10px 0 4px' }}>Sections</h5>
          <div className="table-scroll"><table>
            <thead><tr><th scope="col">Section</th><th scope="col">Questions</th><th scope="col">Marks</th><th scope="col">Difficulty (got / expected)</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {view.sections.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}{s.attempt_count ? <div className="hint">attempt any {s.attempt_count} of {s.questions}</div> : null}{s.instructions && <div className="hint">{s.instructions}</div>}</td>
                  <td>{s.questions} / {s.expected_questions}</td>
                  <td>{s.marks}{s.expected_marks != null ? ` / ${s.expected_marks}` : ''}{s.printed_marks != null && s.printed_marks !== s.marks ? ` (${s.printed_marks} printed)` : ''}</td>
                  <td>{s.difficulty ? Object.entries(s.difficulty).map(([d, x]) => `${d} ${x.got}/${x.expected}`).join(' · ') : '—'}</td>
                  <td><span className={`badge ${s.ok ? 'badge-approved' : 'badge-rejected'}`}>{s.ok ? 'OK' : 'Check'}</span>
                    {!s.ok && s.errors?.length > 0 && <ul className="hint" style={{ margin: '2px 0 0 18px' }}>{s.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}
      {Array.isArray(view.internal_choices) && (
        <p className="hint">Internal choices: {view.internal_choices.length
          ? view.internal_choices.map((c) => `${c.section}: attempt any ${c.attempt_count} of ${c.of} (${c.marks_counted} marks counted, ${c.passed ? 'OK' : 'check failed'})`).join('; ')
          : 'none (every question must be answered)'}</p>
      )}
    </div>
  );
}
