import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Messages } from './ui';
import { useAsync } from '../lib/useAsync';
import QuestionStatusBadge, { QuestionLifecycleTimeline } from './QuestionStatusBadge';
import { QUESTION_STATES } from '../lib/questionStates';
import QuestionView from './QuestionView';
import CanonicalDetail from './CanonicalDetail';

// Question lifecycle screen (PIVOT_SPEC_V2 §7, §11, §18). The server decides what is allowed
// (roles, scope, reviewer ≠ author, quality gate); these buttons only offer the moves that
// role normally has, and every refusal comes back with its reason.
const NEEDS_REASON = ['CHANGES_REQUESTED', 'REJECTED', 'RETIRED'];

// [target, label, needsReason?]. Submitting and resubmitting are never offered here: they go through
// Write & submit -> Preview (the server's /submit pipeline). Decisions on UNDER_REVIEW questions are applied
// from the question's review batch, after the verdicts (Review workspace -> Review batches); rejection is one
// of them, so a question sent back for changes is never rejected from here.
function actionsFor(role, q) {
  const s = q.question_status;
  if (role === 'teacher') {
    if (s === 'SUBMITTED') return [['DRAFT', 'Withdraw to draft']];
    return [];
  }
  if (role === 'hod') {
    if (s === 'SUBMITTED' || s === 'RESUBMITTED') return [['UNDER_REVIEW', 'Send to review']];
    if (s === 'ACTIVE') return [['RETIRED', 'Retire']];
    if (s === 'RETIRED') return [['ACTIVE', 'Restore', true]];
    return [];
  }
  if (role === 'reviewer' && !q.is_mine) {
    if (s === 'APPROVED') return [['ACTIVE', 'Activate (quality gate)'], ['CHANGES_REQUESTED', 'Request changes']];
    if (s === 'ACTIVE') return [['RETIRED', 'Retire'], ['CHANGES_REQUESTED', 'Request changes']];
    if (s === 'RETIRED') return [['ACTIVE', 'Restore', true]];
  }
  return [];
}

function teacherHint(s) {
  if (s === 'DRAFT') return 'Submit it from Write & submit → Preview, so the attachment scan and duplicate detection run.';
  if (s === 'SUBMITTED') return 'Waiting for the HOD to send it to a reviewer. Withdraw it to Draft if you need to change it.';
  if (s === 'CHANGES_REQUESTED') return 'Use “Revise & resubmit”: edit the question, then Preview → Confirm & Resubmit. It comes back as Resubmitted and the HOD sends it back to review.';
  if (s === 'RESUBMITTED') return 'Your revision is waiting for the HOD to send it back to review.';
  if (s === 'APPROVED') return 'Approved by a reviewer; it becomes usable in papers once it passes the quality gate (Active).';
  return null;
}

function reviewHint(role, q) {
  if (q.question_status !== 'UNDER_REVIEW') return null;
  if (role === 'reviewer') return 'Record your verdict under Review batches. The decision (approve, request changes, reject) is applied there once every reviewer on the batch has completed.';
  if (role === 'hod' && !q.in_review_batch) return 'Not in a review batch yet: add it to one under Review batches so its reviewers can review it.';
  return null;
}

const STATE_LABEL = (s) => QUESTION_STATES[s]?.label || s;
// One line per lifecycle history event (GET /:id/lifecycle normalises them into `event`).
function describe(h) {
  const d = h.details || {};
  switch (h.event) {
    case 'draft_created': return 'Draft created';
    case 'draft_updated': {
      const fields = [...Object.keys(d.metadata_changes || {}), ...(d.content_changed || [])];
      return `Edited${d.question_status === 'CHANGES_REQUESTED' ? ' (revision)' : ''}${fields.length ? `: ${fields.join(', ')}` : ''}`;
    }
    case 'submitted': return d.via === 'bulk_upload' ? 'Submitted for review (bulk upload)' : 'Submitted for review';
    case 'resubmitted': return `Resubmitted${d.version_unchanged ? ' (no content changes)' : d.version_number ? ` as version ${d.version_number}` : ''}`;
    case 'bulk_imported': return `Imported from a spreadsheet as ${STATE_LABEL(d.question_status)}`;
    case 'withdrawn_duplicate': return 'Withdrawn as a duplicate of an existing question';
    case 'co_mapping_changed': return 'Course outcome mapping changed';
    case 'ai_review': return `Automated check (advisory): ${d.issue_count ? `${d.issue_count} possible issue(s)` : 'no issues'}`;
    case 'ai_review_disputed': return 'Author disputed the automated findings (note sent to the HOD)';
    case 'legacy': return `${h.action.replace(/_/g, ' ')} (previous workflow)`;
    default:
      if (!d.from && !d.to) return h.action.replace(/_/g, ' ');
      return `${STATE_LABEL(d.from)} → ${STATE_LABEL(d.to)}${d.restore ? ' (restore)' : ''}${d.reason ? ` (${d.reason})` : ''}`;
  }
}

export default function LifecyclePanel({ token, user, onRevise }) {
  const [status, setStatus] = useState('');
  const [data, setData] = useState({ questions: [], counts: {} });
  const [reasons, setReasons] = useState([]);
  const [pending, setPending] = useState(null); // { id, target, label }
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState({});
  const [canonicalFor, setCanonicalFor] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const msg = useAsync();
  const { run } = msg;

  const load = useCallback(async () => {
    const qs = status ? `?status=${status}` : '';
    setData(await api.get(`/question-bank/lifecycle${qs}`, token));
  }, [status, token]);

  useEffect(() => { run(load); }, [load, run]);
  useEffect(() => { api.get('/question-bank/retirement-reasons', token).then(setReasons).catch(() => setReasons([])); }, [token]);

  async function transition(id, target, why) {
    const done = await msg.run(
      () => api.post(`/question-bank/${id}/transition`, { target_status: target, reason: why || undefined }, token),
      `Moved to ${QUESTION_STATES[target]?.label || target}`,
    );
    if (done) { setPending(null); setReason(''); await load(); }
  }

  // Export what this screen lists (same scope rules on the server), in the bulk import layout.
  async function exportList() {
    const qs = status ? `?status=${status}` : '';
    await msg.run(() => api.download(`/question-bank/export${qs}`, token, `questions${status ? `-${status.toLowerCase()}` : ''}.xlsx`), 'Exported to Excel (the bulk-upload layout)');
  }

  async function toggleHistory(id) {
    if (history[id]) { setHistory({ ...history, [id]: null }); return; }
    const h = await msg.run(() => api.get(`/question-bank/${id}/lifecycle`, token));
    // audit_log.details may come back as JSON text depending on the column type.
    const parse = (d) => { if (typeof d !== 'string') return d || {}; try { return JSON.parse(d); } catch { return {}; } };
    if (h) setHistory({ ...history, [id]: (h.audit_trail || []).map((e) => ({ ...e, details: parse(e.details) })) });
  }

  const total = Object.values(data.counts || {}).reduce((a, b) => a + b, 0);
  return (
    <div>
      <p className="hint">
        {user.role === 'teacher' && 'Where each of your questions is in review.'}
        {user.role === 'reviewer' && 'Questions in the offerings you are assigned to (never your own). Only Active questions can be used in examination papers.'}
        {user.role === 'hod' && 'Questions in your department. Send submissions to review, and retire or restore active questions.'}
        {' '}Each question shows its type, answer key, model answer and diagrams; collapse the ones you have read.
      </p>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0' }} role="group" aria-label="Filter by status">
        <button className={`btn-sm ${status === '' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setStatus('')}>All ({total})</button>
        {Object.entries(QUESTION_STATES).filter(([k]) => user.role === 'teacher' || k !== 'DRAFT').map(([k, v]) => (
          <button key={k} className={`btn-sm ${status === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setStatus(k)}>
            {v.label} ({data.counts?.[k] || 0})
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <button className="btn-ghost btn-sm" style={{ flex: 'none' }} onClick={exportList}>Export {status ? QUESTION_STATES[status]?.label || status : 'all'} to Excel</button>
      </div>
      <Messages error={msg.error} reasons={msg.reasons} ok={msg.ok} />
      {msg.loading && data.questions.length === 0 && <p className="hint" role="status">Loading…</p>}

      {!msg.loading && data.questions.length === 0 && <div className="empty-state">No questions here.</div>}
      {data.questions.map((q) => {
        const acts = actionsFor(user.role, q);
        const hint = user.role === 'teacher' ? teacherHint(q.question_status) : reviewHint(user.role, q);
        return (
          <div key={q.id} className="list-item" style={{ display: 'block' }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <div style={{ flex: 1 }}>
                {!collapsed[q.id]
                  ? <QuestionView q={q} token={token} fileUrl={(a) => `/attachments/${a.id}/file`} />
                  : <div style={{ whiteSpace: 'pre-wrap' }}>{q.question_text.length > 300 ? `${q.question_text.slice(0, 300)}…` : q.question_text}</div>}
              </div>
              <QuestionStatusBadge status={q.question_status} />
            </div>
            <div className="hint">
              {[q.subject_code, q.offering_code, q.difficulty, q.bloom_level, q.marks != null && `${q.marks} marks`, q.topic && `topic: ${q.topic}`,
                q.author_email && `by ${q.author_email}`, q.times_used > 0 && `used ${q.times_used}×`].filter(Boolean).join(' · ')}
            </div>
            <div style={{ margin: '6px 0' }}><QuestionLifecycleTimeline status={q.question_status} /></div>
            {q.retirement_reason && <div className="hint">Retired: {q.retirement_reason}</div>}
            {q.change_request_reason && q.question_status === 'CHANGES_REQUESTED' && (
              <div className="alert alert-warn">
                Reviewer asked for changes{q.change_requested_at ? ` (${new Date(q.change_requested_at).toLocaleDateString()})` : ''}: {q.change_request_reason}
              </div>
            )}
            {q.change_request_reason && ['RESUBMITTED', 'UNDER_REVIEW'].includes(q.question_status) && (
              <div className="hint">Earlier change request: {q.change_request_reason}</div>
            )}
            {hint && <div className="hint">{hint}</div>}

            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {user.role === 'teacher' && q.question_status === 'CHANGES_REQUESTED' && onRevise && (
                <button className="btn-primary btn-sm" onClick={() => onRevise(q.id)}>Revise &amp; resubmit</button>
              )}
              {acts.map(([target, label, needsReason]) => (
                <button key={target} className={target === 'REJECTED' ? 'btn-danger btn-sm' : 'btn-ghost btn-sm'}
                  onClick={() => ((needsReason ?? NEEDS_REASON.includes(target)) ? setPending({ id: q.id, target, label }) : transition(q.id, target))}>
                  {label}
                </button>
              ))}
              <button className="btn-ghost btn-sm" onClick={() => setCollapsed({ ...collapsed, [q.id]: !collapsed[q.id] })}>
                {collapsed[q.id] ? `Full question${q.attachments?.length ? ` (${q.attachments.length} file${q.attachments.length > 1 ? 's' : ''})` : ''}` : 'Collapse'}
              </button>
              <button className="btn-ghost btn-sm" onClick={() => toggleHistory(q.id)}>{history[q.id] ? 'Hide history' : 'History'}</button>
              {q.question_status !== 'DRAFT' && (
                <button className="btn-ghost btn-sm" onClick={() => setCanonicalFor(canonicalFor === q.id ? null : q.id)}>{canonicalFor === q.id ? 'Hide canonical record' : 'Canonical record'}</button>
              )}
            </div>

            {pending?.id === q.id && (
              <div className="card" style={{ marginTop: 8 }}>
                <div className="field">
                  <label htmlFor={`reason-${q.id}`}>Reason ({pending.label.toLowerCase()}) — recorded in the audit log</label>
                  {pending.target === 'RETIRED' ? (
                    <select id={`reason-${q.id}`} value={reason} onChange={(e) => setReason(e.target.value)}>
                      <option value="">Select a reason…</option>
                      {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <input id={`reason-${q.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
                  )}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn-primary btn-sm" disabled={reason.trim().length < 3} onClick={() => transition(q.id, pending.target, reason.trim())}>Confirm</button>
                  <button className="btn-ghost btn-sm" onClick={() => { setPending(null); setReason(''); }}>Cancel</button>
                </div>
              </div>
            )}

            {canonicalFor === q.id && <CanonicalDetail token={token} questionId={q.id} />}

            {history[q.id] && (
              <ul className="hint" style={{ margin: '6px 0 0 18px' }}>
                {history[q.id].length === 0 && <li>No history recorded yet.</li>}
                {history[q.id].map((h, i) => (
                  <li key={i}>{new Date(h.created_at).toLocaleString()} — {describe(h)}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
