import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Messages, Pending, Tabs } from '../../components/ui';
import { useAsync } from '../../lib/useAsync';
import UserManagement from '../../components/UserManagement';

// Technical dashboard only: system health and protections, accounts and access scopes, emergency override.
// There is intentionally nothing here that approves or edits academic content.
export default function AdminDashboard({ token, user, legacy }) {
  const [tab, setTab] = useState('system');
  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>Technical administration only: nothing on these screens approves or edits academic content.</p>
      <Tabs tabs={[['system', 'System'], ['accounts', 'Accounts'], ['scopes', 'Access scopes'], ['policy', 'Validation policy'], ['override', 'Emergency override'], ['structure', 'Structure & security']]} active={tab} onChange={setTab} primary />
      {tab === 'system' && <System token={token} />}
      {tab === 'accounts' && <UserManagement token={token} user={user} />}
      {tab === 'policy' && <><ValidationPolicy token={token} /><ValidatorIndependence token={token} /></>}
      {tab === 'scopes' && <Scopes token={token} />}
      {tab === 'override' && <Override token={token} />}
      {tab === 'structure' && legacy}
    </div>
  );
}

const TOKEN_TEXT = { ok: 'ok', fail: 'failing', unavailable: 'unavailable', not_configured: 'not configured', missing: 'missing', development_key: 'development key' };

// What protects the system right now, as /api/health/ready reports it (never what is merely configured).
function Protections({ readiness }) {
  if (!readiness) return null;
  return (
    <div className="card"><h4>Protections</h4>
      <div className="list-item">Readiness: <strong>{readiness.status}</strong>{readiness.failing?.length ? ` (failing: ${readiness.failing.join(', ')})` : ''}</div>
      {Object.entries(readiness.protections || {}).map(([k, v]) => <div key={k} className="list-item">{k.replaceAll('_', ' ')}: <strong>{v}</strong></div>)}
      {Object.entries(readiness.checks || {}).map(([k, v]) => <div key={k} className="list-item hint">{k.replaceAll('_', ' ')}: {TOKEN_TEXT[v] || v}</div>)}
    </div>
  );
}

// Upload scanning: counts only (which files or questions is academic content the admin never sees).
function UploadScanning({ token, counts, onDone }) {
  const [result, setResult] = useState(null);
  const { error, run } = useAsync();
  const pending = (counts || []).filter((c) => c.scan_status !== 'clean').reduce((n, c) => n + c.n, 0);
  return (
    <div className="card"><h4>Upload scanning</h4>
      {(counts || []).length === 0 && <div className="hint">No attachments yet.</div>}
      {(counts || []).map((c) => <div key={c.scan_status} className="list-item">{c.scan_status}: <strong>{c.n}</strong></div>)}
      <p className="hint">Files the virus scanner could not check stay quarantined and unusable until they scan clean.</p>
      <Messages error={error} reasons={[]} ok="" />
      {result && <div className="alert alert-ok">Rescanned {result.scanned}: {result.clean} clean, {result.infected} infected (removed), {result.failed} still failing, {result.missing} missing.</div>}
      <button className="btn-primary btn-sm" disabled={pending === 0} onClick={() => run(async () => { setResult(await api.post('/admin/attachments/rescan', { limit: 25 }, token)); await onDone(); })}>
        Rescan unscanned uploads
      </button>
    </div>
  );
}

function System({ token }) {
  const [d, setD] = useState(null);
  const { error, run } = useAsync();
  const load = useCallback(() => run(async () => setD(await api.get('/admin/system', token))), [token, run]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <Pending error={error} what="the system status" />;
  const table = (rows, a, b) => rows.map((r) => <div key={r[a]} className="list-item">{r[a]}: <strong>{r[b]}</strong></div>);
  return (
    <div className="grid-2">
      <div className="card"><h4>Users by role</h4>{d.users.map((u) => <div key={u.role} className="list-item">{u.role}: <strong>{u.active}</strong> active / {u.n}</div>)}</div>
      <div className="card"><h4>Papers by status</h4>{table(d.papers, 'paper_status', 'n')}</div>
      <div className="card"><h4>Questions by status</h4>{table(d.questions, 'question_status', 'n')}</div>
      <div className="card"><h4>Platform</h4>
        <div className="list-item">Migrations applied: <strong>{d.migrations?.n}</strong></div>
        <div className="list-item">Lockdown: <strong>{d.lockdown?.value === '1' ? 'ACTIVE (non-admin changes paused)' : 'off'}</strong></div>
      </div>
      <Protections readiness={d.readiness} />
      <UploadScanning token={token} counts={d.attachments} onDone={load} />
      <div className="card" style={{ gridColumn: '1 / -1' }}><h4>Recent authorization denials</h4>
        {d.recent_denials.length === 0 && <div className="hint">None.</div>}
        {d.recent_denials.map((r, i) => <div key={i} className="list-item mono">{new Date(r.created_at).toLocaleString()} · {r.action} · {r.reason}</div>)}</div>
    </div>
  );
}

function Scopes({ token }) {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ user_id: '', role: 'hod', campus_id: '', department_id: '', program_id: '' });
  const { error, ok, run } = useAsync();
  const load = useCallback(() => run(async () => setRows(await api.get('/admin/scopes', token))), [token, run]);
  useEffect(() => { load(); }, [load]);
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
  return (
    <div>
      <Messages error={error} reasons={[]} ok={ok} />
      <div className="card"><h4>Grant scope</h4>
        <p className="hint">A user can only act inside campuses/departments they hold a scope for. IDs come from the academic hierarchy. An HOD scope covers a whole department (leave program_id empty). Teacher scopes come only from course assignments made by the HOD; they end when the HOD ends the assignment or the account is deactivated.</p>
        <div className="grid-2">
          {['user_id', 'campus_id', 'department_id', 'program_id'].map((k) => (
            <div className="field" key={k}><label>{k}</label><input className="mono" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
          ))}
          <div className="field"><label>role</label>
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['hod', 'reviewer', 'coe', 'validator', 'admin'].map((r) => <option key={r}>{r}</option>)}</select></div>
        </div>
        <button className="btn-primary" onClick={() => run(async () => { await api.post('/admin/scopes', clean(f), token); await load(); }, 'Scope granted')}>Grant</button>
      </div>
      {rows.map((s) => (
        <div key={s.id} className="list-item row" style={{ justifyContent: 'space-between' }}>
          <span>{s.email} · <strong>{s.role}</strong> <span className="hint mono">campus {s.campus_id?.slice(0, 8) || '—'} dept {s.department_id?.slice(0, 8) || '—'}{s.program_id ? ` program ${s.program_id.slice(0, 8)}` : ''}{s.course_offering_id ? ` offering ${s.course_offering_id.slice(0, 8)}` : ''}</span></span>
          {s.role === 'teacher'
            ? <span className="hint">from a course assignment (HOD)</span>
            : <button className="btn-ghost btn-sm" onClick={() => run(async () => { await api.del(`/admin/scopes/${s.id}`, token); await load(); }, 'Scope revoked')}>Revoke</button>}
        </div>
      ))}
    </div>
  );
}

// Spec §27: "All 4 must approve" by default, configurable. Configuration only — it approves nothing,
// and a paper keeps the threshold that applied when its validators were assigned.
function ValidationPolicy({ token }) {
  const [current, setCurrent] = useState(null);
  const [value, setValue] = useState(4);
  const [reason, setReason] = useState('');
  const { error, ok, run } = useAsync();
  const load = useCallback(() => run(async () => {
    const p = await api.get('/admin/settings/validation-policy', token);
    setCurrent(p); setValue(p.required_approvals);
  }), [token, run]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="card">
      <h4>Validator approvals required per paper</h4>
      <p className="hint">Every paper has exactly 4 validators. By default all 4 must approve. Changes apply only to papers whose validators are assigned afterwards.</p>
      <Messages error={error} reasons={[]} ok={ok} />
      {current && <p>Current: <strong>{current.required_approvals} of 4</strong>{current.updated_at ? ` (since ${new Date(current.updated_at).toLocaleString()})` : ''}</p>}
      <div className="grid-2">
        <div className="field"><label htmlFor="req-approvals">Required approvals</label>
          <select id="req-approvals" value={value} onChange={(e) => setValue(Number(e.target.value))}>
            <option value={4}>4 of 4 (default)</option>
            <option value={3}>3 of 4</option>
          </select></div>
        <div className="field"><label htmlFor="policy-reason">Reason (at least 10 characters, audited)</label>
          <input id="policy-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <button className="btn-primary" disabled={reason.trim().length < 10 || value === current?.required_approvals}
        onClick={() => run(async () => { await api.put('/admin/settings/validation-policy', { required_approvals: value, reason: reason.trim() }, token); setReason(''); await load(); }, 'Policy updated')}>Save</button>
    </div>
  );
}

// Spec §27 optional rule: a validator must not have reviewed any question in the paper.
function ValidatorIndependence({ token }) {
  const [current, setCurrent] = useState(null);
  const [reason, setReason] = useState('');
  const { error, ok, run } = useAsync();
  const load = useCallback(() => run(async () => setCurrent(await api.get('/admin/settings/validator-independence', token))), [token, run]);
  useEffect(() => { load(); }, [load]);
  if (!current) return null;
  const next = !current.exclude_question_reviewers;
  return (
    <div className="card">
      <h4>Validator independence</h4>
      <p className="hint">Always enforced: a validator is never the COE or the author of a question in the paper. Optionally, also refuse validators who reviewed or approved any question in the paper.</p>
      <Messages error={error} reasons={[]} ok={ok} />
      <p>Currently: <strong>{current.exclude_question_reviewers ? 'reviewers of the paper\'s questions are refused' : 'reviewers may validate'}</strong></p>
      <div className="field"><label htmlFor="vi-reason">Reason (at least 10 characters, audited)</label>
        <input id="vi-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <button className="btn-primary" disabled={reason.trim().length < 10}
        onClick={() => run(async () => { await api.put('/admin/settings/validator-independence', { exclude_question_reviewers: next, reason: reason.trim() }, token); setReason(''); await load(); }, 'Policy updated')}>
        {next ? 'Refuse reviewers as validators' : 'Allow reviewers as validators'}
      </button>
    </div>
  );
}

function Override({ token }) {
  const [paperId, setPaperId] = useState('');
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState(null);
  const { error, ok, run } = useAsync();
  const loadHistory = useCallback(() => run(async () => setHistory(await api.get('/admin/overrides', token))), [token, run]);
  useEffect(() => { loadHistory(); }, [loadHistory]);
  return (
    <>
    <div className="card">
      <h4>Reset a stuck paper</h4>
      <div className="alert alert-warn">For corrupted or blocked records only (e.g. validators left the organisation). It ends the current validator round (kept as history) and returns the paper to GENERATED so the COE repeats the normal workflow. It never approves anything, cannot touch PRINT_READY papers, and never overturns a CHANGES_REQUIRED verdict (a CHANGES_REQUIRED paper, or a round where a validator already asked for changes, is refused: the COE regenerates or archives it). Every use is recorded.</div>
      <Messages error={error} reasons={[]} ok={ok} />
      <div className="field"><label>Paper ID</label><input className="mono" value={paperId} onChange={(e) => setPaperId(e.target.value)} /></div>
      <div className="field"><label>Reason (min. 10 characters)</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <button className="btn-danger" disabled={!paperId || reason.trim().length < 10}
        onClick={() => run(async () => { await api.post('/admin/overrides/reset-paper', { paper_id: paperId, reason }, token); await loadHistory(); }, 'Paper reset to GENERATED')}>Apply override</button>
    </div>
    <div className="card"><h4>Override history (last 100)</h4>
      {history === null && !error && <p className="hint" role="status">Loading…</p>}
      {history?.length === 0 && <p className="hint">No override has been used.</p>}
      {(history || []).map((o) => (
        <div key={o.id} className="list-item" style={{ display: 'block' }}>
          <strong>{String(o.action).replaceAll('_', ' ')}</strong>
          {' '}<span className="hint">{new Date(o.created_at).toLocaleString()}</span>
          <div className="hint mono">{o.entity_type} {o.entity_id}</div>
          {o.reason && <div className="hint">Reason: {o.reason}</div>}
        </div>
      ))}
    </div>
    </>
  );
}
