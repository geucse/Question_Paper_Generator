import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import TotpSetup from './components/TotpSetup';
import QuestionStatusBadge from './components/QuestionStatusBadge';
import UserManagement from './components/UserManagement';
import QuestionView from './components/QuestionView';
import CanonicalDetail from './components/CanonicalDetail';
import { typeLabel } from './lib/questionTypes';
import { SyllabusPicker } from './components/SyllabusPicker';
import { QuestionMapping, ReviewerSyllabusChanges, SyllabusChangeReport } from './components/SyllabusChanges';
import { SYLLABUS_STATUS, syllabusSource } from './lib/syllabus';
import { REVIEW_CHECKLIST } from './lib/reviewChecklist';
import { SyllabusUpload, SourcePdfButton, SyllabusSteps } from './components/SyllabusUpload';


export default function ReviewerDashboard({ token, user }) {
  const [tab, setTab] = useState(user.role === 'reviewer' ? 'dashboard' : user.role === 'hod' ? 'queue' : 'manage');
  return (
    <div>
      <div className="tabs">
        {user.role === 'reviewer' && <button className={`tab ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>Dashboard</button>}
        {user.role === 'reviewer' && <button className={`tab ${tab === 'syllabus' ? 'active' : ''}`} onClick={() => setTab('syllabus')}>Syllabus changes</button>}
        {user.role === 'hod' && <button className={`tab ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')}>Attention</button>}
        {(user.role === 'hod' || user.role === 'reviewer') && <button className={`tab ${tab === 'batches' ? 'active' : ''}`} onClick={() => setTab('batches')}>Review batches</button>}
        {user.role === 'hod' && <button className={`tab ${tab === 'mistakes' ? 'active' : ''}`} onClick={() => setTab('mistakes')}>Mistake detection</button>}
        {(user.role === 'hod' || user.role === 'admin') && <button className={`tab ${tab === 'manage' ? 'active' : ''}`} onClick={() => setTab('manage')}>Manage academics</button>}
        {user.role === 'admin' && <button className={`tab ${tab === 'security' ? 'active' : ''}`} onClick={() => setTab('security')}>Security & audit</button>}
        {user.role === 'admin' && <button className={`tab ${tab === 'secops' ? 'active' : ''}`} onClick={() => setTab('secops')}>Threat monitor</button>}
        <button className={`tab ${tab === 'totp' ? 'active' : ''}`} onClick={() => setTab('totp')}>Authenticator setup</button>
      </div>
      {tab === 'dashboard' && <ReviewerHome token={token} onOpenBatches={() => setTab('batches')} />}
      {tab === 'syllabus' && <ReviewerSyllabusChanges token={token} user={user} />}
      {tab === 'batches' && <ReviewBatches token={token} user={user} />}
      {tab === 'queue' && <EscalationQueue token={token} />}
      {tab === 'mistakes' && <MistakeDetection token={token} />}
      {tab === 'manage' && <ManageAcademics token={token} user={user} />}
      {tab === 'security' && <SecurityAudit token={token} />}
      {tab === 'secops' && <ThreatMonitor token={token} />}
      {tab === 'totp' && <TotpSetup token={token} user={user} purpose="Optional second factor for your account." />}
    </div>
  );
}

// ---- Review batches: real multi-reviewer academic workflow (replaces the
// retired single accept/flag opinion (POST /questions/:id/reviewer-verdict now returns 410) with independent per-reviewer verdicts
// on difficulty/Bloom/CO, explicit disagreement surfacing, and an explicit
// HOD resolution step — see backend/src/routes/review-batches.js; admin is technical-only and has no part). ----
const BLOOM_LEVELS_RB = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];

function ReviewBatches({ token, user }) {
  const [batches, setBatches] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState(null);

  // Never rejects (the error is shown).
  const load = useCallback(() => api.get('/review/batches', token)
    .then(setBatches, (e) => setError(e.message)), [token]);
  useEffect(() => { load(); }, [load]);

  const canManage = user.role === 'hod';

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      {!selectedId && (
        <div>
          {canManage && (
            <div style={{ marginBottom: 16 }}>
              <button className="btn-primary btn-sm" onClick={() => setShowCreate(!showCreate)}>
                {showCreate ? 'Cancel' : '+ Create review batch'}
              </button>
              {showCreate && (
                <CreateReviewBatch token={token} onCreated={(id) => { setShowCreate(false); load(); setSelectedId(id); }} />
              )}
            </div>
          )}

          <h3 className="section-title">{user.role === 'reviewer' ? 'Batches assigned to you' : 'All review batches'}</h3>
          {batches.length === 0 && <div className="empty-state">No review batches yet.</div>}
          {batches.map(b => (
            <div className="list-item" key={b.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(b.id)}>
              <div>
                <div><strong>{b.title}</strong> {b.offering_code ? `— ${b.offering_code}` : ''}</div>
                <div className="meta">
                  {user.role === 'reviewer'
                    ? `Your status: ${b.my_status}`
                    : `${b.question_count ?? ''} question(s) · ${b.reviewer_count ?? ''} reviewer(s)`}
                  {b.due_at ? ` · Due ${new Date(b.due_at).toLocaleDateString()}` : ''}
                </div>
              </div>
              <span className={`badge ${b.status === 'closed' || b.status === 'review_complete' ? 'badge-approved' : 'badge-pending'}`}>{b.status.replace(/_/g, ' ')}</span>
            </div>
          ))}
        </div>
      )}

      {selectedId && (
        <BatchDetail token={token} user={user} batchId={selectedId} onBack={() => { setSelectedId(null); load(); }} />
      )}
    </div>
  );
}

function CreateReviewBatch({ token, onCreated }) {
  const [offerings, setOfferings] = useState([]);
  const [offeringId, setOfferingId] = useState('');
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/academic/course-offerings', token).then(rows => {
      setOfferings(rows);
      if (rows.length > 0) setOfferingId(rows[0].course_offering_id);
    }).catch(e => setError(e.message));
  }, [token]);

  async function create() {
    setError(null);
    try {
      const res = await api.post('/review/batches', {
        course_offering_id: offeringId, title, due_at: dueAt || null
      }, token);
      onCreated(res.id);
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="card" style={{ marginTop: 12, background: '#f8f9fc' }}>
      <p className="hint" style={{ marginBottom: 8 }}>
        Defaults to every submitted or resubmitted question in the chosen offering that is not already in an open batch.
        Creating the batch sends those questions to review; assign reviewers next.
      </p>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="field">
        <label>Course offering</label>
        <select value={offeringId} onChange={e => setOfferingId(e.target.value)}>
          {offerings.map(o => <option key={o.course_offering_id} value={o.course_offering_id}>{o.subject_code} — {o.course_title} ({o.academic_session_label}, sem {o.semester})</option>)}
        </select>
      </div>
      <div className="row">
        <div className="field"><label>Title</label><input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Mid-Sem Review Round 1" /></div>
        <div className="field"><label>Due date (optional)</label><input type="date" value={dueAt} onChange={e => setDueAt(e.target.value)} /></div>
      </div>
      <button className="btn-primary btn-sm" onClick={create} disabled={!offeringId || !title}>Create batch</button>
    </div>
  );
}

function BatchDetail({ token, user, batchId, onBack }) {
  const [detail, setDetail] = useState(null);
  // Syllabus trees by version (042): each question is verified against its OWN syllabus version, which may be an
  // earlier one than the offering's current version (a question in review when a new version was approved).
  const [trees, setTrees] = useState({});
  const [reviewerAssignments, setReviewerAssignments] = useState([]);
  const [selectedReviewers, setSelectedReviewers] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [completeForm, setCompleteForm] = useState({ reviewer_summary: '', recommendation: '', recommendation_score: '' });
  const [replaceWith, setReplaceWith] = useState({});

  const canManage = user.role === 'hod';

  // The batch first (shown as soon as it arrives), then the syllabus trees, then (HOD) the reviewer assignments.
  // Never rejects (the error is shown).
  const load = useCallback(() => api.get(`/review/batches/${batchId}`, token)
    .then(async (d) => {
      setDetail(d);
      const current = await api.get(`/academic/course-offerings/${d.batch.course_offering_id}/syllabus-tree`, token).catch(() => null);
      const next = { current };
      for (const v of [...new Set(d.questions.map((it) => it.question.syllabus_version_id).filter(Boolean))]) {
        next[v] = v === current?.syllabus_version_id ? current : await api.get(`/academic/syllabus-versions/${v}/tree`, token).catch(() => null);
      }
      setTrees(next);
      if (canManage) {
        const ras = await api.get(`/academic/assignments/reviewer?course_offering_id=${d.batch.course_offering_id}`, token).catch(() => []);
        setReviewerAssignments(ras);
      }
    })
    .catch((e) => setError(e.message)), [batchId, token, canManage]);
  useEffect(() => { load(); }, [load]);

  async function assignReviewers() {
    setError(null); setNotice(null);
    try {
      const res = await api.post(`/review/batches/${batchId}/assign`, { reviewer_assignment_ids: selectedReviewers }, token);
      const skipped = res.skipped || [];
      setNotice(skipped.length
        ? `${res.reviewers_notified} reviewer(s) assigned and notified. ${skipped.length} skipped: their assignment ended, the account is inactive, or the reviewer is outside this offering's department.`
        : 'Reviewers assigned and notified.');
      setSelectedReviewers([]);
      await load();
    } catch (e) { setError(e.message); }
  }

  // Replace a reviewer who has not completed (late, on leave, or whose assignment ended): the old seat is kept
  // as history (revoked) and the new reviewer is notified.
  async function replaceReviewer(seat) {
    const next = replaceWith[seat.id];
    if (!next) return;
    const reason = prompt('Reason for replacing this reviewer (kept in the audit log):', seat.assignment_active === false ? 'Reviewer assignment ended' : '');
    if (reason === null) return;
    setError(null); setNotice(null);
    try {
      await api.post(`/review/batches/${batchId}/reassign`, { old_reviewer_assignment_id: seat.reviewer_assignment_id, new_reviewer_assignment_id: next, reason }, token);
      setNotice('Reviewer replaced and notified.');
      setReplaceWith({ ...replaceWith, [seat.id]: '' });
      await load();
    } catch (e) { setError(e.message); }
  }

  // A reviewer completes the batch once every question has their verdict; decisions are applied after
  // every reviewer on the batch has completed.
  async function completeReview() {
    setError(null); setNotice(null);
    try {
      await api.post(`/review/batches/${batchId}/complete`, {
        reviewer_summary: completeForm.reviewer_summary.trim(),
        recommendation: completeForm.recommendation.trim() || null,
        recommendation_score: completeForm.recommendation_score === '' ? null : Number(completeForm.recommendation_score),
      }, token);
      setNotice('Review completed. Decisions can be applied once every reviewer on the batch has completed.');
      await load();
    } catch (e) { setError(e.message); }
  }

  async function closeBatch() {
    setError(null); setNotice(null);
    try {
      await api.post(`/review/batches/${batchId}/close`, null, token);
      setNotice('Batch closed.');
      await load();
    } catch (e) { setError(e.message); }
  }

  if (!detail) return error ? <div className="alert alert-error">{error}</div> : <p className="hint">Loading…</p>;
  const { batch, reviewers, questions } = detail;
  const mine = user.role === 'reviewer' ? reviewers.find(r => r.reviewer_id === user.id && r.status !== 'revoked') : null;
  const undecided = questions.filter(item => !item.question.review_outcome).length;

  return (
    <div>
      <button className="btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={onBack}>← Back to batches</button>
      <h3 className="section-title">{batch.title}</h3>
      <p className="meta">Status: {batch.status.replace(/_/g, ' ')}{batch.due_at ? ` · Due ${new Date(batch.due_at).toLocaleDateString()}` : ''}</p>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      {canManage && (
        <div className="card" style={{ marginBottom: 16, background: '#f8f9fc' }}>
          <h4 style={{ marginTop: 0 }}>Reviewers</h4>
          {reviewers.length === 0 && <p className="hint">No reviewers assigned to this batch yet.</p>}
          {reviewers.map(r => {
            const pending = ['assigned', 'in_progress'].includes(r.status) && !['closed', 'cancelled'].includes(batch.status);
            const candidates = reviewerAssignments.filter(ra => ra.is_active && ra.id !== r.reviewer_assignment_id
              && !reviewers.some(x => x.reviewer_assignment_id === ra.id && x.status !== 'revoked'));
            return (
              <div key={r.id} className="list-item" style={{ flexWrap: 'wrap', gap: 8 }}>
                <div>
                  {r.reviewer_email}
                  {r.assignment_active === false && r.status !== 'revoked' && (
                    <div className="meta" style={{ color: '#b45309' }}>Assignment ended: this reviewer can no longer open the batch. Replace them below.</div>
                  )}
                </div>
                <span className="badge badge-draft">{r.status}</span>
                {pending && candidates.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select aria-label={`Replacement for ${r.reviewer_email}`} value={replaceWith[r.id] || ''} onChange={e => setReplaceWith({ ...replaceWith, [r.id]: e.target.value })}>
                      <option value="">Replace with…</option>
                      {candidates.map(ra => <option key={ra.id} value={ra.id}>{ra.reviewer_email}</option>)}
                    </select>
                    <button className="btn-ghost btn-sm" disabled={!replaceWith[r.id]} onClick={() => replaceReviewer(r)}>Replace</button>
                  </div>
                )}
              </div>
            );
          })}
          {batch.status !== 'closed' && (
            <div style={{ marginTop: 10 }}>
              <label style={{ fontWeight: 600, fontSize: '0.85rem' }}>Assign reviewer(s)</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '6px 0' }}>
                {reviewerAssignments.filter(ra => ra.is_active && !reviewers.some(r => r.reviewer_assignment_id === ra.id && r.status !== 'revoked')).map(ra => (
                  <label key={ra.id} style={{ fontWeight: 400, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="checkbox" checked={selectedReviewers.includes(ra.id)}
                      onChange={e => setSelectedReviewers(e.target.checked ? [...selectedReviewers, ra.id] : selectedReviewers.filter(id => id !== ra.id))} />
                    {ra.reviewer_email}
                  </label>
                ))}
                {reviewerAssignments.length === 0 && <p className="hint">No reviewers are assigned to this course offering yet — assign one under Manage academics first.</p>}
              </div>
              <button className="btn-primary btn-sm" onClick={assignReviewers} disabled={selectedReviewers.length === 0}>Assign selected</button>
            </div>
          )}
        </div>
      )}

      {mine && mine.status !== 'completed' && !['closed', 'cancelled'].includes(batch.status) && (
        <div className="card" style={{ marginBottom: 16, background: '#f8f9fc' }}>
          <h4 style={{ marginTop: 0 }}>Complete my review</h4>
          <p className="hint">Give a verdict on every question first. Other reviewers&apos; verdicts become visible once you complete.</p>
          <div className="field">
            <label htmlFor="complete-summary">Summary (required)</label>
            <textarea id="complete-summary" rows={2} value={completeForm.reviewer_summary} onChange={e => setCompleteForm({ ...completeForm, reviewer_summary: e.target.value })} />
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="complete-recommendation">Recommendation (optional)</label>
              <input id="complete-recommendation" value={completeForm.recommendation} onChange={e => setCompleteForm({ ...completeForm, recommendation: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="complete-score">Score (optional)</label>
              <input id="complete-score" type="number" min="0" step="0.01" value={completeForm.recommendation_score} onChange={e => setCompleteForm({ ...completeForm, recommendation_score: e.target.value })} />
            </div>
          </div>
          <button className="btn-primary btn-sm" disabled={!completeForm.reviewer_summary.trim()} onClick={completeReview}>Complete review</button>
        </div>
      )}
      {mine?.status === 'completed' && <p className="hint">You completed this batch.</p>}

      {canManage && <Disagreements token={token} batchId={batchId} questions={questions} refreshKey={detail} />}

      <h4>Questions ({questions.length})</h4>
      {questions.map(item => (
        <QuestionReviewCard
          key={item.question.id}
          item={item}
          token={token}
          user={user}
          batchId={batchId}
          batchStatus={batch.status}
          tree={trees[item.question.syllabus_version_id] || trees.current || null}
          onChange={load}
        />
      ))}

      {canManage && batch.status !== 'closed' && (
        <div style={{ marginTop: 16 }}>
          <button className="btn-primary" onClick={closeBatch} disabled={undecided > 0}>Close batch</button>
          {undecided > 0 && <p className="hint">{undecided} question(s) have no review decision yet. The batch can be closed once every decision is applied; replace a late reviewer instead of closing.</p>}
        </div>
      )}
    </div>
  );
}

// Every question of the batch where completed reviewers disagree on difficulty, Bloom, CO, unit or topic
// (GET /review/batches/:id/disagreements): the values side by side, never averaged. Resolve them on the question.
function Disagreements({ token, batchId, questions, refreshKey }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.get(`/review/batches/${batchId}/disagreements`, token)
      .then(d => { if (!cancelled) setRows(d.disagreements || []); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [batchId, token, refreshKey]);
  const textOf = (id) => questions.find(item => item.question.id === id)?.question.question_text || id;
  // CO, unit and topic verdicts are ids; the batch detail's verdicts carry their codes and titles.
  const names = new Map();
  for (const item of questions) for (const v of item.verdicts) {
    if (v.verified_course_outcome_id) names.set(v.verified_course_outcome_id, v.verified_co_code);
    if (v.verified_syllabus_unit_id) names.set(v.verified_syllabus_unit_id, v.verified_unit_code);
    if (v.verified_syllabus_topic_id) names.set(v.verified_syllabus_topic_id, v.verified_topic_title);
  }
  const shown = (val) => (val == null ? '—' : names.get(val) || String(val));
  const field = (f) => f.replace('verified_', '').replace(/_id$/, '').replace(/_/g, ' ');
  if (error) return <div className="alert alert-error">{error}</div>;
  if (!rows) return <p className="hint" role="status">Loading disagreements…</p>;
  return (
    <div className="card" style={{ marginBottom: 16, background: '#fff8f0' }}>
      <h4 style={{ marginTop: 0 }}>Reviewer disagreements ({rows.filter(r => !r.resolved).length} unresolved)</h4>
      {rows.length === 0 && <p className="hint">The completed reviewers agree on every question so far.</p>}
      {rows.map(r => (
        <div key={r.question_id} className="list-item" style={{ display: 'block' }}>
          <div><strong>{textOf(r.question_id).slice(0, 140)}</strong> {r.resolved ? <span className="badge badge-approved">resolved</span> : <span className="badge badge-rejected">needs a resolution</span>}</div>
          <div className="hint">Disagree on: {r.conflicting_fields.map(field).join(', ')}</div>
          <table style={{ width: '100%', fontSize: '0.8rem', marginTop: 4 }}>
            <thead><tr><th>Reviewer</th>{r.conflicting_fields.map(f => <th key={f}>{field(f)}</th>)}</tr></thead>
            <tbody>{r.verdicts.map(v => (
              <tr key={v.reviewer_id}><td>{v.reviewer_email}</td>{r.conflicting_fields.map(f => <td key={f}>{shown(v[f])}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {rows.some(r => !r.resolved) && <p className="hint">Record the final values under each question below (Resolve disagreement).</p>}
    </div>
  );
}

const DECISION_LABEL = { APPROVED: 'Approve question', CHANGES_REQUESTED: 'Request changes', REJECTED: 'Reject question' };

// tree: the question's own syllabus version (units > topics > subtopics, COs); the verdict and the resolution choose
// from it, and the server checks every id against that version.
function QuestionReviewCard({ item, token, user, batchId, batchStatus, tree, onChange }) {
  const courseOutcomes = tree?.course_outcomes || [];
  const { question, verdicts, resolution, unresolved_fields: unresolved = [], decision } = item;
  const isReviewer = user.role === 'reviewer';
  const canManage = user.role === 'hod';
  const myVerdict = verdicts.find(v => v.reviewer_id === user.id);
  const isOwnQuestion = question.submitted_by === user.id;
  // Verdicts and resolutions only while this question's review round is open.
  const reviewOpen = question.question_status === 'UNDER_REVIEW' && !question.review_outcome && !['closed', 'cancelled'].includes(batchStatus);
  const [applyReason, setApplyReason] = useState(myVerdict?.comment || '');
  const [showCanonical, setShowCanonical] = useState(false);

  const [form, setForm] = useState({
    decision: myVerdict?.decision || 'accept',
    verified_difficulty: myVerdict?.verified_difficulty || question.difficulty || '',
    verified_bloom_level: myVerdict?.verified_bloom_level || question.submitted_bloom_level || '',
    verified_course_outcome_id: myVerdict?.verified_course_outcome_id || '',
    verified_syllabus_unit_id: myVerdict?.verified_syllabus_unit_id || '',
    verified_syllabus_topic_id: myVerdict?.verified_syllabus_topic_id || '',
    verified_syllabus_subtopic_id: myVerdict?.verified_syllabus_subtopic_id || '',
    flagged_ambiguous: myVerdict?.flagged_ambiguous || false,
    flagged_duplicate: myVerdict?.flagged_duplicate || false,
    answer_approved: myVerdict?.answer_approved || false,
    comment: myVerdict?.comment || '',
  });
  const [resolveForm, setResolveForm] = useState({
    final_difficulty: '', final_bloom_level: '', final_course_outcome_id: '',
    final_syllabus_unit_id: '', final_syllabus_topic_id: '', final_syllabus_subtopic_id: '',
    resolution_method: 'hod_override', reason: '',
  });
  const [error, setError] = useState(null);
  const [checks, setChecks] = useState(() => (myVerdict?.decision === 'accept' ? Object.fromEntries(REVIEW_CHECKLIST.map(([k]) => [k, true])) : {}));

  async function submitVerdict() {
    setError(null);
    if (['reject', 'request_revision'].includes(form.decision) && !form.comment) {
      setError('A comment is required when rejecting or requesting revision.');
      return;
    }
    // Mirrors the server: an accept is an approval of the full classification and the answer.
    if (form.decision === 'accept') {
      const unchecked = REVIEW_CHECKLIST.filter(([k]) => !checks[k]).map(([, label]) => label);
      if (unchecked.length) { setError(`To accept, confirm every checklist item (${unchecked.length} not confirmed: ${unchecked[0]}${unchecked.length > 1 ? ', …' : ''}).`); return; }
      const missing = [['difficulty', form.verified_difficulty], ['Bloom level', form.verified_bloom_level], ['course outcome', form.verified_course_outcome_id],
        ['unit', form.verified_syllabus_unit_id], ['topic', form.verified_syllabus_topic_id]].filter(([, v]) => !v).map(([n]) => n);
      if (missing.length) { setError(`To accept, verify the ${missing.join(', ')}.`); return; }
      if (!form.answer_approved || form.flagged_ambiguous || form.flagged_duplicate) {
        setError('To accept, approve the answer and clear the ambiguity/duplicate flags, or choose request revision / reject.');
        return;
      }
    }
    try {
      const body = { ...form, verified_syllabus_subtopic_id: form.verified_syllabus_subtopic_id || undefined };
      await api.post(`/review/batches/${batchId}/questions/${question.id}/verdict`, body, token);
      await onChange();
    } catch (e) { setError(e.message); }
  }

  // Applies the decision the batch's verdicts allow (POST /question-bank/:id/transition re-checks everything).
  async function applyDecision(target) {
    setError(null);
    try {
      await api.post(`/question-bank/${question.id}/transition`, { target_status: target, reason: target === 'APPROVED' ? undefined : applyReason.trim() }, token);
      await onChange();
    } catch (e) { setError(e.data?.blockers?.length ? e.data.blockers.join(' ') : e.message); }
  }

  async function submitResolution() {
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(resolveForm).filter(([, v]) => v !== ''));
      await api.post(`/review/questions/${question.id}/resolve`, body, token);
      await onChange();
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="card" style={{ marginBottom: 12, borderLeft: unresolved.length > 0 ? '4px solid var(--danger, #c0392b)' : undefined }}>
      <QuestionView q={question} token={token} fileUrl={(a) => `/attachments/${a.id}/file`} showType={false} />
      <div className="meta">By {question.teacher_email} · {typeLabel(question.question_type)} · {question.marks} marks · {question.difficulty}
        {question.topic ? ` · Topic: ${question.topic}${question.subtopic ? ` › ${question.subtopic}` : ''}` : ''} · <QuestionStatusBadge status={question.question_status} />
        {' '}<button className="btn-ghost btn-sm" onClick={() => setShowCanonical(!showCanonical)}>{showCanonical ? 'Hide canonical record' : 'Canonical record'}</button>
      </div>
      {showCanonical && <CanonicalDetail token={token} questionId={question.id} />}
      {question.change_request_reason && <div className="hint">Earlier change request: {question.change_request_reason}</div>}
      {tree?.status === 'SUPERSEDED' && (
        <div className="alert alert-warn">
          This question is on syllabus version {tree.version_number}, which has been superseded: verify it against that version. After the decision the HOD maps it to the current syllabus.
        </div>
      )}
      {question.review_outcome && <div className="alert alert-ok">Decision applied: {question.review_outcome.replace(/_/g, ' ').toLowerCase()}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {verdicts.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <label style={{ fontWeight: 600, fontSize: '0.82rem' }}>Reviewer verdicts so far</label>
          <table style={{ width: '100%', fontSize: '0.8rem', marginTop: 4 }}>
            <thead><tr><th>Reviewer</th><th>Decision</th><th>Difficulty</th><th>Bloom</th><th>CO</th><th>Unit</th><th>Topic</th><th>Subtopic</th></tr></thead>
            <tbody>
              {verdicts.map(v => (
                <tr key={v.reviewer_id}>
                  <td>{v.reviewer_email}</td><td>{v.decision}</td><td>{v.verified_difficulty || '—'}</td>
                  <td>{v.verified_bloom_level || '—'}</td><td>{v.verified_co_code || '—'}</td>
                  <td>{v.verified_unit_code || '—'}</td><td>{v.verified_topic_title || '—'}</td><td>{v.verified_subtopic_title || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {unresolved.length > 0 && (
            <div className="alert alert-warn" style={{ marginTop: 6 }}>
              ⚠ REVIEWER DISAGREEMENT on {unresolved.map(f => f.replace('verified_', '').replace(/_/g, ' ')).join(', ')}: needs an explicit resolution.
            </div>
          )}
          {resolution && (
            <div className="alert alert-ok" style={{ marginTop: 6 }}>
              Final: {resolution.final_difficulty || '—'} difficulty, {resolution.final_bloom_level || '—'} Bloom ({resolution.resolution_method.replace(/_/g, ' ')})
            </div>
          )}
        </div>
      )}

      {isReviewer && (
        isOwnQuestion ? (
          <p className="hint" style={{ marginTop: 8 }}>You submitted this question — you cannot review your own submission.</p>
        ) : reviewOpen && (
          <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 10 }}>
            <div className="row">
              <div className="field">
                <label>Decision</label>
                <select value={form.decision} onChange={e => setForm({ ...form, decision: e.target.value })}>
                  <option value="accept">Accept</option><option value="reject">Reject</option><option value="request_revision">Request revision</option>
                </select>
              </div>
              <div className="field">
                <label>Difficulty</label>
                <select value={form.verified_difficulty} onChange={e => setForm({ ...form, verified_difficulty: e.target.value })}>
                  <option value="">—</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
                </select>
              </div>
              <div className="field">
                <label>Bloom level</label>
                <select value={form.verified_bloom_level} onChange={e => setForm({ ...form, verified_bloom_level: e.target.value })}>
                  <option value="">—</option>
                  {BLOOM_LEVELS_RB.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              {courseOutcomes.length > 0 && (
                <div className="field">
                  <label>Course Outcome</label>
                  <select value={form.verified_course_outcome_id} onChange={e => setForm({ ...form, verified_course_outcome_id: e.target.value })}>
                    <option value="">—</option>
                    {courseOutcomes.map(co => <option key={co.id} value={co.id}>{co.code}</option>)}
                  </select>
                </div>
              )}
              <SyllabusPicker tree={tree} idPrefix={`verdict-${question.id}`} subtopicLabel="Subtopic (verify, or leave the whole topic)"
                value={{ unitId: form.verified_syllabus_unit_id, topicId: form.verified_syllabus_topic_id, subtopicId: form.verified_syllabus_subtopic_id }}
                onChange={v => setForm({ ...form, verified_syllabus_unit_id: v.unitId, verified_syllabus_topic_id: v.topicId, verified_syllabus_subtopic_id: v.subtopicId })} />
            </div>
            <fieldset className="review-checklist">
              <legend>Review checklist {form.decision === 'accept' ? '(all required to accept)' : '(note what failed in the comment)'}</legend>
              {REVIEW_CHECKLIST.map(([k, label]) => (
                <label key={k}><input type="checkbox" checked={!!checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} /> {label}</label>
              ))}
            </fieldset>
            <div style={{ display: 'flex', gap: 12, margin: '8px 0', fontSize: '0.82rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={form.flagged_ambiguous} onChange={e => setForm({ ...form, flagged_ambiguous: e.target.checked })} /> Ambiguous</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={form.flagged_duplicate} onChange={e => setForm({ ...form, flagged_duplicate: e.target.checked })} /> Possible duplicate</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={form.answer_approved} onChange={e => setForm({ ...form, answer_approved: e.target.checked })} /> Answer approved</label>
            </div>
            <div className="field">
              <label>Comment{['reject', 'request_revision'].includes(form.decision) ? ' (required)' : ''}</label>
              <input value={form.comment} onChange={e => setForm({ ...form, comment: e.target.value })} />
            </div>
            <button className="btn-primary btn-sm" onClick={submitVerdict}>{myVerdict ? 'Update verdict' : 'Submit verdict'}</button>
          </div>
        )
      )}

      {isReviewer && !isOwnQuestion && decision && (
        <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 10 }}>
          <label style={{ fontWeight: 600, fontSize: '0.82rem' }}>Apply the review decision</label>
          {decision.blockers.map((b, i) => <p key={i} className="hint">{b}</p>)}
          {decision.allowed.length > 0 && (
            <>
              {decision.allowed.some(t => t !== 'APPROVED') && (
                <div className="field">
                  <label htmlFor={`apply-reason-${question.id}`}>Reason for the author (required to request changes or reject)</label>
                  <input id={`apply-reason-${question.id}`} value={applyReason} onChange={e => setApplyReason(e.target.value)} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                {decision.allowed.map(t => (
                  <button key={t} className={t === 'REJECTED' ? 'btn-danger btn-sm' : t === 'APPROVED' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                    disabled={t !== 'APPROVED' && applyReason.trim().length < 3} onClick={() => applyDecision(t)}>
                    {DECISION_LABEL[t] || t}
                  </button>
                ))}
              </div>
            </>
          )}
          {decision.blockers.length === 0 && !decision.allowed.includes('APPROVED') && decision.refusals?.APPROVED && (
            <p className="hint">Not approvable yet: {decision.refusals.APPROVED}</p>
          )}
        </div>
      )}

      {canManage && unresolved.length > 0 && reviewOpen && (
        <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 10 }}>
          <label style={{ fontWeight: 600, fontSize: '0.82rem' }}>Resolve disagreement</label>
          <div className="row">
            <div className="field">
              <label>Final difficulty</label>
              <select value={resolveForm.final_difficulty} onChange={e => setResolveForm({ ...resolveForm, final_difficulty: e.target.value })}>
                <option value="">—</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
            <div className="field">
              <label>Final Bloom</label>
              <select value={resolveForm.final_bloom_level} onChange={e => setResolveForm({ ...resolveForm, final_bloom_level: e.target.value })}>
                <option value="">—</option>
                {BLOOM_LEVELS_RB.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Method</label>
              <select value={resolveForm.resolution_method} onChange={e => setResolveForm({ ...resolveForm, resolution_method: e.target.value })}>
                <option value="hod_override">HOD override</option>
                <option value="additional_reviewer">Additional reviewer decided</option>
                <option value="re_review">Re-review</option>
              </select>
            </div>
            {courseOutcomes.length > 0 && (
              <div className="field">
                <label>Final CO</label>
                <select value={resolveForm.final_course_outcome_id} onChange={e => setResolveForm({ ...resolveForm, final_course_outcome_id: e.target.value })}>
                  <option value="">—</option>
                  {courseOutcomes.map(co => <option key={co.id} value={co.id}>{co.code}</option>)}
                </select>
              </div>
            )}
            <SyllabusPicker tree={tree} idPrefix={`resolve-${question.id}`} subtopicLabel="Final subtopic (optional)"
              value={{ unitId: resolveForm.final_syllabus_unit_id, topicId: resolveForm.final_syllabus_topic_id, subtopicId: resolveForm.final_syllabus_subtopic_id }}
              onChange={v => setResolveForm({ ...resolveForm, final_syllabus_unit_id: v.unitId, final_syllabus_topic_id: v.topicId, final_syllabus_subtopic_id: v.subtopicId })} />
          </div>
          <div className="field"><label>Reason (required for an override or when changing an already verified value; recorded with old and new values)</label><input value={resolveForm.reason} onChange={e => setResolveForm({ ...resolveForm, reason: e.target.value })} /></div>
          <button className="btn-danger btn-sm" onClick={submitResolution}
            disabled={!resolveForm.final_difficulty && !resolveForm.final_bloom_level && !resolveForm.final_course_outcome_id && !resolveForm.final_syllabus_unit_id && !resolveForm.final_syllabus_topic_id}>
            Record final decision
          </button>
        </div>
      )}
    </div>
  );
}

// The reviewer's actual landing page — everything needing attention in one
// call to /review/dashboard (spec section 1), rather than five separate
// list screens the reviewer has to remember to check.
function ReviewerHome({ token, onOpenBatches }) {
  const [data, setData] = useState(null);
  const [offerings, setOfferings] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/review/dashboard', token).then(setData).catch(e => setError(e.message));
    api.get('/academic/my-reviewer-assignments', token).then(setOfferings).catch(e => setError(e.message));
  }, [token]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <p className="hint">Loading…</p>;
  const { summary, batches } = data;

  const cards = [
    ['Assigned batches', summary.assigned_batches],
    ['Pending questions', summary.pending_questions],
    ['Completed reviews', summary.completed_reviews],
    ['Needing revision', summary.questions_needing_revision],
    ['Unresolved conflicts', summary.unresolved_conflicts],
  ];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 20 }}>
        {cards.map(([label, value]) => (
          <div className="card" key={label} style={{ textAlign: 'center', background: value > 0 && label !== 'Completed reviews' ? '#fff8f0' : '#f8f9fc' }}>
            <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{value}</div>
            <div className="meta">{label}</div>
          </div>
        ))}
      </div>

      <h4>Course offerings you review</h4>
      {offerings.length === 0 && <p className="hint">You are not assigned to any course offering yet; the HOD assigns reviewers under Manage academics.</p>}
      {offerings.map(o => (
        <div className="list-item" key={o.assignment_id}>
          <div><strong>{o.subject_code}</strong> — {o.course_title} <span className="meta">({o.academic_session_label}, sem {o.semester}{o.offering_code ? `, ${o.offering_code}` : ''})</span></div>
        </div>
      ))}

      <h4>Your assigned batches</h4>
      {batches.length === 0 && <p className="hint">No batches assigned yet.</p>}
      {batches.map(b => (
        <div className="list-item" key={b.id} style={{ cursor: 'pointer' }} onClick={onOpenBatches}>
          <div>
            <div><strong>{b.subject_code}</strong> — {b.course_title} {b.academic_session_label ? `(${b.academic_session_label}, sem ${b.semester})` : ''}</div>
            <div className="meta">
              {b.reviewed_count}/{b.question_count} reviewed
              {b.syllabus_version_number ? ` · Syllabus v${b.syllabus_version_number}` : ''}
              {b.due_at ? ` · Due ${new Date(b.due_at).toLocaleDateString()}` : ''}
              {b.conflict_count > 0 ? ` · ⚠ ${b.conflict_count} conflict${b.conflict_count > 1 ? 's' : ''}` : ''}
            </div>
          </div>
          <span className={`badge ${b.status === 'closed' ? 'badge-approved' : 'badge-pending'}`}>{b.status.replace(/_/g, ' ')}</span>
        </div>
      ))}

    </div>
  );
}

const findingsOf = (t) => { try { const v = JSON.parse(t || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// HOD attention list (read-only). Automated checks are advisory; decisions belong to the assigned reviewers.
function EscalationQueue({ token }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // Never rejects (the error is shown).
  const load = useCallback(() => api.get('/questions/queue', token)
    .then(setRows, (e) => setError(e.message)), [token]);
  useEffect(() => { load(); }, [load]);

  async function sendToReview(id) {
    setError(null); setNotice(null);
    try {
      await api.post(`/question-bank/${id}/transition`, { target_status: 'UNDER_REVIEW' }, token);
      setNotice('Sent to review. Put it in a review batch so its reviewers can review it.');
      await load();
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Automated checks are advisory and never change a question&apos;s status. Questions appear here when the author disputed
        the automated findings, or a reviewer flagged them under the old workflow. Approval, change requests and rejection
        belong to the assigned reviewers; you can send a submission to review.
      </p>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}
      {rows.length === 0 && <div className="empty-state">Nothing needs your attention right now.</div>}
      {rows.map(q => {
        const f = findingsOf(q.ai_review_notes);
        return (
          <div className="list-item" key={q.id}>
            <div style={{ flex: 1 }}>
              <QuestionView q={q} token={token} fileUrl={(a) => `/attachments/${a.id}/file`} />
              <div className="meta">By {q.teacher_email} · {q.subject_code} {q.offering_code} · {typeLabel(q.question_type)} · {q.difficulty} · {q.marks} marks · Topic: {q.topic || '—'}{q.subtopic ? ` › ${q.subtopic}` : ''}</div>
              {f.length > 0 && <div className="meta">Automated findings (advisory): {f.map(i => i.detail).join('; ')}</div>}
              {q.ai_review_dispute && <div className="meta" style={{ color: 'var(--danger)' }}>Author disagrees: “{q.ai_review_dispute}”</div>}
              {(q.legacy_reviewer_flags || []).map((v, i) => (
                <div className="meta" key={i} style={{ color: 'var(--danger)' }}>Reviewer flag ({v.reviewer_email}){v.comment ? ` — "${v.comment}"` : ''}</div>
              ))}
            </div>
            <div className="actions">
              <QuestionStatusBadge status={q.question_status} />
              {['SUBMITTED', 'RESUBMITTED'].includes(q.question_status) && <button className="btn-primary btn-sm" onClick={() => sendToReview(q.id)}>Send to review</button>}
              {q.question_status === 'UNDER_REVIEW' && <span className="hint">With reviewers</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MistakeDetection({ token }) {
  const [teachers, setTeachers] = useState([]);
  const [teacherId, setTeacherId] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Teachers whose home department the HOD's scope covers (the attention list is too narrow to pick teachers from).
  useEffect(() => { api.get('/academic/teachers', token).then(setTeachers).catch(() => setTeachers([])); }, [token]);

  async function check(id) {
    setTeacherId(id); setResult(null); setError(null);
    if (!id) return;
    try { setResult(await api.get(`/questions/mistakes/${id}`, token)); }
    catch (e) { setError(e.status === 404 ? 'This teacher is not in your scope (no assignment or submission in your department).' : e.message); }
  }

  return (
    <div className="card">
      <h3 className="section-title">Automatic mistake detection</h3>
      <p className="hint" style={{ marginBottom: 12 }}>
        Runs duplicate checks, the type-specific completeness rules of every question type (what a question still lacks
        before it could become Active), difficulty and topic balance, and previous-year overlap for a teacher's submissions.
      </p>
      <div className="field">
        <label>Select teacher</label>
        <select value={teacherId} onChange={e => check(e.target.value)}>
          <option value="">— choose —</option>
          {teachers.map(t => <option key={t.id} value={t.id}>{t.email}</option>)}
        </select>
      </div>
      {error && <div className="alert alert-error">{error}</div>}

      {result && (
        <div>
          <p style={{ fontWeight: 600 }}>Difficulty distribution</p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {result.difficulty_distribution.map(d => (
              <span key={d.difficulty} className="badge badge-draft">{d.difficulty}: {d.cnt}</span>
            ))}
            {result.difficulty_distribution.length === 0 && <span className="hint">No submitted questions yet.</span>}
          </div>

          {result.topic_distribution?.length > 0 && (
            <>
              <p style={{ fontWeight: 600 }}>Topic distribution</p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {result.topic_distribution.map(t => (
                  <span key={t.topic} className="badge badge-draft">{t.topic}: {t.cnt}</span>
                ))}
              </div>
            </>
          )}

          <p style={{ fontWeight: 600 }}>Flagged issues ({result.issues.length})</p>
          {result.issues.length === 0 && <div className="alert alert-ok">No issues detected.</div>}
          {result.issues.map((issue, i) => (
            <div className="alert alert-warn" key={i}>
              <strong>{issue.type.replace(/_/g, ' ')}</strong>: {issue.detail}
              {issue.question_id && <div className="hint mono">Question {issue.question_id.slice(0, 8)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Admin is technical-only (spec §2): it builds the structure and manages accounts. Staffing (assignments),
// syllabus content and previous-year papers are the HOD's academic work, and the server refuses admin there.
function ManageAcademics({ token, user }) {
  const [subTab, setSubTab] = useState('build');
  const isHod = user.role === 'hod';
  return (
    <div>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button className={`tab ${subTab === 'build' ? 'active' : ''}`} onClick={() => setSubTab('build')}>Build hierarchy</button>
        {isHod && <button className={`tab ${subTab === 'assign' ? 'active' : ''}`} onClick={() => setSubTab('assign')}>Assign people</button>}
        <button className={`tab ${subTab === 'users' ? 'active' : ''}`} onClick={() => setSubTab('users')}>User accounts</button>
        {isHod && <button className={`tab ${subTab === 'syllabus' ? 'active' : ''}`} onClick={() => setSubTab('syllabus')}>Syllabus versions</button>}
        {isHod && <button className={`tab ${subTab === 'mapping' ? 'active' : ''}`} onClick={() => setSubTab('mapping')}>Question mapping</button>}
        {isHod && <button className={`tab ${subTab === 'prevyear' ? 'active' : ''}`} onClick={() => setSubTab('prevyear')}>Previous-year papers</button>}
      </div>
      {subTab === 'build' && <BuildHierarchy token={token} user={user} />}
      {isHod && subTab === 'assign' && <AssignPeople token={token} />}
      {subTab === 'users' && <UserManagement token={token} user={user} />}
      {isHod && subTab === 'syllabus' && <SyllabusManagement token={token} user={user} />}
      {isHod && subTab === 'mapping' && <QuestionMapping token={token} />}
      {isHod && subTab === 'prevyear' && <PreviousYearPapers token={token} />}
    </div>
  );
}

function PreviousYearPapers({ token }) {
  const [offerings, setOfferings] = useState([]);
  const [offeringId, setOfferingId] = useState('');
  const [entries, setEntries] = useState([]);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [bulkText, setBulkText] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    api.get('/academic/course-offerings', token).then(rows => {
      setOfferings(rows);
      if (rows.length > 0) setOfferingId(rows[0].course_offering_id);
    }).catch(e => setError(e.message));
  }, [token]);

  // Never rejects (the error is shown).
  const loadEntries = useCallback((id) => {
    if (!id) return Promise.resolve();
    return api.get(`/academic/previous-year-papers?course_offering_id=${id}`, token)
      .then(setEntries, (e) => setError(e.message));
  }, [token]);
  useEffect(() => { loadEntries(offeringId); }, [loadEntries, offeringId]);

  async function submitBatch() {
    setError(null); setNotice(null);
    const questions = bulkText.split('\n').map(l => l.trim()).filter(Boolean);
    if (questions.length === 0) {
      setError('Paste at least one question, one per line.');
      return;
    }
    try {
      const res = await api.post('/academic/previous-year-papers', { course_offering_id: offeringId, year: Number(year), questions }, token);
      setNotice(`Added ${res.added} question(s)${res.skippedDuplicates ? `, skipped ${res.skippedDuplicates} already-known duplicate(s)` : ''}.`);
      setBulkText('');
      await loadEntries(offeringId);
    } catch (e) { setError(e.message); }
  }

  async function remove(id) {
    if (!confirm('Remove this previous-year question? Future papers may then be allowed to reuse it.')) return;
    try {
      await api.del(`/academic/previous-year-papers/${id}`, token);
      await loadEntries(offeringId);
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        This is what powers the "never repeat last year's question" rule in paper generation — a question is only
        excluded from a generated paper if its exact (or near-identical) wording is entered here for this specific
        course offering.
      </div>

      <div className="field" style={{ maxWidth: 480, marginBottom: 16 }}>
        <label>Course offering</label>
        <select value={offeringId} onChange={e => setOfferingId(e.target.value)}>
          {offerings.map(o => <option key={o.course_offering_id} value={o.course_offering_id}>{o.subject_code} — {o.course_title} ({o.academic_session_label}, sem {o.semester})</option>)}
        </select>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Add questions from a previous year's paper</h3>
        <div className="row">
          <div className="field" style={{ maxWidth: 160 }}><label>Year</label><input type="number" value={year} onChange={e => setYear(e.target.value)} /></div>
        </div>
        <div className="field">
          <label>Questions (one per line)</label>
          <textarea rows={6} value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder={'What is the time complexity of merge sort?\nExplain the CAP theorem.\n...'} />
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-ok">{notice}</div>}
        <button className="btn-primary" onClick={submitBatch} disabled={!offeringId || !bulkText.trim()}>Add to previous-year bank</button>
      </div>

      <h3 className="section-title">Existing entries ({entries.length})</h3>
      {entries.length === 0 && <p className="hint">No previous-year questions recorded for this offering yet.</p>}
      {entries.map(e => (
        <div className="list-item" key={e.id}>
          <div>
            <div>{e.question_text || <em className="hint">(no text recorded — added before this feature existed)</em>}</div>
            <div className="meta">Year {e.year || '—'}{e.added_by_email ? ` · added by ${e.added_by_email}` : ''}</div>
          </div>
          <button className="btn-ghost btn-sm" onClick={() => remove(e.id)}>Remove</button>
        </div>
      ))}
    </div>
  );
}

// extracted_units is JSONB: the API returns an object (older rows may hold JSON text, or plain text). Never throws.
function syllabusContent(v) {
  if (v == null || v === '') return '(no content recorded)';
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
}

// Syllabus versions (migration 042): DRAFT -> TEACHER_VERIFIED -> HOD_REVIEW -> ACTIVE -> SUPERSEDED, REJECTED (with a
// reason) from any state before ACTIVE. Content (units, topics, subtopics, COs) is edited only while a version is DRAFT;
// the usual way to change the syllabus is "New version from current", which copies the ACTIVE version forward.
// Approving a version supersedes the previous one and runs change detection: questions on unchanged items move to the
// new version, the others are listed under "Changes" for the HOD and the offering's reviewers.
function SyllabusManagement({ token, user }) {
  const [offerings, setOfferings] = useState([]);
  const [offeringId, setOfferingId] = useState('');
  const [versions, setVersions] = useState([]);
  const [notes, setNotes] = useState('');
  const [showChanges, setShowChanges] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    api.get('/academic/course-offerings', token).then(rows => {
      setOfferings(rows);
      if (rows.length > 0) setOfferingId(rows[0].course_offering_id);
    }).catch(e => setError(e.message));
  }, [token]);

  // Never rejects (the error is shown).
  const loadVersions = useCallback((id) => {
    if (!id) return Promise.resolve();
    return api.get(`/academic/syllabus-versions?course_offering_id=${id}`, token)
      .then(setVersions, (e) => setError(e.message));
  }, [token]);
  useEffect(() => { loadVersions(offeringId); }, [loadVersions, offeringId]);

  async function act(fn, done) {
    setError(null); setNotice(null);
    try {
      const res = await fn();
      setNotice(typeof done === 'function' ? done(res) : done);
      await loadVersions(offeringId);
    } catch (e) { setError(e.data?.problems ? `${e.message}` : e.message); }
  }
  const post = (path, body) => () => api.post(path, body, token);
  const withReason = (label, path, body = (reason) => ({ reason }), done) => {
    const reason = prompt(label);
    if (!reason || reason.trim().length < 3) return;
    act(post(path, body(reason.trim())), done);
  };
  const approved = (r) => `Approved: ${r.changes} change(s) detected; ${r.questions_remapped} question(s) moved to the new version automatically; `
    + `${r.questions_sent_back} sent back to their authors; ${r.questions_flagged} flagged for you or the reviewers`
    + `${r.questions_skipped ? `; ${r.questions_skipped} left for mapping (in review or shared)` : ''}${r.questions_unmapped ? `; ${r.questions_unmapped} had no identifiable topic (see Question mapping)` : ''}.`;
  const active = versions.find(v => v.status === 'ACTIVE');

  return (
    <div>
      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        The official syllabus is yours to publish: upload the department&apos;s PDF (or start a version yourself), review and correct
        what was extracted, confirm it matches the document, submit it and approve it. Units, topics, subtopics and course
        outcomes are edited only while a version is a draft; an approved version never changes. To change the syllabus,
        start a new version from the current one: questions on unchanged items move to it automatically, and the others are
        listed under its changes for you and the reviewers. Teachers and reviewers can read the syllabus but not change it.
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      <div className="field" style={{ maxWidth: 480, marginBottom: 16 }}>
        <label htmlFor="syl-mgmt-offering">Course offering</label>
        <select id="syl-mgmt-offering" value={offeringId} onChange={e => setOfferingId(e.target.value)}>
          {offerings.map(o => <option key={o.course_offering_id} value={o.course_offering_id}>{o.subject_code} — {o.course_title} ({o.academic_session_label}, sem {o.semester})</option>)}
        </select>
      </div>

      <SyllabusUpload token={token} offeringId={offeringId}
        offeringLabel={(() => { const o = offerings.find((x) => x.course_offering_id === offeringId); return o ? `${o.subject_code} ${o.course_title}` : ''; })()}
        onCreated={() => loadVersions(offeringId)} />

      <div className="card" style={{ marginBottom: 12 }}>
        <h3 className="section-title">Start a new version</h3>
        {active && (
          <button className="btn-primary btn-sm" onClick={() => act(post(`/academic/course-offerings/${offeringId}/syllabus-versions/from-current`, {}),
            (r) => `Version ${r.version_number} created as a draft with ${r.copied.units} unit(s), ${r.copied.topics} topic(s), ${r.copied.subtopics} subtopic(s) and ${r.copied.cos} CO(s) copied from version ${active.version_number}.`)}>
            New version from current (version {active.version_number})
          </button>
        )}
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor="syl-mgmt-notes">Or an empty draft, described as notes</label>
          <textarea id="syl-mgmt-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. 2027 syllabus revision" />
        </div>
        <button className="btn-ghost btn-sm" disabled={!notes.trim() || !offeringId}
          onClick={() => act(post('/academic/syllabus-versions', { course_offering_id: offeringId, notes: notes.trim() }), (r) => { setNotes(''); return `Version ${r.version_number} created as an empty draft.`; })}>
          New empty draft
        </button>
      </div>

      {versions.length === 0 && <p className="hint">No syllabus versions for this offering yet.</p>}
      {versions.map(v => {
        const [cls, label] = SYLLABUS_STATUS[v.status] || ['badge-pending', v.status];
        const base = `/academic/syllabus-versions/${v.id}`;
        return (
          <div className="card" key={v.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Version {v.version_number}</strong>
              <span className={`badge ${cls}`}>{label}</span>
            </div>
            <p className="meta">
              Created by {v.uploaded_by_email || '—'} on {new Date(v.created_at).toLocaleString()}
              {v.verified_by_email ? ` · verified by ${v.verified_by_email}` : ''}{v.approved_by_email ? ` · approved by ${v.approved_by_email}` : ''}
              {v.superseded_at ? ` · superseded ${new Date(v.superseded_at).toLocaleDateString()}` : ''}
            </p>
            <SyllabusSteps status={v.status} />
            {syllabusSource(v.extracted_units) && (
              <p className="hint" style={{ margin: '0 0 8px' }}>
                Extracted from the uploaded syllabus PDF. <SourcePdfButton token={token} versionId={v.id} pages={syllabusSource(v.extracted_units).pages} />
              </p>
            )}
            {v.status === 'DRAFT' && v.returned_reason && <div className="alert alert-warn">Returned to draft: {v.returned_reason}</div>}
            {v.status === 'REJECTED' && v.rejection_reason && <div className="alert alert-error">Rejected: {v.rejection_reason}</div>}
            <pre style={{ background: '#f5f5f8', padding: 10, borderRadius: 6, fontSize: '0.78rem', overflowX: 'auto' }}>
              {syllabusContent(v.extracted_units)}
            </pre>
            <div className="actions">
              {v.status === 'DRAFT' && <button className="btn-primary btn-sm" onClick={() => act(post(`${base}/verify`), 'Verified. Send it for HOD review next.')}>Verify content</button>}
              {v.status === 'TEACHER_VERIFIED' && <button className="btn-primary btn-sm" onClick={() => act(post(`${base}/submit-review`), 'In HOD review.')}>Submit for HOD review</button>}
              {v.status === 'HOD_REVIEW' && <button className="btn-primary btn-sm" onClick={() => act(post(`${base}/approve`), approved)}>Approve (activate)</button>}
              {['TEACHER_VERIFIED', 'HOD_REVIEW'].includes(v.status) && (
                <button className="btn-ghost btn-sm" onClick={() => withReason('What must be corrected? (the version returns to draft)', `${base}/return`, undefined, 'Returned to draft.')}>Return to draft</button>
              )}
              {['DRAFT', 'TEACHER_VERIFIED', 'HOD_REVIEW'].includes(v.status) && (
                <button className="btn-danger btn-sm" onClick={() => withReason('Reason for rejecting this syllabus version:', `${base}/reject`, undefined, 'Rejected.')}>Reject</button>
              )}
              {['ACTIVE', 'SUPERSEDED'].includes(v.status) && v.change_count > 0 && (
                <button className="btn-ghost btn-sm" onClick={() => setShowChanges(showChanges === v.id ? null : v.id)}>
                  {showChanges === v.id ? 'Hide changes' : `Changes from the previous version (${v.change_count})`}
                </button>
              )}
            </div>
            {showChanges === v.id && <SyllabusChangeReport key={v.id} token={token} user={user} path={`${base}/changes`} />}
            <CourseOutcomesPanel token={token} syllabusVersionId={v.id} editable={v.status === 'DRAFT'} />
            <SyllabusUnitsPanel token={token} syllabusVersionId={v.id} editable={v.status === 'DRAFT'} />
          </div>
        );
      })}
    </div>
  );
}

// Course Outcomes belong to one specific syllabus version (spec section 8) —
// approving a later version never rewrites these, it gets its own set.
// editable: only a DRAFT version's content can change (the server and the database refuse it otherwise).
function CourseOutcomesPanel({ token, syllabusVersionId, editable }) {
  const [cos, setCos] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', description: '', sequence: 0 });
  const [error, setError] = useState(null);

  // Never rejects (a failed load shows no COs).
  const load = useCallback(() => api.get(`/academic/syllabus-versions/${syllabusVersionId}/course-outcomes`, token)
    .then(setCos, () => setCos([])), [syllabusVersionId, token]);
  useEffect(() => { if (open) load(); }, [open, load]);

  async function add() {
    setError(null);
    try {
      await api.post(`/academic/syllabus-versions/${syllabusVersionId}/course-outcomes`, form, token);
      setForm({ code: '', description: '', sequence: 0 });
      await load();
    } catch (e) { setError(e.message); }
  }

  async function deactivate(id) {
    setError(null);
    try {
      await api.post(`/academic/course-outcomes/${id}/deactivate`, null, token);
      await load();
    } catch (e) { setError(e.message); }
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 10 }}>
      <button className="btn-ghost btn-sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Manage'} Course Outcomes ({cos.length || '…'})</button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {error && <div className="alert alert-error">{error}</div>}
          {cos.length === 0 && <p className="hint">No COs defined yet for this syllabus version.</p>}
          {cos.map(co => (
            <div className="list-item" key={co.id}>
              <div><strong>{co.code}</strong> — {co.description}</div>
              {editable && <button className="btn-ghost btn-sm" onClick={() => deactivate(co.id)}>Remove</button>}
            </div>
          ))}
          {!editable && <p className="hint">This version is no longer a draft: its course outcomes are fixed.</p>}
          {editable && <>
          <div className="row" style={{ marginTop: 8 }}>
            <div className="field" style={{ maxWidth: 100 }}><label>Code</label><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="CO1" /></div>
            <div className="field" style={{ flex: 1 }}><label>Description</label><input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Analyze algorithmic complexity" /></div>
            <div className="field" style={{ maxWidth: 90 }}><label>Order</label><input type="number" value={form.sequence} onChange={e => setForm({ ...form, sequence: e.target.value })} /></div>
          </div>
          <button className="btn-primary btn-sm" onClick={add} disabled={!form.code || !form.description}>Add CO</button>
          </>}
        </div>
      )}
    </div>
  );
}

// Units belong to one syllabus version, same as Course Outcomes — a unit
// contains topics underneath it (loaded on demand per unit, not all at
// once, since a syllabus can have many topics across many units).
function SyllabusUnitsPanel({ token, syllabusVersionId, editable }) {
  const [units, setUnits] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', title: '', sequence: 0 });
  const [error, setError] = useState(null);

  // Never rejects (a failed load shows no units).
  const load = useCallback(() => api.get(`/academic/syllabus-versions/${syllabusVersionId}/units`, token)
    .then(setUnits, () => setUnits([])), [syllabusVersionId, token]);
  useEffect(() => { if (open) load(); }, [open, load]);

  async function add() {
    setError(null);
    try {
      await api.post(`/academic/syllabus-versions/${syllabusVersionId}/units`, form, token);
      setForm({ code: '', title: '', sequence: 0 });
      await load();
    } catch (e) { setError(e.message); }
  }

  async function deactivate(id) {
    setError(null);
    try {
      await api.post(`/academic/units/${id}/deactivate`, null, token);
      await load();
    } catch (e) { setError(e.message); }
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 10 }}>
      <button className="btn-ghost btn-sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Manage'} Units & Topics ({units.length || '…'})</button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {error && <div className="alert alert-error">{error}</div>}
          {units.length === 0 && <p className="hint">No units defined yet for this syllabus version.</p>}
          {units.map(u => <SyllabusUnitRow key={u.id} token={token} unit={u} editable={editable} onDeactivate={() => deactivate(u.id)} />)}
          {!editable && <p className="hint">This version is no longer a draft: its units, topics and subtopics are fixed.</p>}
          {editable && <>
          <div className="row" style={{ marginTop: 8 }}>
            <div className="field" style={{ maxWidth: 120 }}><label>Code</label><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="Unit 1" /></div>
            <div className="field" style={{ flex: 1 }}><label>Title</label><input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Arrays and Linked Lists" /></div>
            <div className="field" style={{ maxWidth: 90 }}><label>Order</label><input type="number" value={form.sequence} onChange={e => setForm({ ...form, sequence: e.target.value })} /></div>
          </div>
          <button className="btn-primary btn-sm" onClick={add} disabled={!form.code || !form.title}>Add Unit</button>
          </>}
        </div>
      )}
    </div>
  );
}

function SyllabusUnitRow({ token, unit, editable, onDeactivate }) {
  const [topics, setTopics] = useState([]);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState(null);

  // Never rejects (a failed load shows no topics).
  const load = useCallback(() => api.get(`/academic/units/${unit.id}/topics`, token)
    .then(setTopics, () => setTopics([])), [unit.id, token]);
  useEffect(() => { if (open) load(); }, [open, load]);

  async function addTopic() {
    setError(null);
    try {
      await api.post(`/academic/units/${unit.id}/topics`, { title }, token);
      setTitle('');
      await load();
    } catch (e) { setError(e.message); }
  }

  async function deactivateTopic(id) {
    setError(null);
    try {
      await api.post(`/academic/topics/${id}/deactivate`, null, token);
      await load();
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
        <div><strong>{unit.code}</strong> — {unit.title}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost btn-sm" onClick={() => setOpen(!open)}>{open ? 'Hide topics' : 'Topics'}</button>
          {editable && <button className="btn-ghost btn-sm" onClick={onDeactivate}>Remove</button>}
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 6, paddingLeft: 12 }}>
          {error && <div className="alert alert-error">{error}</div>}
          {topics.map(t => (
            <div className="list-item" key={t.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <div>{t.title}</div>
                {editable && <button className="btn-ghost btn-sm" onClick={() => deactivateTopic(t.id)}>Remove</button>}
              </div>
              <SubtopicsPanel token={token} topic={t} editable={editable} />
            </div>
          ))}
          {editable && <>
          <div className="row" style={{ marginTop: 6 }}>
            <div className="field" style={{ flex: 1 }}><label>New topic</label><input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Singly linked lists" /></div>
          </div>
          <button className="btn-primary btn-sm" onClick={addTopic} disabled={!title}>Add Topic</button>
          </>}
        </div>
      )}
    </div>
  );
}

// Subtopics of one topic (spec §3, §8: Unit -> Topic -> Subtopic). A question's subtopic must be one of these.
function SubtopicsPanel({ token, topic, editable }) {
  const [open, setOpen] = useState(false);
  const [subtopics, setSubtopics] = useState([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState(null);

  async function load() {
    try { setSubtopics(await api.get(`/academic/topics/${topic.id}/subtopics`, token)); }
    catch (e) { setError(e.message); }
  }
  async function toggle() {
    if (!open) await load();
    setOpen(!open);
  }
  async function add() {
    setError(null);
    try {
      await api.post(`/academic/topics/${topic.id}/subtopics`, { title: title.trim() }, token);
      setTitle('');
      await load();
    } catch (e) { setError(e.message); }
  }
  async function remove(id) {
    setError(null);
    try {
      await api.post(`/academic/subtopics/${id}/deactivate`, null, token);
      await load();
    } catch (e) { setError(e.message); }
  }

  return (
    <div style={{ paddingLeft: 12, marginTop: 4 }}>
      <button className="btn-ghost btn-sm" onClick={toggle}>{open ? 'Hide subtopics' : 'Subtopics'}</button>
      {open && (
        <div style={{ marginTop: 4 }}>
          {error && <div className="alert alert-error">{error}</div>}
          {subtopics.length === 0 && <p className="hint">No subtopics under “{topic.title}” yet.</p>}
          {subtopics.map(st => (
            <div className="list-item" key={st.id}>
              <div>{st.title}</div>
              {editable && <button className="btn-ghost btn-sm" onClick={() => remove(st.id)}>Remove</button>}
            </div>
          ))}
          {editable && <>
          <div className="row" style={{ marginTop: 4 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor={`subtopic-${topic.id}`}>New subtopic</label>
              <input id={`subtopic-${topic.id}`} maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Left rotations" />
            </div>
          </div>
          <button className="btn-primary btn-sm" onClick={add} disabled={!title.trim()}>Add subtopic</button>
          </>}
        </div>
      )}
    </div>
  );
}

function BuildHierarchy({ token, user }) {
  const [departments, setDepartments] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [offerings, setOfferings] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [colleges, setColleges] = useState([]);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  // One list after the other, each shown as it arrives; the first failure stops the rest. Never rejects.
  const loadAll = useCallback(() => api.get('/academic/departments', token)
    .then(async (rows) => {
      setDepartments(rows);
      setPrograms(await api.get('/academic/programs', token));
      setSubjects(await api.get('/academic/subjects', token));
      setSessions(await api.get('/academic/sessions', token));
      setOfferings(await api.get('/academic/course-offerings', token));
      if (user.role === 'admin') setCampuses(await api.get('/academic/campuses', token));
    })
    .catch((e) => setError(e.message)), [token, user.role]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const [deptForm, setDeptForm] = useState({ name: '', code: '', campus_id: '', college_id: '' });
  // Department pickers (admin only): the college decides the campus and institution; nothing is defaulted silently.
  async function pickCampus(campusId) {
    setDeptForm({ ...deptForm, campus_id: campusId, college_id: '' });
    setColleges([]);
    if (!campusId) return;
    try { setColleges(await api.get(`/academic/colleges?campus_id=${campusId}`, token)); }
    catch (e) { setError(e.message); }
  }
  const [progForm, setProgForm] = useState({ name: '', code: '', department_id: '', degree_type: 'UG', duration_years: 4 });
  const [subjForm, setSubjForm] = useState({ subject_code: '', course_title: '', credits: '', theory_hours: '' });
  const [sessForm, setSessForm] = useState({ label: '', start_date: '', end_date: '' });
  const [offForm, setOffForm] = useState({ subject_id: '', program_id: '', academic_session_id: '', semester: 1, offering_code: '' });
  const [secForm, setSecForm] = useState({ course_offering_id: '', name: '', code: '' });

  async function submitForm(url, body, resetFn) {
    setError(null); setNotice(null);
    try {
      await api.post(url, body, token);
      setNotice('Created.');
      resetFn();
      await loadAll();
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      {user.role === 'admin' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 className="section-title">New department</h3>
          <div className="row">
            <div className="field"><label>Name</label><input value={deptForm.name} onChange={e => setDeptForm({ ...deptForm, name: e.target.value })} /></div>
            <div className="field"><label>Code</label><input value={deptForm.code} onChange={e => setDeptForm({ ...deptForm, code: e.target.value })} placeholder="e.g. ECE" /></div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="dept-campus">Campus</label>
              <select id="dept-campus" value={deptForm.campus_id} onChange={e => pickCampus(e.target.value)}>
                <option value="">— choose —</option>
                {campuses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dept-college">College</label>
              <select id="dept-college" value={deptForm.college_id} onChange={e => setDeptForm({ ...deptForm, college_id: e.target.value })} disabled={!deptForm.campus_id}>
                <option value="">— choose —</option>
                {colleges.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          {deptForm.campus_id && colleges.length === 0 && <p className="hint">This campus has no active college yet.</p>}
          <button className="btn-primary" onClick={() => submitForm('/academic/departments', deptForm, () => { setDeptForm({ name: '', code: '', campus_id: '', college_id: '' }); setColleges([]); })}
            disabled={!deptForm.name || !deptForm.code || !deptForm.campus_id || !deptForm.college_id}>Create department</button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">New program</h3>
        <div className="row">
          <div className="field"><label>Name</label><input value={progForm.name} onChange={e => setProgForm({ ...progForm, name: e.target.value })} placeholder="e.g. B.Tech ECE" /></div>
          <div className="field"><label>Code</label><input value={progForm.code} onChange={e => setProgForm({ ...progForm, code: e.target.value })} placeholder="e.g. BTECH-ECE" /></div>
        </div>
        {user.role === 'admin' && (
          <div className="field">
            <label>Department</label>
            <select value={progForm.department_id} onChange={e => setProgForm({ ...progForm, department_id: e.target.value })}>
              <option value="">— choose —</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}{d.campus_name ? ` (${d.campus_name})` : ''}</option>)}
            </select>
          </div>
        )}
        {user.role === 'hod' && <p className="hint">Will be created under your department automatically.</p>}
        <button className="btn-primary" onClick={() => submitForm('/academic/programs', progForm, () => setProgForm({ name: '', code: '', department_id: '', degree_type: 'UG', duration_years: 4 }))}
          disabled={!progForm.name || !progForm.code || (user.role === 'admin' && !progForm.department_id)}>Create program</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">New subject</h3>
        <div className="row">
          <div className="field"><label>Subject code</label><input value={subjForm.subject_code} onChange={e => setSubjForm({ ...subjForm, subject_code: e.target.value })} placeholder="e.g. CKT101" /></div>
          <div className="field"><label>Course title</label><input value={subjForm.course_title} onChange={e => setSubjForm({ ...subjForm, course_title: e.target.value })} placeholder="e.g. Circuit Theory" /></div>
        </div>
        <button className="btn-primary" onClick={() => submitForm('/academic/subjects', subjForm, () => setSubjForm({ subject_code: '', course_title: '', credits: '', theory_hours: '' }))}
          disabled={!subjForm.subject_code || !subjForm.course_title}>Create subject</button>
      </div>

      {user.role === 'admin' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 className="section-title">New academic session</h3>
          <div className="row">
            <div className="field"><label>Label</label><input value={sessForm.label} onChange={e => setSessForm({ ...sessForm, label: e.target.value })} placeholder="e.g. 2027-2028" /></div>
            <div className="field"><label>Start date</label><input type="date" value={sessForm.start_date} onChange={e => setSessForm({ ...sessForm, start_date: e.target.value })} /></div>
            <div className="field"><label>End date</label><input type="date" value={sessForm.end_date} onChange={e => setSessForm({ ...sessForm, end_date: e.target.value })} /></div>
          </div>
          <button className="btn-primary" onClick={() => submitForm('/academic/sessions', sessForm, () => setSessForm({ label: '', start_date: '', end_date: '' }))} disabled={!sessForm.label}>Create session</button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">New course offering</h3>
        <p className="hint" style={{ marginBottom: 10 }}>This is what teachers actually get assigned to — a subject, taught in a specific program, session, and semester.</p>
        <div className="row">
          <div className="field">
            <label>Subject</label>
            <select value={offForm.subject_id} onChange={e => setOffForm({ ...offForm, subject_id: e.target.value })}>
              <option value="">— choose —</option>
              {subjects.map(s => <option key={s.id} value={s.id}>{s.subject_code} — {s.course_title}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Program</label>
            <select value={offForm.program_id} onChange={e => setOffForm({ ...offForm, program_id: e.target.value })}>
              <option value="">— choose —</option>
              {programs.map(p => <option key={p.id} value={p.id}>{p.name}{p.department_name ? ` (${p.department_name})` : ''}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Academic session</label>
            <select value={offForm.academic_session_id} onChange={e => setOffForm({ ...offForm, academic_session_id: e.target.value })}>
              <option value="">— choose —</option>
              {sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Semester</label><input type="number" min="1" max="12" value={offForm.semester} onChange={e => setOffForm({ ...offForm, semester: e.target.value })} /></div>
        </div>
        <button className="btn-primary" onClick={() => submitForm('/academic/course-offerings', offForm, () => setOffForm({ subject_id: '', program_id: '', academic_session_id: '', semester: 1, offering_code: '' }))}
          disabled={!offForm.subject_id || !offForm.program_id || !offForm.academic_session_id}>Create course offering</button>
      </div>

      <div className="card">
        <h3 className="section-title">New section</h3>
        <div className="row">
          <div className="field">
            <label>Course offering</label>
            <select value={secForm.course_offering_id} onChange={e => setSecForm({ ...secForm, course_offering_id: e.target.value })}>
              <option value="">— choose —</option>
              {offerings.map(o => <option key={o.course_offering_id} value={o.course_offering_id}>{o.subject_code} ({o.academic_session_label}, sem {o.semester})</option>)}
            </select>
          </div>
          <div className="field"><label>Section name</label><input value={secForm.name} onChange={e => setSecForm({ ...secForm, name: e.target.value })} placeholder="e.g. A" /></div>
        </div>
        <button className="btn-primary" onClick={() => submitForm('/academic/sections', secForm, () => setSecForm({ course_offering_id: '', name: '', code: '' }))}
          disabled={!secForm.course_offering_id || !secForm.name}>Create section</button>
      </div>

      <h3 className="section-title" style={{ marginTop: 24 }}>Existing course offerings</h3>
      {offerings.map(o => (
        <div className="list-item" key={o.course_offering_id}>
          <div>{o.subject_code} — {o.course_title} · {o.program_name} · {o.academic_session_label}, sem {o.semester}</div>
          <span className="badge badge-draft">{o.status}</span>
        </div>
      ))}
    </div>
  );
}

function AssignPeople({ token }) {
  const [offerings, setOfferings] = useState([]);
  const [offeringId, setOfferingId] = useState('');
  const [teachers, setTeachers] = useState([]);
  const [reviewers, setReviewers] = useState([]);
  const [sections, setSections] = useState([]);
  const [teacherAssignments, setTeacherAssignments] = useState([]);
  const [reviewerAssignments, setReviewerAssignments] = useState([]);
  const [selectedTeacher, setSelectedTeacher] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [selectedReviewer, setSelectedReviewer] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    api.get('/academic/course-offerings', token).then(rows => {
      setOfferings(rows);
      if (rows.length > 0) setOfferingId(rows[0].course_offering_id);
    }).catch(e => setError(e.message));
    api.get('/academic/teachers', token).then(setTeachers).catch(e => setError(e.message));
    api.get('/academic/reviewers', token).then(setReviewers).catch(e => setError(e.message));
  }, [token]);

  // Sections, then teacher and reviewer assignments, each shown as it arrives. Never rejects (the error is shown).
  const loadForOffering = useCallback((id) => {
    if (!id) return Promise.resolve();
    return api.get(`/academic/sections?course_offering_id=${id}`, token)
      .then(async (rows) => {
        setSections(rows);
        setTeacherAssignments(await api.get(`/academic/assignments/teacher?course_offering_id=${id}`, token));
        setReviewerAssignments(await api.get(`/academic/assignments/reviewer?course_offering_id=${id}`, token));
      })
      .catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => { loadForOffering(offeringId); }, [loadForOffering, offeringId]);

  async function assignTeacher() {
    setError(null); setNotice(null);
    try {
      await api.post('/academic/assignments/teacher', {
        teacher_id: selectedTeacher, course_offering_id: offeringId, section_id: selectedSection || null
      }, token);
      setNotice('Teacher assigned.');
      setSelectedTeacher(''); setSelectedSection('');
      await loadForOffering(offeringId);
    } catch (e) { setError(e.message); }
  }

  async function unassignTeacher(id) {
    setError(null); setNotice(null);
    try {
      await api.post(`/academic/assignments/teacher/${id}/deactivate`, null, token);
      await loadForOffering(offeringId);
    } catch (e) { setError(e.message); }
  }

  async function assignReviewer() {
    setError(null); setNotice(null);
    try {
      await api.post('/academic/assignments/reviewer', { reviewer_id: selectedReviewer, course_offering_id: offeringId }, token);
      setNotice('Reviewer assigned.');
      setSelectedReviewer('');
      await loadForOffering(offeringId);
    } catch (e) { setError(e.message); }
  }

  async function unassignReviewer(id) {
    setError(null); setNotice(null);
    try {
      await api.post(`/academic/assignments/reviewer/${id}/deactivate`, null, token);
      await loadForOffering(offeringId);
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      <div className="field" style={{ maxWidth: 480, marginBottom: 16 }}>
        <label>Course offering</label>
        <select value={offeringId} onChange={e => setOfferingId(e.target.value)}>
          {offerings.length === 0 && <option value="">No course offerings yet — create one under "Build hierarchy" first</option>}
          {offerings.map(o => <option key={o.course_offering_id} value={o.course_offering_id}>{o.subject_code} — {o.course_title} ({o.academic_session_label}, sem {o.semester})</option>)}
        </select>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Assign a teacher</h3>
        <div className="row">
          <div className="field">
            <label>Teacher</label>
            <select value={selectedTeacher} onChange={e => setSelectedTeacher(e.target.value)}>
              <option value="">— choose —</option>
              {teachers.map(t => <option key={t.id} value={t.id}>{t.email}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Section (optional)</label>
            <select value={selectedSection} onChange={e => setSelectedSection(e.target.value)}>
              <option value="">Whole offering (no specific section)</option>
              {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <button className="btn-primary" onClick={assignTeacher} disabled={!selectedTeacher || !offeringId}>Assign teacher</button>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>Currently assigned</h4>
        {teacherAssignments.length === 0 && <p className="hint">No teachers assigned to this offering yet.</p>}
        {teacherAssignments.map(a => (
          <div className="list-item" key={a.id}>
            <div>{a.teacher_email}{a.section_name ? ` — section ${a.section_name}` : ''} <span className="meta">({a.assignment_role})</span></div>
            <button className="btn-ghost btn-sm" onClick={() => unassignTeacher(a.id)}>Remove</button>
          </div>
        ))}
      </div>

      <div className="card">
        <h3 className="section-title">Assign a reviewer</h3>
        <div className="field" style={{ maxWidth: 360 }}>
          <label>Reviewer</label>
          <select value={selectedReviewer} onChange={e => setSelectedReviewer(e.target.value)}>
            <option value="">— choose —</option>
            {reviewers.map(r => (
              <option key={r.id} value={r.id}>
                {r.full_name || r.email}{r.pending_questions != null ? ` — ${r.pending_questions} awaiting review, ${r.active_offerings} offering${r.active_offerings === 1 ? '' : 's'}` : ''}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary" onClick={assignReviewer} disabled={!selectedReviewer || !offeringId}>Assign reviewer</button>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>Currently assigned</h4>
        {reviewerAssignments.length === 0 && <p className="hint">No reviewers assigned to this offering yet.</p>}
        {reviewerAssignments.map(a => (
          <div className="list-item" key={a.id}>
            <div>{a.reviewer_email}</div>
            <button className="btn-ghost btn-sm" onClick={() => unassignReviewer(a.id)}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SecurityAudit({ token }) {
  const [audit, setAudit] = useState([]);
  const [stepUp, setStepUp] = useState([]);
  const [verify, setVerify] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/review/audit-log', token).then(setAudit).catch(e => setError(e.message));
    api.get('/review/step-up-log', token).then(setStepUp).catch(e => setError(e.message));
  }, [token]);

  async function runVerify() {
    setError(null);
    try { setVerify(await api.get('/review/audit-log/verify', token)); } catch (e) { setError(e.message); }
  }

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Tamper-evident audit chain</h3>
        <p className="hint" style={{ marginBottom: 12 }}>
          Every log entry's hash includes the previous entry's hash. If any row were edited or deleted directly in the
          database, the chain would no longer recompute — this button proves the log hasn't been altered.
        </p>
        <button className="btn-primary" onClick={runVerify}>Verify chain integrity</button>
        {verify && (
          <div className={`alert ${verify.valid ? 'alert-ok' : 'alert-error'}`} style={{ marginTop: 10 }}>
            {verify.valid ? `Chain intact — ${verify.checked} entries verified.` : `Tampering detected at entry #${verify.brokenAt}`}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Independent approval attempts</h3>
        <table>
          <thead><tr><th>When</th><th>Action</th><th>Success</th><th>IP</th></tr></thead>
          <tbody>
            {stepUp.map(s => (
              <tr key={s.id}>
                <td>{new Date(s.created_at).toLocaleString()}</td>
                <td>{s.action}</td>
                <td>{s.success ? <span className="badge badge-approved">yes</span> : <span className="badge badge-rejected">no</span>}</td>
                <td className="mono">{s.ip_address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 className="section-title">Recent activity (all users)</h3>
        <table>
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th></tr></thead>
          <tbody>
            {audit.slice(0, 40).map(a => (
              <tr key={a.id}>
                <td>{new Date(a.created_at).toLocaleString()}</td>
                <td>{a.user_email || '—'}</td>
                <td>{a.action}</td>
                <td className="mono" style={{ fontSize: '0.7rem' }}>{a.entity_id?.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ThreatMonitor({ token }) {
  const [blocked, setBlocked] = useState([]);
  const [suspicious, setSuspicious] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  // Blocked IPs, then suspicious activity, then status, each shown as it arrives. Never rejects (the error is shown).
  const load = useCallback(() => api.get('/review/security/blocked-ips', token)
    .then(async (rows) => {
      setBlocked(rows);
      setSuspicious(await api.get('/review/security/suspicious-activity', token));
      setStatus(await api.get('/review/security/status', token));
    })
    .catch((e) => setError(e.message)), [token]);
  useEffect(() => { load(); }, [load]);

  async function unblock(ip) {
    setError(null);
    try {
      await api.post(`/review/security/blocked-ips/${encodeURIComponent(ip)}/unblock`, null, token);
      await load();
    } catch (e) { setError(e.message); }
  }

  async function clearLockdown() {
    setError(null);
    try {
      await api.post('/review/security/lockdown/clear', null, token);
      await load();
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      {status?.lockdown_active && (
        <div className="alert alert-error" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>🚨 System is in restricted lockdown mode — several addresses were auto-blocked in a short window for wrong authenticator codes or failed approval attempts from signed-in sessions, suggesting a coordinated attack. Non-admin changes are paused until it expires (1h) or is cleared.</span>
          <button className="btn-primary btn-sm" onClick={clearLockdown}>Clear lockdown</button>
        </div>
      )}
      {status && !status.lockdown_active && <div className="alert alert-ok">No active lockdown. System is operating normally.</div>}

      <div className="card" style={{ marginTop: 16, marginBottom: 16 }}>
        <h3 className="section-title">Blocked IP addresses ({blocked.length})</h3>
        <p className="hint" style={{ marginBottom: 10 }}>
          IPs are auto-blocked after repeated failed logins, invalid OTP/authenticator codes, invalid approval
          attempts, or scanning behavior (repeated hits on non-existent routes). Automatic blocks expire after an
          hour; only authenticator and approval failures can trigger lockdown. Every block is permanently recorded
          in the audit log for reporting purposes.
        </p>
        {blocked.length === 0 && <p className="hint">No IPs currently blocked.</p>}
        {blocked.map(b => (
          <div className="list-item" key={b.ip}>
            <div>
              <div className="mono">{b.ip}</div>
              <div className="meta">{b.reason} · {new Date(b.blocked_at).toLocaleString()}{b.expires_at ? ` · until ${new Date(b.expires_at).toLocaleString()}` : ' · until removed'}</div>
            </div>
            <button className="btn-ghost btn-sm" onClick={() => unblock(b.ip)}>Unblock</button>
          </div>
        ))}
      </div>

      <div className="card">
        <h3 className="section-title">Recent suspicious activity</h3>
        <table>
          <thead><tr><th>When</th><th>IP</th><th>Type</th><th>Details</th></tr></thead>
          <tbody>
            {suspicious.slice(0, 50).map(s => (
              <tr key={s.id}>
                <td>{new Date(s.created_at).toLocaleString()}</td>
                <td className="mono">{s.ip}</td>
                <td>{s.activity_type.replace(/_/g, ' ')}</td>
                <td className="mono" style={{ fontSize: '0.7rem' }}>{s.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
