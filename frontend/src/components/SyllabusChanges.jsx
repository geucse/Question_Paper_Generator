import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import QuestionStatusBadge from './QuestionStatusBadge';
import { SyllabusPicker } from './SyllabusPicker';
import { Messages, Pending } from './ui';
import { useAsync } from '../lib/useAsync';
import { CHANGE_LABEL, ENTITY_LABEL, useSyllabusTree } from '../lib/syllabus';

// Syllabus change follow-up (migration 042). When a new syllabus version is approved, questions mapped only to
// unchanged items move to it automatically; questions on removed, changed or renamed items are listed here per change:
//   HOD       maps a question onto the current version (with a reason) or retires an ACTIVE one;
//   reviewer  requests changes on an ACTIVE or APPROVED one (it goes back to its author, who re-maps it by editing).
// Every action is checked again by the server (scope, state, the ids belong to the version).
const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
const MAPPABLE = ['SUBMITTED', 'RESUBMITTED', 'APPROVED', 'ACTIVE', 'RETIRED'];
const short = (t, n = 160) => (String(t || '').length > n ? `${String(t).slice(0, n)}…` : String(t || ''));

// Render with key={path} so a new path starts from an empty report.
export function SyllabusChangeReport({ token, user, path }) {
  const [report, setReport] = useState(null);
  const [mapping, setMapping] = useState(null);
  const { error, reasons, ok, run } = useAsync();
  const load = useCallback(() => run(async () => setReport(await api.get(path, token))), [path, token, run]);
  useEffect(() => { load(); }, [load]);

  async function retire(q) {
    const reason = window.prompt('Reason for retiring this question:', 'Syllabus changed');
    if (!reason || reason.trim().length < 3) return;
    await run(() => api.post(`/question-bank/${q.question_id}/transition`, { target_status: 'RETIRED', reason: reason.trim() }, token), 'Question retired.');
    await load();
  }
  async function requestChanges(q) {
    const reason = window.prompt('What should the author change? (sent with the question)', 'The syllabus changed: re-map the question to the current syllabus and resubmit it');
    if (!reason || reason.trim().length < 3) return;
    await run(() => api.post(`/question-bank/${q.question_id}/transition`, { target_status: 'CHANGES_REQUESTED', reason: reason.trim() }, token), 'Sent back to the author.');
    await load();
  }

  if (!report) return <Pending error={error} reasons={reasons} what="syllabus changes" />;
  if (!report.version) return <p className="hint">This offering has no active syllabus version yet.</p>;
  const isHod = user.role === 'hod';
  const affected = report.changes.flatMap((c) => c.affected_questions);
  const open = new Set(affected.filter((a) => !a.resolved).map((a) => a.question_id)).size;
  return (
    <div>
      <Messages error={error} reasons={reasons} ok={ok} />
      <p className="meta">
        Version {report.version.version_number}{report.previous_version ? ` replaced version ${report.previous_version.version_number}` : ''}:
        {' '}{report.changes.length} change(s); {report.questions_remapped_unchanged} question(s) moved automatically (every item unchanged);
        {' '}{open} affected question(s) still need attention.
      </p>
      {report.changes.length === 0 && <p className="hint">No changes were recorded for this version.</p>}
      {report.changes.map((c) => (
        <div key={c.id} className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div>
            <strong>{ENTITY_LABEL[c.entity_type] || c.entity_type} “{c.entity_id}” {CHANGE_LABEL[c.change_type] || c.change_type}</strong>
            <span className="hint"> · {c.match_rule}</span>
          </div>
          {c.old_value && c.new_value && (
            <div className="hint">Was: {Object.values(c.old_value).join(' · ')} → now: {Object.values(c.new_value).join(' · ')}</div>
          )}
          {c.affected_questions.length === 0 && <div className="hint">No question was mapped to it.</div>}
          {c.affected_questions.map((q) => (
            <div key={`${c.id}-${q.question_id}`} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
              <div>{short(q.question_text)}</div>
              <div className="meta">
                <QuestionStatusBadge status={q.question_status} />
                {' '}{q.action_taken === 'changes_requested' ? 'sent back to its author at activation' : 'flagged at activation'}
                {q.author_email ? ` · by ${q.author_email}` : ''}
                {' · '}{q.resolved ? (q.on_new_version ? 'resolved: on the current version' : `resolved: ${q.question_status.toLowerCase()}`) : 'needs attention'}
              </div>
              {!q.resolved && (
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  {isHod && MAPPABLE.includes(q.question_status) && (
                    <button className="btn-ghost btn-sm" onClick={() => setMapping(mapping === q.question_id ? null : q.question_id)}>
                      {mapping === q.question_id ? 'Close mapping' : `Map to version ${report.version.version_number}`}
                    </button>
                  )}
                  {isHod && q.question_status === 'ACTIVE' && <button className="btn-danger btn-sm" onClick={() => retire(q)}>Retire</button>}
                  {!isHod && !q.is_mine && ['ACTIVE', 'APPROVED'].includes(q.question_status) && (
                    <button className="btn-ghost btn-sm" onClick={() => requestChanges(q)}>Request changes</button>
                  )}
                  {['DRAFT', 'CHANGES_REQUESTED'].includes(q.question_status) && <span className="hint">The author re-maps it by editing it.</span>}
                  {q.question_status === 'UNDER_REVIEW' && <span className="hint">In review: its reviewers decide first; then the HOD maps it.</span>}
                </div>
              )}
              {isHod && mapping === q.question_id && (
                <MappingForm token={token} question={{ id: q.question_id, course_offering_id: q.course_offering_id || report.version.course_offering_id }}
                  onDone={() => { setMapping(null); load(); }} />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// The HOD maps one question onto its offering's ACTIVE version: unit > topic > subtopic and COs from that version,
// the Bloom level when it has no verified one yet (or to correct it), and a reason (recorded with old and new values).
export function MappingForm({ token, question, onDone }) {
  const { tree, error: treeError } = useSyllabusTree(token, `/academic/course-offerings/${question.course_offering_id}/syllabus-tree`);
  const [place, setPlace] = useState({ unitId: '', topicId: '', subtopicId: '' });
  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState([]);
  const [bloom, setBloom] = useState('');
  const [reason, setReason] = useState('');
  const { error, reasons, ok, run } = useAsync();

  async function submit() {
    const r = await run(() => api.post(`/academic/questions/${question.id}/syllabus-mapping`, {
      syllabus_unit_id: place.unitId || undefined, syllabus_topic_id: place.topicId, syllabus_subtopic_id: place.subtopicId || undefined,
      primary_course_outcome_id: primary, secondary_course_outcome_ids: secondary, bloom_level: bloom || undefined, reason: reason.trim(),
    }, token));
    if (r) onDone(r);
  }

  if (!tree) return <Pending error={treeError} what="the current syllabus" />;
  const cos = tree.course_outcomes || [];
  return (
    <div className="card" style={{ background: '#fbfaf7', marginTop: 6 }}>
      <div className="hint">Map onto syllabus version {tree.version_number} (the offering&apos;s current one).</div>
      <div className="row">
        <SyllabusPicker tree={tree} idPrefix={`map-${question.id}`} value={place} onChange={setPlace} />
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor={`map-${question.id}-co`}>Primary CO</label>
          <select id={`map-${question.id}-co`} value={primary} onChange={(e) => { setPrimary(e.target.value); setSecondary(secondary.filter((x) => x !== e.target.value)); }}>
            <option value="">—</option>
            {cos.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.description}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`map-${question.id}-bloom`}>Bloom level (needed when the question has no verified one)</label>
          <select id={`map-${question.id}-bloom`} value={bloom} onChange={(e) => setBloom(e.target.value)}>
            <option value="">— keep the verified level —</option>
            {BLOOM_LEVELS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>
      {cos.length > 1 && primary && (
        <div className="field">
          <label>Secondary COs (optional)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {cos.filter((c) => c.id !== primary).map((c) => (
              <label key={c.id} style={{ fontWeight: 400, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={secondary.includes(c.id)}
                  onChange={(e) => setSecondary(e.target.checked ? [...secondary, c.id] : secondary.filter((x) => x !== c.id))} />
                {c.code}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor={`map-${question.id}-reason`}>Reason (at least 10 characters; recorded with the old and new mapping)</label>
        <input id={`map-${question.id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The topic is unchanged in the new syllabus" />
      </div>
      <Messages error={error} reasons={reasons} ok={ok} />
      <button className="btn-primary btn-sm" onClick={submit} disabled={!place.topicId || !primary || reason.trim().length < 10}>Map question</button>
    </div>
  );
}

// The HOD's list of questions that need a syllabus mapping: legacy ones without a version, ones left on a superseded
// version, and APPROVED / ACTIVE / RETIRED ones on the current version without a reviewer-verified mapping (they are
// not generation-eligible until mapped or re-reviewed).
const KIND_LABEL = {
  no_syllabus_version: 'No syllabus version (legacy)', superseded_version: 'On a superseded version', unverified_mapping: 'Mapping not reviewer-verified',
};
export function QuestionMapping({ token }) {
  const [offerings, setOfferings] = useState([]);
  const [offering, setOffering] = useState('');
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [notice, setNotice] = useState('');
  const { error, reasons, run } = useAsync();
  useEffect(() => { api.get('/academic/course-offerings', token).then(setOfferings).catch(() => setOfferings([])); }, [token]);
  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (offering) qs.set('course_offering_id', offering);
    if (kind) qs.set('kind', kind);
    return run(async () => setRows((await api.get(`/academic/question-mapping${qs.toString() ? `?${qs}` : ''}`, token)).questions));
  }, [offering, kind, token, run]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="alert alert-info" style={{ marginBottom: 12 }}>
        Questions here cannot reach a new paper until they are mapped to the offering&apos;s current syllabus with reviewer-verified
        (or HOD-verified) topic, CO and Bloom level. Nothing is guessed: each mapping is your decision, recorded with a reason.
      </div>
      <div className="row">
        <div className="field" style={{ maxWidth: 420 }}>
          <label htmlFor="map-offering">Course offering</label>
          <select id="map-offering" value={offering} onChange={(e) => setOffering(e.target.value)}>
            <option value="">All offerings in your scope</option>
            {offerings.map((o) => <option key={o.course_offering_id} value={o.course_offering_id}>{o.subject_code} — {o.course_title} ({o.academic_session_label}, sem {o.semester})</option>)}
          </select>
        </div>
        <div className="field" style={{ maxWidth: 300 }}>
          <label htmlFor="map-kind">Kind</label>
          <select id="map-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <Messages error={error} reasons={reasons} ok={notice} />
      {!rows ? <Pending error={error} what="questions" /> : rows.length === 0 ? <p className="hint">No question needs a syllabus mapping.</p> : rows.map((q) => (
        <div key={q.id} className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div>{short(q.question_text, 200)}</div>
          <div className="meta">
            <QuestionStatusBadge status={q.question_status} /> {KIND_LABEL[q.kind]} · {q.subject_code} {q.offering_code || ''}
            {q.version_number ? ` · on version ${q.version_number}` : ''}{q.current_version_number ? ` · current version ${q.current_version_number}` : ' · no current version'}
            {(q.syllabus_changes || []).length > 0 && ` · affected by: ${q.syllabus_changes.map((c) => `${ENTITY_LABEL[c.entity_type]} “${c.entity_id}” ${CHANGE_LABEL[c.change_type]}`).join('; ')}`}
          </div>
          <div style={{ marginTop: 4 }}>
            {q.in_review_round ? <span className="hint">In an open review round: its reviewers decide first.</span>
              : !MAPPABLE.includes(q.question_status) ? <span className="hint">The author re-maps it by editing it.</span>
                : !q.current_version_id ? <span className="hint">Approve a syllabus version for this offering first.</span>
                  : <button className="btn-ghost btn-sm" onClick={() => setOpen(open === q.id ? null : q.id)}>{open === q.id ? 'Close' : 'Map'}</button>}
          </div>
          {open === q.id && (
            <MappingForm token={token} question={q} onDone={(r) => {
              setOpen(null);
              setNotice(`Mapped to version ${r.version_number}. ${r.generation_eligible ? 'It is generation-eligible.' : 'It is not generation-eligible yet (it needs ACTIVE status and every verified field).'}`);
              load();
            }} />
          )}
        </div>
      ))}
    </div>
  );
}

// Reviewers: the change report of each offering they are assigned to (they cannot list versions themselves).
export function ReviewerSyllabusChanges({ token, user }) {
  const [offerings, setOfferings] = useState([]);
  const [offering, setOffering] = useState('');
  useEffect(() => {
    api.get('/academic/my-reviewer-assignments', token).then((rows) => {
      setOfferings(rows);
      if (rows.length) setOffering(rows[0].course_offering_id);
    }).catch(() => setOfferings([]));
  }, [token]);
  return (
    <div className="card">
      <h3 className="section-title">Syllabus changes</h3>
      <p className="hint">After a new syllabus version is approved, questions on changed items are listed here. Request changes on an ACTIVE or APPROVED one to send it back to its author.</p>
      {offerings.length === 0 ? <p className="hint">You are not assigned to any course offering.</p> : (
        <>
          <div className="field" style={{ maxWidth: 480 }}>
            <label htmlFor="rsc-offering">Course offering</label>
            <select id="rsc-offering" value={offering} onChange={(e) => setOffering(e.target.value)}>
              {offerings.map((o) => <option key={o.course_offering_id} value={o.course_offering_id}>{o.subject_code} — {o.course_title} ({o.academic_session_label})</option>)}
            </select>
          </div>
          {offering && <SyllabusChangeReport key={offering} token={token} user={user} path={`/academic/course-offerings/${offering}/syllabus-changes`} />}
        </>
      )}
    </div>
  );
}
