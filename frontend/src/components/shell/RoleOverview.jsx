import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { QUESTION_STATES } from '../../lib/questionStates';
import { RefreshIcon } from './icons';
import { useAsync } from '../../lib/useAsync';

// The figures at the top of each workspace. Every number is computed from an endpoint the role already uses and is
// authorised for (the server scopes each one); nothing is estimated or sample data. A figure that cannot be loaded
// says so and offers a retry; it never shows a made-up value.

const PAPER_STATES = {
  GENERATING: ['Generating', '#cbd5e1'], GENERATED: ['Generated', '#93c5fd'], VALIDATION_PENDING: ['Under validation', '#3b82f6'],
  CHANGES_REQUIRED: ['Changes required', '#f59e0b'], VALIDATED: ['Validated', '#6366f1'], COE_APPROVED: ['COE approved', '#0ea5e9'],
  PRINT_READY: ['Print-ready', '#15803d'], REGENERATED: ['Regenerated', '#a855f7'], ARCHIVED: ['Archived', '#64748b'], DRAFT: ['Draft', '#94a3b8'],
};
const QUESTION_COLORS = { DRAFT: '#94a3b8', SUBMITTED: '#93c5fd', UNDER_REVIEW: '#3b82f6', RESUBMITTED: '#60a5fa', CHANGES_REQUESTED: '#f59e0b',
  APPROVED: '#6366f1', ACTIVE: '#15803d', RETIRED: '#475569', REJECTED: '#dc2626' };
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sum = (o, keys) => keys.reduce((a, k) => a + n(o?.[k]), 0);

async function questionCounts(token) {
  const r = await api.get('/question-bank/lifecycle?limit=1', token);
  return r && typeof r === 'object' && !Array.isArray(r) && r.counts && typeof r.counts === 'object' ? r.counts : {};
}
const questionPipeline = (counts, title) => ({
  title, unit: 'questions',
  parts: Object.keys(QUESTION_STATES).map((k) => ({ key: k, label: QUESTION_STATES[k].label, value: n(counts[k]), color: QUESTION_COLORS[k] })),
});

// role -> async (token) => { kpis: [{ label, value, note, focus }], pipeline }
const LOADERS = {
  teacher: async (token) => {
    const c = await questionCounts(token);
    return { kpis: [
      { label: 'Needs revision', value: n(c.CHANGES_REQUESTED), note: 'returned to you by a reviewer', focus: true },
      { label: 'Drafts', value: n(c.DRAFT), note: 'not yet submitted' },
      { label: 'With reviewers', value: sum(c, ['SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED']), note: 'submitted or under review' },
      { label: 'Live in the bank', value: n(c.ACTIVE), note: 'available to paper generation' },
    ], pipeline: questionPipeline(c, 'Your questions by lifecycle state') };
  },
  reviewer: async (token) => {
    const c = await questionCounts(token);
    return { kpis: [
      { label: 'Awaiting review', value: sum(c, ['SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED']), note: 'submitted, under review or resubmitted', focus: true },
      { label: 'Approved, not yet live', value: n(c.APPROVED), note: 'pass the quality gate to activate' },
      { label: 'Returned to authors', value: n(c.CHANGES_REQUESTED), note: 'changes asked for' },
      { label: 'Live in the bank', value: n(c.ACTIVE), note: 'available to paper generation' },
    ], pipeline: questionPipeline(c, 'Questions in your scope by lifecycle state') };
  },
  coe: async (token) => {
    const rows = await api.get('/examinations/papers', token);
    const list = Array.isArray(rows) ? rows : [];
    const by = {}; list.forEach((p) => { by[p.paper_status] = (by[p.paper_status] || 0) + 1; });
    return { kpis: [
      { label: 'Ready for your approval', value: n(by.VALIDATED), note: 'validated by the required validators', focus: true },
      { label: 'Under validation', value: n(by.VALIDATION_PENDING), note: 'validators are reviewing' },
      { label: 'Awaiting validators', value: n(by.GENERATED), note: 'generated, assign 4 validators' },
      { label: 'Open validator issues', value: list.reduce((a, p) => a + n(p.open_issues), 0), note: 'resolve before approval' },
    ], pipeline: { title: 'Papers by status', unit: 'papers',
      parts: Object.entries(PAPER_STATES).map(([k, [label, color]]) => ({ key: k, label, value: n(by[k]), color })) } };
  },
  validator: async (token) => {
    const rows = await api.get('/validators/my-validations', token);
    const list = Array.isArray(rows) ? rows : [];
    return { kpis: [
      { label: 'Awaiting your decision', value: list.filter((q) => q.is_active && q.can_open && !q.decision).length, note: 'open the paper to review it', focus: true },
      { label: 'Decisions recorded', value: list.filter((q) => q.decision).length, note: 'final once recorded' },
      { label: 'Ended assignments', value: list.filter((q) => !q.is_active).length, note: 'replaced, regenerated or archived' },
    ], pipeline: null };
  },
  admin: async (token) => {
    const d = await api.get('/admin/system', token);
    const s = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    const total = (rows, key) => (Array.isArray(rows) ? rows.reduce((a, r) => a + n(r[key]), 0) : 0);
    const papers = Array.isArray(s.papers) ? s.papers : [];
    return { kpis: [
      { label: 'Platform readiness', value: s.readiness?.status || 'unknown', note: s.readiness?.failing?.length ? `failing: ${s.readiness.failing.join(', ')}` : 'as reported by the health check', focus: true },
      { label: 'Active accounts', value: total(s.users, 'active'), note: `${total(s.users, 'n')} accounts in total` },
      { label: 'Papers on record', value: total(papers, 'n'), note: 'all statuses' },
      { label: 'Questions on record', value: total(s.questions, 'n'), note: 'all lifecycle states' },
    ], pipeline: { title: 'Papers by status', unit: 'papers',
      parts: Object.entries(PAPER_STATES).map(([k, [label, color]]) => ({ key: k, label, value: n(papers.find((p) => p.paper_status === k)?.n), color })) } };
  },
};
LOADERS.hod = LOADERS.reviewer;

function Pipeline({ title, unit, parts }) {
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((a, p) => a + p.value, 0);
  return (
    <section className="pipeline" aria-label={title}>
      <div className="pipeline-head">{title}<span>{total} {unit}</span></div>
      {total === 0 ? <p className="hint" style={{ margin: 0 }}>Nothing here yet.</p> : (
        <>
          <div className="pipeline-bar" aria-hidden="true">
            {shown.map((p) => <span key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} />)}
          </div>
          <ul className="pipeline-legend">
            {shown.map((p) => <li key={p.key}><i style={{ background: p.color }} />{`${p.label}: ${p.value}`}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

export default function RoleOverview({ role, token, refreshKey = 0 }) {
  const [data, setData] = useState(null);
  const { error, loading: busy, run } = useAsync();
  const load = useCallback(() => run(async () => { const loader = LOADERS[role]; if (loader) setData(await loader(token)); }), [role, token, run]);
  useEffect(() => { load(); }, [load, refreshKey]);
  if (!LOADERS[role]) return null;
  return (
    <section className="ge-overview" aria-label="Overview" aria-busy={busy}>
      {error && (
        <div className="alert alert-warn" role="status">Overview unavailable: {error}{' '}
          <button className="btn-ghost btn-sm" onClick={load}>Retry</button></div>
      )}
      {!data && !error && <p className="hint" role="status">Loading the overview…</p>}
      {data && (
        <>
          <div className="kpi-grid">
            {data.kpis.map((k) => (
              <div key={k.label} className={`kpi${k.focus ? ' focus' : ''}`}>
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.value}</div>
                {k.note && <div className="kpi-note">{k.note}</div>}
              </div>
            ))}
          </div>
          {data.pipeline && <Pipeline {...data.pipeline} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
            <button className="btn-ghost btn-sm" onClick={load} disabled={busy} aria-label="Refresh the overview figures">
              <span style={{ display: 'inline-flex', verticalAlign: '-3px', marginRight: 4 }}><RefreshIcon /></span>{busy ? 'Refreshing' : 'Refresh figures'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
