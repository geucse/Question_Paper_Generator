import { useEffect, useState } from 'react';
import { api } from '../api';
import { Messages, Pending } from './ui';
import { useAsync } from '../lib/useAsync';

// Dataset quality / coverage for HOD and reviewers (spec section 17), within the caller's scope (server-side).
// Coverage is measured on ACTIVE questions, because only those can reach a paper. CO, unit and topic codes repeat
// across offerings, so those figures are shown per offering; Bloom, CO, topic and subtopic are split into
// reviewer-verified and unverified (a teacher's or the AI's suggestion). Generation readiness (042): only ACTIVE
// questions with a reviewer-verified topic, CO and Bloom level on the offering's current syllabus reach a new paper.
export default function AnalyticsPanel({ token }) {
  const [d, setD] = useState(null);
  const [offerings, setOfferings] = useState([]);
  const [offering, setOffering] = useState('');
  const { error, loading, run } = useAsync();
  useEffect(() => {
    api.get('/academic/course-offerings', token).then(setOfferings).catch(() => setOfferings([]));
  }, [token]);
  useEffect(() => {
    run(async () => setD(await api.get(`/question-bank/analytics${offering ? `?course_offering_id=${offering}` : ''}`, token)));
  }, [token, offering, run]);

  const picker = (
    <div className="field" style={{ maxWidth: 480 }}>
      <label htmlFor="analytics-offering">Course offering</label>
      <select id="analytics-offering" value={offering} onChange={(e) => setOffering(e.target.value)}>
        <option value="">All offerings in your scope</option>
        {offerings.map((o) => <option key={o.course_offering_id} value={o.course_offering_id}>{o.subject_code} — {o.course_title} ({o.academic_session_label}, sem {o.semester})</option>)}
      </select>
    </div>
  );
  if (!d) return <div>{picker}<Pending error={error} what="analytics" /></div>;

  const list = (title, rows, render = (r) => <><span>{r.key ?? 'unmapped'}</span>: <strong>{r.n}</strong></>) => (
    <div className="card"><h4>{title}</h4>
      {rows.length === 0 ? <div className="hint">No data yet.</div> : rows.map((r, i) => <div key={`${r.offering_id || ''}-${r.key ?? 'none'}-${i}`} className="list-item">{render(r)}</div>)}
    </div>
  );
  const split = (r) => <><span>{r.key ?? 'unmapped'}</span>: <strong>{r.n}</strong> <span className="hint">({r.verified} verified, {r.unverified} unverified)</span></>;
  const byOffering = (title, rows, render) => {
    const groups = [...new Set(rows.map((r) => r.offering_id))];
    return (
      <div className="card"><h4>{title}</h4>
        {rows.length === 0 && <div className="hint">No data yet.</div>}
        {groups.map((g) => {
          const rs = rows.filter((r) => r.offering_id === g);
          return (
            <div key={g} style={{ marginBottom: 6 }}>
              {groups.length > 1 && <div className="hint" style={{ fontWeight: 600 }}>{rs[0].offering_code || 'offering'}</div>}
              {rs.map((r, i) => <div key={`${r.key ?? 'none'}-${i}`} className="list-item">{render(r)}</div>)}
            </div>
          );
        })}
      </div>
    );
  };
  const verifiedTopic = (r) => <><span>{r.key ?? 'no topic'}</span>: <strong>{r.n}</strong> <span className="hint">({r.verified} reviewer-verified, {r.unverified ?? r.n - r.verified} unverified)</span></>;
  const subtopicRow = (r) => <><span>{r.topic ?? 'no topic'} › {r.key}</span>: <strong>{r.n}</strong> <span className="hint">({r.verified} verified, {r.unverified} unverified)</span></>;
  const ready = d.generation_readiness || { active_total: 0, generation_eligible: 0, not_eligible_unverified: 0, not_eligible_other_version: 0 };
  const plain = (r) => <><span>{r.key ?? 'unmapped'}</span>: <strong>{r.n}</strong></>;

  return (
    <div>
      {picker}
      {loading && <p className="hint" role="status">Refreshing…</p>}
      <Messages error={error} reasons={[]} ok="" />
      <div className="card">
        <h4>Generation readiness (ACTIVE questions)</h4>
        <div className="list-item">Usable by a new paper: <strong>{ready.generation_eligible}</strong> of {ready.active_total}</div>
        <div className="list-item">Not usable, mapping not reviewer-verified (topic, CO or Bloom): <strong>{ready.not_eligible_unverified}</strong></div>
        <div className="list-item">Not usable, left on an earlier syllabus version: <strong>{ready.not_eligible_other_version}</strong></div>
        {(ready.not_eligible_unverified > 0 || ready.not_eligible_other_version > 0) && (
          <p className="hint">The HOD maps these under Manage academics → Question mapping, or a reviewer re-reviews them.</p>
        )}
      </div>
      <div className="grid-2">
        {list('Questions by status', d.by_status)}
        {list('ACTIVE by difficulty', d.active_by_difficulty)}
        {list('ACTIVE by Bloom level', d.active_by_bloom, split)}
        {byOffering('ACTIVE by course outcome', d.active_by_co, split)}
        {byOffering('ACTIVE by unit (reviewer-verified)', d.active_by_unit, plain)}
        {byOffering('ACTIVE by topic', d.active_by_topic || [], verifiedTopic)}
        {byOffering('ACTIVE by subtopic', d.active_by_subtopic || [], subtopicRow)}
        {list('ACTIVE by type', d.active_by_type)}
        <div className="card"><h4>Usage &amp; duplicates</h4>
          <div className="list-item">Never used: <strong>{d.usage.never_used}</strong> of {d.usage.active_total}</div>
          <div className="list-item">Used in last 180 days: <strong>{d.usage.used_last_180_days}</strong></div>
          <div className="list-item">Duplicate candidates awaiting review: <strong>{d.duplicate_candidates}</strong></div>
        </div>
      </div>
      <Matrix title="Coverage gaps: Unit × Difficulty" rows={d.coverage.unit_x_difficulty} cols={['easy', 'medium', 'hard']} />
      <Matrix title="Coverage gaps: CO × Bloom" rows={d.coverage.co_x_bloom} cols={['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']} />
    </div>
  );
}

// One table per offering: equal codes of different offerings (two "CO1"s) are different rows of different tables.
function Matrix({ title, rows, cols }) {
  const offerings = [...new Set(rows.map((r) => r.offering_id))];
  return (
    <div className="card" style={{ overflowX: 'auto' }}><h4>{title}</h4>
      {offerings.length === 0 && <div className="hint">No ACTIVE questions mapped yet.</div>}
      {offerings.map((o) => {
        const rs = rows.filter((r) => r.offering_id === o);
        const names = [...new Set(rs.map((r) => r.row))];
        const get = (a, b) => rs.find((r) => r.row === a && r.col === b)?.n || 0;
        return (
          <div key={o} style={{ marginBottom: 10 }}>
            {offerings.length > 1 && <div className="hint" style={{ fontWeight: 600 }}>{rs[0].offering_code || 'offering'}</div>}
            <table style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={{ textAlign: 'left', padding: 4 }} />{cols.map((c) => <th key={c} style={{ padding: 4 }}>{c}</th>)}</tr></thead>
              <tbody>{names.map((n) => (
                <tr key={n}><td style={{ padding: 4 }}>{n}</td>
                  {cols.map((c) => { const v = get(n, c); return <td key={c} style={{ padding: 4, textAlign: 'center', background: v === 0 ? 'rgba(220,60,60,.18)' : 'transparent' }}>{v === 0 ? '0 (gap)' : v}</td>; })}
                </tr>))}
              </tbody>
            </table>
          </div>
        );
      })}
      <p className="hint">Cells marked “0 (gap)” have no ACTIVE question: generation needing that combination will fail.</p>
    </div>
  );
}
