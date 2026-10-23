import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { typeLabel, fromPaperQuestion } from '../../lib/questionTypes';
import { Messages, Pending, StatusBadge, Tabs } from '../../components/ui';
import { useAsync } from '../../lib/useAsync';
import QuestionView from '../../components/QuestionView';
import PdfActions, { PaperOutput } from '../../components/PdfActions';
import ValidationSummary from '../../components/ValidationSummary';
import { SectionedQuestions, InternalChoiceSummary, OverrideNotice, PrintedAs, CoChips } from '../../components/PaperSections';
import { printedLabel } from '../../lib/printLabels';

const CHECKLIST = [
  ['question_correctness', 'Question correctness'], ['syllabus_relevance', 'Syllabus relevance'], ['co_mapping_correct', 'CO mapping'],
  ['bloom_levels_correct', 'Bloom levels'], ['difficulty_appropriate', 'Difficulty'], ['marks_distribution_ok', 'Marks'],
  ['formatting_ok', 'Formatting'], ['numbering_correct', 'Numbering'], ['spelling_grammar_ok', 'Spelling / grammar'],
  ['instructions_clear', 'Instructions'], ['layout_acceptable', 'Layout'],
];
// Same list as backend/src/paper-policy.js ISSUE_TYPES (and the 028 CHECK constraint); keep in sync.
const ISSUE_TYPES = ['spelling', 'grammar', 'incorrect', 'unclear', 'formatting', 'wrong_co', 'wrong_bloom', 'wrong_difficulty',
  'duplicate', 'missing_answer', 'wrong_marks', 'syllabus_mismatch', 'other'];
// Statuses in which validators may open the paper and report issues (paper-policy.js VALIDATOR_ACCESS_STATUSES).
const UNDER_VALIDATION = ['VALIDATION_PENDING', 'VALIDATED'];
const ENDED_REASON = {
  replaced: 'replaced by the COE', reassigned: 'reassigned by the COE', paper_regenerated: 'paper superseded by a new revision',
  paper_archived: 'paper archived', paper_reset: 'validation restarted by the technical admin',
};
const fmt = (d) => (d ? new Date(d).toLocaleString() : '');

export default function ValidatorDashboard({ token }) {
  const [queue, setQueue] = useState([]);
  const [open, setOpen] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const { error, run } = useAsync();
  const load = useCallback(() => run(async () => { setQueue(await api.get('/validators/my-validations', token)); setLoaded(true); }), [token, run]);
  useEffect(() => { load(); }, [load]);

  const back = () => { setOpen(null); load(); };
  const nav = <Tabs primary tabs={[['queue', 'Validation queue'], ...(open ? [['paper', 'Paper review']] : [])]} active={open ? 'paper' : 'queue'}
    onChange={(k) => { if (k === 'queue') back(); }} />;
  if (open) return <div>{nav}<Review token={token} paperId={open} onBack={back} /></div>;
  return (
    <div>
      {nav}
      {!loaded && <Pending error={error} what="your validation queue" />}
      {loaded && <Messages error={error} reasons={[]} ok="" />}
      {loaded && queue.length === 0 && <div className="empty-state">No papers assigned to you.</div>}
      {queue.map((q) => (
        <div key={q.assignment_id} className="list-item row" style={{ justifyContent: 'space-between' }}>
          <div>
            {q.subject_code} · {q.exam_type} · v{q.paper_version} <StatusBadge status={q.paper_status} />{' '}
            <span className="hint">validator {q.validator_number}, round {q.validation_round}</span>
            <div className="hint">
              Your decision: {q.decision ? <><StatusBadge status={q.decision} /> on {fmt(q.decided_at)}</> : 'not decided'}
              {!q.is_active && <> · <span className="badge badge-draft">Assignment ended: {ENDED_REASON[q.deactivation_reason] || q.deactivation_reason}</span></>}
              {q.is_active && !q.can_open && <> · Paper is now {String(q.paper_status).replaceAll('_', ' ')}; validators no longer have access</>}
            </div>
            {q.decision && q.comments && <div className="hint">Your comments: “{q.comments}”</div>}
          </div>
          {q.can_open && <button className="btn-ghost btn-sm" onClick={() => setOpen(q.paper_id)}>{q.decision ? 'Open' : 'Review'}</button>}
        </div>
      ))}
    </div>
  );
}

function Review({ token, paperId, onBack }) {
  const [paper, setPaper] = useState(null);
  const [issues, setIssues] = useState([]);
  const [checks, setChecks] = useState({});
  const [comments, setComments] = useState('');
  const [issue, setIssue] = useState({ question_id: '', issue_type: 'spelling', description: '' });
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const { error, reasons, ok, run } = useAsync();
  const load = useCallback(async () => {
    setPaper(await api.get(`/examinations/papers/${paperId}`, token));
    setIssues(await api.get(`/examinations/papers/${paperId}/issues`, token));
  }, [paperId, token]);
  useEffect(() => { run(load); }, [load, run]);

  if (!paper) return <Pending error={error} reasons={reasons} what="the paper" />;
  const allChecked = CHECKLIST.every(([k]) => checks[k]);
  const mine = paper.my_assignment;
  const canDecide = paper.paper_status === 'VALIDATION_PENDING' && mine && !mine.decision && !refused;
  const canReport = UNDER_VALIDATION.includes(paper.paper_status);
  const descLen = issue.description.trim().length;

  async function decide(decision, msg) {
    setBusy(true);
    try {
      const out = await run(async () => {
        try { return await api.post(`/validators/papers/${paperId}/validate`, { decision, checklist: checks, comments }, token); } catch (e) {
          // Eligibility is re-checked when you decide (scope, account, conflicts); the server has told the COE.
          if (e.status === 403 && e.data?.reasons?.length) setRefused(true);
          throw e;
        }
      }, msg);
      if (out) await load();
    } finally { setBusy(false); }
  }

  return (
    <div>
      <button className="btn-ghost btn-sm" onClick={onBack}>← Back</button>
      <h3>{paper.title} <StatusBadge status={paper.paper_status} /></h3>
      <p className="hint">You review the paper only. Each question shows its answer key and model answer from the paper&apos;s snapshot. Source questions in the bank cannot be edited from here; report an issue instead.</p>
      <PaperOutput status={paper.paper_status}>
        <PdfActions token={token} run={run} path={`/examinations/papers/${paperId}/pdf?include_answers=1`} filename="paper-for-validation.pdf" label="PDF with answer key" title="Paper with answer key" />
      </PaperOutput>
      <Messages error={error} reasons={reasons} ok={ok} />
      {refused && <div className="alert alert-warn">You can no longer decide on this paper; the COE has been notified to replace you.</div>}

      {paper.blueprint?.target_mode === 'legacy_soft' && (
        <div className="alert alert-info">Generated from a legacy blueprint with advisory CO/Bloom targets (before exact targets were enforced); check the target table below.</div>
      )}
      <OverrideNotice override={paper.constraint_overrides} />
      {paper.send_backs?.length > 0 && (
        <div className="alert alert-info">The COE sent an earlier state of this paper back: {paper.send_backs[0].reason}</div>
      )}
      <ValidationSummary view={paper.validation_view} />

      <div className="card">
        <InternalChoiceSummary paper={paper} />
        <SectionedQuestions paper={paper} renderQuestion={(q) => (
          <div className="list-item" style={{ display: 'block' }}>
            <strong>Q{q.slot_number}.</strong><PrintedAs q={q} /> <span className="badge badge-draft">{q.marks} marks</span><CoChips q={q} />
            <QuestionView q={fromPaperQuestion(q)} token={token} fileUrl={(a) => `/examinations/papers/${paperId}/attachments/${a.id}`} />
            <div className="hint">{typeLabel(q.meta?.question_type)} · {q.meta?.difficulty} · {q.meta?.bloom_level} · {q.meta?.topic}{q.meta?.subtopic ? ` › ${q.meta.subtopic}` : ''}</div>
          </div>
        )} />
      </div>

      {issues.length > 0 && (
        <div className="card"><h4>Your reported issues</h4>
          {issues.map((i) => (
            <div key={i.id} className="list-item">
              {i.slot_number ? `Q${i.slot_number} · ` : 'Whole paper · '}<strong>{i.issue_type}</strong> — {i.description} <StatusBadge status={i.status} />
              {i.resolution && <div className="hint">Resolution: {i.resolution}</div>}
              {i.status === 'carried_forward' && <div className="hint">Carried to the next revision of this paper.</div>}
            </div>
          ))}
        </div>
      )}

      {canReport ? (
        <div className="card"><h4>Report an issue</h4>
          <div className="grid-2">
            <div className="field"><label htmlFor="issue-q">Question</label>
              <select id="issue-q" value={issue.question_id} onChange={(e) => setIssue({ ...issue, question_id: e.target.value })}>
                <option value="">Whole paper</option>
                {paper.questions.map((q) => <option key={q.question_id} value={q.question_id}>{printedLabel(q)}</option>)}
              </select></div>
            <div className="field"><label htmlFor="issue-type">Type</label>
              <select id="issue-type" value={issue.issue_type} onChange={(e) => setIssue({ ...issue, issue_type: e.target.value })}>{ISSUE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
          </div>
          <div className="field"><label htmlFor="issue-desc">Description ({descLen}/2000, at least 5 characters)</label>
            <textarea id="issue-desc" maxLength={2000} value={issue.description} onChange={(e) => setIssue({ ...issue, description: e.target.value })} /></div>
          <button className="btn-ghost btn-sm" disabled={busy || descLen < 5} onClick={async () => {
            setBusy(true);
            try {
              const out = await run(() => api.post(`/examinations/papers/${paperId}/issues`, { ...issue, description: issue.description.trim(), question_id: issue.question_id || undefined }, token), 'Issue reported');
              if (out) { setIssue({ ...issue, description: '' }); await load(); }
            } finally { setBusy(false); }
          }}>Report issue</button>
        </div>
      ) : (
        <p className="hint">Issues can be reported while the paper is under validation or validated.</p>
      )}

      {mine?.decision ? (
        <div className="card"><h4>Your decision (validator {mine.validator_number}, round {mine.validation_round})</h4>
          <p><StatusBadge status={mine.decision} /> <span className="hint">{fmt(mine.decided_at)}</span></p>
          {mine.comments && <p className="hint">Comments: “{mine.comments}”</p>}
          <ul style={{ margin: '4px 0 0 18px' }}>
            {CHECKLIST.map(([k, label]) => <li key={k}>{mine.checklist_results?.[k] ? '✓' : '✗'} {label}</li>)}
          </ul>
          <p className="hint">A recorded decision is final.</p>
        </div>
      ) : canDecide && (
        <div className="card"><h4>Your decision</h4>
          {CHECKLIST.map(([k, label]) => (
            <label key={k} style={{ display: 'block', margin: '4px 0' }}>
              <input type="checkbox" checked={!!checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} /> {label}
            </label>
          ))}
          <div className="field"><label htmlFor="decision-comments">Comments (required for “changes required”)</label><textarea id="decision-comments" value={comments} onChange={(e) => setComments(e.target.value)} /></div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn-primary" disabled={busy || !allChecked} onClick={() => decide('APPROVE', 'Approval recorded')}>Approve</button>
            <button className="btn-danger" disabled={busy || !comments.trim()} onClick={() => decide('CHANGES_REQUIRED', 'Changes requested')}>Changes required</button>
          </div>
        </div>
      )}
    </div>
  );
}
