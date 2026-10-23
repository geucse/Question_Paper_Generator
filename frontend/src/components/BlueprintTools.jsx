import { useEffect, useState } from 'react';
import { api } from '../api';
import { typeLabel } from '../lib/questionTypes';

// CO/Bloom override controls, shared by "Generate" and "Regenerate" (state helpers in lib/overrides.js).
export function OverrideFields({ value, onChange, idPrefix }) {
  return (
    <>
      <label style={{ fontWeight: 400, display: 'block', marginTop: 8 }}>
        <input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} /> Relax CO/Bloom targets for this one generation
      </label>
      {value.on && (
        <div className="card" style={{ marginTop: 6 }}>
          <label style={{ fontWeight: 400 }}><input type="checkbox" checked={value.co} onChange={(e) => onChange({ ...value, co: e.target.checked })} /> CO targets</label>{' '}
          <label style={{ fontWeight: 400 }}><input type="checkbox" checked={value.bloom} onChange={(e) => onChange({ ...value, bloom: e.target.checked })} /> Bloom targets</label>
          <div className="field"><label htmlFor={`${idPrefix}-ov-reason`}>Reason (10 to 1000 characters)</label>
            <input id={`${idPrefix}-ov-reason`} maxLength={1000} value={value.reason} onChange={(e) => onChange({ ...value, reason: e.target.value })} /></div>
          <p className="hint">Accepted only when the exact targets cannot be met; the smallest override is required. You are recorded as the approver and all 4 validators see it.
            Sections, marks and difficulty counts can never be relaxed.</p>
        </div>
      )}
    </>
  );
}

const pairs = (x) => (x ? Object.entries(x).map(([k, v]) => `${k}: ${v}`).join(', ') : '—');

// Read-only view of one blueprint version (GET /examinations/blueprints/:id), with "Copy into editor".
export function BlueprintDetail({ token, id, onCopy }) {
  const [bp, setBp] = useState(null);
  const [error, setError] = useState('');
  // The parent remounts this component per blueprint id (key), so state starts empty for each one.
  useEffect(() => {
    let live = true;
    api.get(`/examinations/blueprints/${id}`, token).then((x) => { if (live) setBp(x); }).catch((e) => { if (live) setError(e.data?.error || e.message); });
    return () => { live = false; };
  }, [id, token]);
  if (error) return <div className="alert alert-error">{error}</div>;
  if (!bp) return <p className="hint">Loading blueprint…</p>;
  const t = bp.targets || {};
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <h4 style={{ marginTop: 0 }}>Blueprint v{bp.version_number}{' '}
        <span className={`badge ${bp.target_mode === 'hard' ? 'badge-approved' : 'badge-rejected'}`}>{bp.target_mode === 'hard' ? 'Exact targets' : 'Legacy (soft targets)'}</span>
        {bp.is_active ? '' : <span className="hint"> · superseded</span>}
      </h4>
      {bp.generation_blocked_reason && <div className="alert alert-warn">{bp.generation_blocked_reason}</div>}
      <p className="hint">easy/medium/hard {bp.easy_count}/{bp.medium_count}/{bp.hard_count} · {bp.total_marks} marks counted · reuse look-back {bp.reuse_lookback_exams} exam(s)
        {bp.supersedes_version ? ` · supersedes v${bp.supersedes_version}` : ''}</p>
      {bp.sections_normalized?.length > 0 && (
        <table>
          <thead><tr><th scope="col">Section</th><th scope="col">Questions</th><th scope="col">Marks each</th><th scope="col">Section total</th>
            <th scope="col">Choice</th><th scope="col">Types</th><th scope="col">Easy/medium/hard</th><th scope="col">Instructions</th></tr></thead>
          <tbody>
            {bp.sections_normalized.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td><td>{s.question_count}</td><td>{s.mpq ?? 'any'}</td><td>{s.total ?? '—'}</td>
                <td>{s.attempt ? `any ${s.attempt} of ${s.question_count}` : '—'}</td>
                <td>{s.types ? s.types.map(typeLabel).join(', ') : 'any'}</td>
                <td>{s.diff ? `${s.diff.easy}/${s.diff.medium}/${s.diff.hard}` : '—'}</td><td>{s.instructions || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">CO targets (questions): {pairs(t.co)}</p>
      <p className="hint">Bloom: {pairs(t.bloom_percentages)}{t.bloom ? ` → ${pairs(t.bloom)} question(s); ${t.bloom_complete ? 'other levels: 0' : 'other levels free'}` : ''}</p>
      {bp.target_notes?.length > 0 && <ul className="hint" style={{ margin: '2px 0 0 18px' }}>{bp.target_notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <p className="hint">Used by {bp.papers.length ? bp.papers.map((p) => `v${p.paper_version} (${String(p.paper_status).replaceAll('_', ' ')})`).join(', ') : 'no paper yet'}.</p>
      <button className="btn-ghost btn-sm" onClick={() => onCopy(bp)}>Copy into editor</button>
    </div>
  );
}

// Result of POST /examinations/:id/feasibility (read-only dry run).
export function FeasibilityResult({ result, onUseSeed }) {
  if (!result) return null;
  const a = result.achieved; const t = result.targets || {};
  const row = (label, target, got) => <tr key={label}><td>{label}</td><td>{target ?? '—'}</td><td>{got ?? 0}</td></tr>;
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <h4 style={{ marginTop: 0 }}>Feasibility: {result.feasible ? 'feasible' : 'not feasible'}{result.code ? ` (${result.code})` : ''}</h4>
      {result.reasons?.length > 0 && <ul style={{ margin: '4px 0 0 18px' }}>{result.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {result.eligible_count != null && <p className="hint">{result.eligible_count} eligible ACTIVE question(s) now.</p>}
      {result.override && (
        <p className="hint">Override {result.override.relax.join('+')}: {result.override.accepted ? 'would be accepted' : `would be refused (${result.override.code}): ${(result.override.reasons || []).join('; ')}`}</p>
      )}
      {result.override_options?.length > 0 && (
        <ul className="hint" style={{ margin: '4px 0 0 18px' }}>
          {result.override_options.map((o) => <li key={o.relax.join()}>{o.feasible ? 'Feasible' : 'Still not feasible'} if the {o.relax.map((d) => (d === 'co' ? 'CO' : 'Bloom')).join(' and ')} targets are relaxed</li>)}
        </ul>
      )}
      {a && (
        <table>
          <thead><tr><th scope="col">Target</th><th scope="col">Wanted</th><th scope="col">Achieved</th></tr></thead>
          <tbody>
            {Object.keys({ ...(t.co || {}), ...(a.co || {}) }).sort().map((k) => row(k, t.co?.[k], a.co?.[k]))}
            {Object.keys({ ...(t.bloom || {}), ...(a.bloom || {}) }).sort().map((k) => row(`Bloom ${k}`, t.bloom?.[k], a.bloom?.[k]))}
            {Object.entries(a.difficulty || {}).map(([k, v]) => row(`Difficulty ${k}`, null, v))}
            {(a.sections || []).map((s) => row(`${s.name} (${s.questions} q)`, null, `${s.marks} marks${s.printed_marks !== s.marks ? ` (${s.printed_marks} printed)` : ''}`))}
            {row('Total marks counted', null, a.total_marks)}
          </tbody>
        </table>
      )}
      {result.target_notes?.length > 0 && <ul className="hint" style={{ margin: '4px 0 0 18px' }}>{result.target_notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {result.note && <p className="hint">{result.note}</p>}
      {result.seed && <p className="hint">Seed {result.seed} <button className="btn-ghost btn-sm" onClick={() => onUseSeed(result.seed)}>Use this seed</button></p>}
    </div>
  );
}
