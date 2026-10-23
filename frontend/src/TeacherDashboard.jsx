import { useCallback, useEffect, useState, useRef } from 'react';
import { api } from './api';
import TypeSpecificFields from './components/TypeSpecificFields';
import QuestionView from './components/QuestionView';
import QuestionStatusBadge from './components/QuestionStatusBadge';
import { QUESTION_STATES } from './lib/questionStates';
import { QUESTION_TYPES, normalizeType, typeLabel, typesInGroup, withQuestionType } from './lib/questionTypes';
import { SyllabusPicker } from './components/SyllabusPicker';
import { locateInTree, useSyllabusTree } from './lib/syllabus';
import SyllabusReadOnly from './components/SyllabusReadOnly';

const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
// Automated (AI) findings are advisory: they never change a question's status (spec §39 inv. 10).
const aiFindings = (q) => { try { const v = JSON.parse(q?.ai_review_notes || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
// The author may dispute findings while the question is with the HOD / reviewers and still undecided.
const DISPUTABLE = ['SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW'];
// Only these states can be edited (the server enforces it; the DB locks approved content).
const EDITABLE = ['DRAFT', 'CHANGES_REQUESTED'];
const groupOf = (t) => (QUESTION_TYPES.find((x) => x.code === normalizeType(t)) || {}).group || 'subjective';
const DRAFT_REASON = { needs_diagram: 'attach the diagram', duplicate_candidate: 'resolve the possible duplicate' };

export default function TeacherDashboard({ token, user, reviseId, onReviseOpened }) {
  const [qType, setQType] = useState('objective'); // which section: objective or subjective
  const [tab, setTab] = useState('compose');
  const [questions, setQuestions] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [form, setForm] = useState(emptyForm('objective'));
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const fileInputRef = useRef();
  const bulkInputRef = useRef();
  const [bulkResult, setBulkResult] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [assignmentId, setAssignmentId] = useState(null);
  const [courseOutcomes, setCourseOutcomes] = useState([]);
  const [primaryCO, setPrimaryCO] = useState('');
  const [secondaryCOs, setSecondaryCOs] = useState([]);
  const [editingStatus, setEditingStatus] = useState(null); // question_status of the question in the form (null = new)
  const [editingReason, setEditingReason] = useState(null); // the reviewer's change request, when revising
  const [disputeFor, setDisputeFor] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  // The offering and syllabus version of the question in the form (null = a new question for the selected assignment).
  const [editingOffering, setEditingOffering] = useState(null);
  const [editingVersion, setEditingVersion] = useState(null);
  // The latest onReviseOpened, so the revise effect below fires only when reviseId changes (the parent may pass a
  // new function on every render).
  const onReviseOpenedRef = useRef(onReviseOpened);
  useEffect(() => { onReviseOpenedRef.current = onReviseOpened; });

  useEffect(() => {
    api.get('/academic/my-assignments', token).then(rows => {
      setAssignments(rows);
      if (rows.length > 0) setAssignmentId(rows[0].assignment_id);
    }).catch(e => setError(e.message));
  }, [token]);

  const selectedAssignment = assignments.find(a => a.assignment_id === assignmentId) || null;
  // A previewed question lists its own offering's COs (a revision may belong to another offering).
  const coOfferingId = previewData?.question?.course_offering_id || selectedAssignment?.course_offering_id;

  // Unit > topic > subtopic of the offering's current (ACTIVE) syllabus version (migration 042): the form offers only these.
  const formOfferingId = editingOffering || selectedAssignment?.course_offering_id || null;
  const { tree } = useSyllabusTree(token, formOfferingId ? `/academic/course-offerings/${formOfferingId}/syllabus-tree` : null);
  const hasSyllabus = !!tree?.units?.length;
  // A question loaded into the form carries its stored titles (and subtopic id) until the teacher picks again: they are
  // found in the current tree (an earlier version's topic that no longer exists stays unselected).
  const picked = hasSyllabus && !form.syllabus_unit_id && !form.syllabus_topic_id && form.topic
    ? locateInTree(tree, { topic: form.topic, subtopic: form.subtopic, subtopicId: form.subtopic_id })
    : { unitId: form.syllabus_unit_id, topicId: form.syllabus_topic_id, subtopicId: form.subtopic_id };

  // An empty form (a new question) in the given Objective/Subjective section.
  function clearForm(type) {
    setForm(emptyForm(type)); setEditingId(null); setEditingStatus(null); setEditingReason(null);
    setEditingOffering(null); setEditingVersion(null);
  }
  function resetForm() { clearForm(qType); }

  // Without an offering there are no COs: cleared while rendering as soon as coOfferingId becomes empty (React's
  // "adjust state when a value changes" pattern); with one, the effect below fetches them.
  const [coOutcomesFor, setCoOutcomesFor] = useState(coOfferingId);
  if (coOutcomesFor !== coOfferingId) {
    setCoOutcomesFor(coOfferingId);
    if (!coOfferingId) setCourseOutcomes([]);
  }
  useEffect(() => {
    if (!coOfferingId) return;
    api.get(`/academic/course-offerings/${coOfferingId}/course-outcomes`, token)
      .then(setCourseOutcomes)
      .catch(() => setCourseOutcomes([]));
  }, [coOfferingId, token]);

  function emptyForm(type) {
    // type is the Objective/Subjective tab; the specific question type defaults to the first type of that group.
    return { question_type: typesInGroup(type)[0].code, question_text: '', option_a: '', option_b: '', option_c: '', option_d: '', correct_answer: '', model_answer: '',
      difficulty: 'medium', bloom_level: '', topic: '', subtopic: '', marks: 1, answer_data: {},
      syllabus_unit_id: '', syllabus_topic_id: '', subtopic_id: '' };
  }

  // The current section's questions; reloaded whenever the section changes. Never rejects (the error is shown).
  const loadMine = useCallback(() => api.get(`/questions/mine?type=${qType}`, token)
    .then(setQuestions, (e) => setError(e.message)), [qType, token]);
  useEffect(() => { loadMine(); }, [loadMine]);

  // Switching the Objective/Subjective section starts a new question there (the list reloads via loadMine).
  function switchType(type) {
    if (type !== qType) {
      setQType(type);
      clearForm(type);
      setAiResult(null);
    }
    setTab('compose');
  }

  // Returns the question id once saved (undefined when the save was refused; the reason is shown).
  async function saveDraft(andPreview) {
    setError(null);
    if (!editingId && !selectedAssignment) {
      setError('No course offering selected — you need an active assignment before you can submit questions.');
      return undefined;
    }
    try {
      const marksNum = Number(form.marks);
      const { fill_blank_text: _typed, syllabus_unit_id: _unit, ...fields } = form; // form helpers, not data
      // With a syllabus the topic and subtopic are sent as ids (the server checks them against the current version and
      // stores the titles); without one the topic is free text and there is no subtopic.
      const placement = hasSyllabus
        ? { syllabus_topic_id: picked.topicId || undefined, subtopic_id: picked.subtopicId || undefined, topic: undefined, subtopic: undefined }
        : { syllabus_topic_id: undefined, subtopic_id: undefined, subtopic: undefined };
      const payload = {
        ...fields, ...placement, id: editingId || undefined, marks: marksNum,
        ...(editingId ? {} : { course_offering_id: selectedAssignment.course_offering_id, section_id: selectedAssignment.section_id }),
      };
      const res = await api.post('/questions/draft', payload, token);
      const id = editingId || res.id;
      setEditingId(id);
      setEditingStatus(res.question_status || editingStatus || 'DRAFT');
      await loadMine();
      if (andPreview) await openPreview(id);
      setNotice('Draft saved.');
      return id;
    } catch (e) {
      setError(e.data?.details ? e.data.details.join(' · ') : e.message);
      return undefined;
    }
  }

  async function openPreview(id) {
    setError(null);
    try {
      const data = await api.get(`/questions/${id}/preview`, token);
      setPreviewData(data);
      setEditingId(id);
      setEditingStatus(data.question.question_status);
      setAiResult(null);
      setPrimaryCO(''); setSecondaryCOs([]);
      // A question that already has a canonical question keeps its CO mapping unless the teacher changes it.
      if (data.question.canonical_question_id) {
        const c = await api.get(`/questions/${id}/canonical`, token).catch(() => null);
        const cos = c?.courseOutcomes || [];
        setPrimaryCO(cos.find((x) => x.relationship_type === 'primary')?.course_outcome_id || '');
        setSecondaryCOs(cos.filter((x) => x.relationship_type === 'secondary').map((x) => x.course_outcome_id));
      }
      setTab('preview');
    } catch (e) {
      setError(e.message);
    }
  }

  // Only state setters inside: stable, so the revise effect below can depend on it.
  const loadIntoForm = useCallback((q) => {
    setForm({
      question_type: normalizeType(q.question_type), question_text: q.question_text, option_a: q.option_a || '', option_b: q.option_b || '',
      option_c: q.option_c || '', option_d: q.option_d || '', correct_answer: q.correct_answer || '', model_answer: q.model_answer || '',
      difficulty: q.difficulty, bloom_level: q.submitted_bloom_level || '', topic: q.topic || '', subtopic: q.subtopic || '', marks: q.marks,
      answer_data: q.answer_data || {}, syllabus_unit_id: '', syllabus_topic_id: '', subtopic_id: q.subtopic_id || ''
    });
    setEditingOffering(q.course_offering_id || null);
    setEditingVersion(q.syllabus_version_id || null);
    setEditingId(q.id);
    setEditingStatus(q.question_status || 'DRAFT');
    setEditingReason(q.change_request_reason || null);
    setTab('compose');
  }, []);

  // 'Revise & resubmit' from the Question status tab: open that question in the form, switching the
  // Objective/Subjective section to the one its type belongs to (a no-op when it already is the current one).
  useEffect(() => {
    if (!reviseId) return;
    api.get(`/questions/${reviseId}/preview`, token)
      .then((data) => {
        setQType(groupOf(data.question.question_type));
        setAiResult(null);
        loadIntoForm(data.question);
      })
      .catch((e) => setError(e.message))
      .finally(() => onReviseOpenedRef.current?.());
  }, [reviseId, token, loadIntoForm]);

  // A file can be chosen while composing: an unsaved question is saved as a draft first (files belong to a
  // saved question), then the file is attached and the preview opens.
  async function handleAttach(e) {
    const file = e.target.files[0];
    if (!file) return;
    setError(null);
    try {
      const id = editingId || await saveDraft(false);
      if (!id) return; // the save was refused; its reason is shown
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.postForm(`/attachments/${id}`, fd, token);
      await openPreview(id);
      if (res.warning) setError(res.warning);
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // A file the virus scanner could not check stays quarantined; the author can ask for another scan.
  async function rescanAttachment(attId) {
    setError(null);
    try {
      const res = await api.post(`/attachments/${attId}/rescan`, null, token);
      await openPreview(editingId || previewData?.question?.id);
      if (res.warning) setError(res.warning); // after the reload, which clears messages
    } catch (e) {
      setError(e.data?.error || e.message);
    }
  }

  async function removeAttachment(attId) {
    setError(null);
    try {
      await api.del(`/attachments/${attId}`, token);
      await openPreview(editingId);
    } catch (e) {
      setError(e.data?.error || e.message);
    }
  }

  async function finalSubmit() {
    setError(null);
    try {
      const body = {};
      if (primaryCO) body.primary_course_outcome_id = primaryCO;
      if (secondaryCOs.length > 0) body.secondary_course_outcome_ids = secondaryCOs;
      const res = await api.post(`/questions/${editingId}/submit`, body, token);
      setNotice(res.question_status === 'RESUBMITTED'
        ? `${res.version_unchanged ? 'Resubmitted (no content changes).' : `Resubmitted as version ${res.version_number}.`} The HOD will send it back to a reviewer. Running the automated check (advisory) now...`
        : 'Submitted. Running the automated check (advisory) now...');
      setEditingStatus(res.question_status);
      setEditingReason(null);
      await openPreview(editingId); // the buttons lock: the question is no longer editable
      await runAiReview(editingId);
      await loadMine();
    } catch (e) {
      setError(e.message);
    }
  }

  async function runAiReview(id) {
    setAiLoading(true);
    setError(null);
    try {
      const res = await api.post(`/ai-review/${id}`, null, token);
      setAiResult(res);
      await loadMine();
    } catch (e) {
      setError(e.message);
    } finally {
      setAiLoading(false);
    }
  }

  // Disagreeing with the automated findings records a note for the HOD; the status does not change.
  async function dispute(id) {
    setError(null);
    try {
      await api.post(`/ai-review/${id}/appeal`, { reason: disputeReason.trim() }, token);
      setDisputeFor(null); setDisputeReason('');
      setNotice('Your note was recorded and the HOD was told. The question’s status has not changed.');
      await loadMine();
    } catch (e) { setError(e.message); }
  }

  // A submitted question is no longer editable; the author can take it back to Draft first.
  async function withdrawAndEdit(q) {
    setError(null);
    try {
      await api.post(`/question-bank/${q.id}/transition`, { target_status: 'DRAFT' }, token);
      loadIntoForm({ ...q, question_status: 'DRAFT' });
      setAiResult(null);
      await loadMine();
    } catch (e) { setError(e.message); }
  }

  const disputeForm = (id) => (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="field">
        <label htmlFor={`dispute-${id}`}>Why do you disagree with the automated findings? (sent to the HOD)</label>
        <input id={`dispute-${id}`} value={disputeReason} onChange={e => setDisputeReason(e.target.value)} maxLength={2000} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn-primary btn-sm" disabled={disputeReason.trim().length < 3} onClick={() => dispute(id)}>Send note to HOD</button>
        <button className="btn-ghost btn-sm" onClick={() => { setDisputeFor(null); setDisputeReason(''); }}>Cancel</button>
      </div>
    </div>
  );

  async function handleBulkFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!selectedAssignment) {
      setError('No course offering selected — you need an active assignment before you can bulk upload.');
      return;
    }
    setError(null);
    setBulkResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('course_offering_id', selectedAssignment.course_offering_id);
      if (selectedAssignment.section_id) fd.append('section_id', selectedAssignment.section_id);
      const res = await api.postForm('/bulk-upload', fd, token);
      setBulkResult(res);
      await loadMine();
    } catch (e) {
      setError(e.message);
    } finally {
      bulkInputRef.current.value = '';
    }
  }

  async function downloadTemplate() {
    setError(null);
    try { await api.download('/bulk-upload/template', token, 'question_template.xlsx'); }
    catch (e) { setError(e.message); }
  }

  // The teacher's own questions in the same layout (GET /question-bank/export), to keep or to edit and import again.
  async function exportMine() {
    setError(null);
    try { await api.download('/question-bank/export', token, 'my_questions.xlsx'); }
    catch (e) { setError(e.message); }
  }

  const drafts = questions.filter(q => q.question_status === 'DRAFT');
  const changesRequested = questions.filter(q => q.question_status === 'CHANGES_REQUESTED');
  const submitted = questions.filter(q => !EDITABLE.includes(q.question_status));
  const isObjective = qType === 'objective';
  const canEditAttachments = EDITABLE.includes(editingStatus || 'DRAFT');
  const isDiagram = normalizeType(form.question_type) === 'diagram';

  return (
    <div>
      <div className="security-note">
        🔒 Access until <strong>{user.access_deadline || 'no deadline set'}</strong>. Submitted questions get an automated
        check (spelling, clarity, duplicates, topic balance) that is advisory only. The HOD sends submissions to review,
        and assigned reviewers approve, request changes or reject them.
      </div>

      {assignments.length === 0 && (
        <div className="alert alert-warn">You have no active course-offering assignment yet — contact your HOD to be assigned before you can submit questions.</div>
      )}
      {assignments.length === 1 && selectedAssignment && (
        <div className="alert alert-info">
          Submitting for <strong>{selectedAssignment.subject_code} — {selectedAssignment.course_title}</strong>
          {' '}({selectedAssignment.program_code}, {selectedAssignment.academic_session_label}, sem {selectedAssignment.semester}
          {selectedAssignment.section_name ? `, section ${selectedAssignment.section_name}` : ''})
        </div>
      )}
      {assignments.length > 1 && (
        <div className="field" style={{ maxWidth: 480 }}>
          <label>Course offering</label>
          <select value={assignmentId || ''} onChange={e => setAssignmentId(e.target.value)}>
            {assignments.map(a => (
              <option key={a.assignment_id} value={a.assignment_id}>
                {a.subject_code} — {a.course_title} ({a.academic_session_label}, sem {a.semester}{a.section_name ? `, sec ${a.section_name}` : ''})
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="tabs">
        <button className={`tab ${qType === 'objective' ? 'active' : ''}`} onClick={() => switchType('objective')}>Objective questions</button>
        <button className={`tab ${qType === 'subjective' ? 'active' : ''}`} onClick={() => switchType('subjective')}>Subjective questions</button>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'compose' ? 'active' : ''}`} onClick={() => setTab('compose')}>Write a question</button>
        <button className={`tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => editingId && openPreview(editingId)} disabled={!editingId}>Preview</button>
        <button className={`tab ${tab === 'bulk' ? 'active' : ''}`} onClick={() => setTab('bulk')}>Bulk upload</button>
        <button className={`tab ${tab === 'mine' ? 'active' : ''}`} onClick={() => setTab('mine')}>My {qType} questions ({questions.length})</button>
        <button className={`tab ${tab === 'syllabus' ? 'active' : ''}`} onClick={() => setTab('syllabus')}>Syllabus</button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      {tab === 'compose' && (
        <div className="card">
          <h3 className="section-title">{editingStatus === 'CHANGES_REQUESTED' ? 'Revising: changes requested' : editingId ? 'Editing draft' : `New ${qType} question`}</h3>
          {editingStatus === 'CHANGES_REQUESTED' && editingReason && <div className="alert alert-warn">Reviewer asked for: {editingReason}</div>}
          {editingId && !EDITABLE.includes(editingStatus || 'DRAFT') && (
            <div className="alert alert-info">This question is {QUESTION_STATES[editingStatus]?.label || editingStatus}; it can no longer be edited.</div>
          )}
          <div className="field">
            <label>Question text</label>
            <textarea rows={3} value={form.question_text} onChange={e => setForm({ ...form, question_text: e.target.value })}
              placeholder={isObjective ? 'e.g. What is the time complexity of binary search?' : 'e.g. Explain the CAP theorem with a real-world example.'} />
          </div>

          <div className="field" style={{ maxWidth: 320 }}>
            <label htmlFor="q-type">Question type</label>
            <select id="q-type" value={normalizeType(form.question_type)} onChange={e => setForm(withQuestionType(form, e.target.value))}>
              {typesInGroup(qType).map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </div>
          <TypeSpecificFields form={form} setForm={setForm} />

          <div className="row">
            <div className="field">
              <label>Difficulty</label>
              <select value={form.difficulty} onChange={e => setForm({ ...form, difficulty: e.target.value })}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
            <div className="field">
              <label>Bloom level (optional — your best guess; a reviewer will confirm it)</label>
              <select value={form.bloom_level} onChange={e => setForm({ ...form, bloom_level: e.target.value })}>
                <option value="">— not sure —</option>
                {BLOOM_LEVELS.map(b => <option key={b} value={b}>{b[0].toUpperCase() + b.slice(1)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Marks</label>
              <input type="number" min="1" max="100" value={form.marks} onChange={e => setForm({ ...form, marks: e.target.value })} />
              <p className="hint">Whole number, 1–100. Zero or negative values are rejected.</p>
            </div>
          </div>
          {hasSyllabus ? (
            <>
              {editingVersion && tree.syllabus_version_id && editingVersion !== tree.syllabus_version_id && EDITABLE.includes(editingStatus || 'DRAFT') && (
                <div className="alert alert-warn">
                  This question was written against an earlier syllabus version. Choose its topic from the current syllabus
                  (version {tree.version_number}); saving moves the question to that version.
                </div>
              )}
              <div className="row">
                <SyllabusPicker tree={tree} idPrefix="q-syllabus" value={picked}
                  onChange={(v) => setForm({ ...form, topic: '', subtopic: '', syllabus_unit_id: v.unitId, syllabus_topic_id: v.topicId, subtopic_id: v.subtopicId })} />
              </div>
              <p className="hint">From the offering&apos;s current syllabus (version {tree.version_number}); a reviewer verifies the unit, topic and subtopic.</p>
            </>
          ) : (
            <div className="row">
              <div className="field"><label htmlFor="q-topic">Topic</label><input id="q-topic" value={form.topic} onChange={e => setForm({ ...form, topic: e.target.value })} placeholder="e.g. Sorting Algorithms" /></div>
              <p className="hint">This offering has no approved syllabus yet: type the topic. Units, topics and subtopics become choices once the HOD approves a syllabus version.</p>
            </div>
          )}

          {canEditAttachments && (
            <div className="field">
              <label htmlFor="q-attach">{isDiagram ? 'Diagram (PNG or JPEG, max 5MB)' : 'Attachment (diagram / image / PDF, max 5MB, up to 3 files)'}</label>
              <input id="q-attach" ref={fileInputRef} type="file" accept={isDiagram ? 'image/png,image/jpeg' : 'image/png,image/jpeg,image/webp,application/pdf'}
                onChange={handleAttach} disabled={!editingId && !form.question_text} />
              <p className="hint">
                {!editingId ? 'Choosing a file saves this question as a draft first, then attaches the file. ' : ''}
                {isDiagram ? 'The printed paper embeds the diagram, so only PNG and JPEG images are accepted.' : ''}
              </p>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn-primary" onClick={() => saveDraft(false)} disabled={!form.question_text}>Save draft</button>
            <button className="btn-amber" onClick={() => saveDraft(true)} disabled={!form.question_text}>Save & Preview</button>
            {editingId && <button className="btn-ghost" onClick={() => resetForm()}>New question</button>}
          </div>
        </div>
      )}

      {tab === 'preview' && previewData && (
        <div className="card">
          <h3 className="section-title">Preview before final submit</h3>
          {previewData.warnings.length > 0 && (
            <div className="alert alert-warn">{previewData.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
          )}

          {previewData.duplicate_candidates?.map(c => (
            <DuplicateResolutionCard
              key={c.relationship_id}
              questionId={previewData.question.id}
              yourText={previewData.question.question_text}
              candidate={c}
              isBlocking={true}
              token={token}
              onResolved={() => openPreview(previewData.question.id)}
              onEdit={() => loadIntoForm(previewData.question)}
            />
          ))}
          {previewData.related_candidates?.map(c => (
            <DuplicateResolutionCard
              key={c.relationship_id}
              questionId={previewData.question.id}
              yourText={previewData.question.question_text}
              candidate={c}
              isBlocking={false}
              token={token}
              onResolved={() => openPreview(previewData.question.id)}
              onEdit={() => loadIntoForm(previewData.question)}
            />
          ))}

          <QuestionView q={previewData.question} token={token} />

          <p className="meta" style={{ fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
            Type: {typeLabel(previewData.question.question_type)}{previewData.question.subtopic ? ` · Subtopic: ${previewData.question.subtopic}` : ''} · Difficulty: {previewData.question.difficulty} · Marks: {previewData.question.marks} · Topic: {previewData.question.topic || '—'}
          </p>

          {previewData.attachments.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <label>Attachments</label>
              {previewData.attachments.map(a => (
                <div key={a.id} className="attachment-chip">
                  {a.scan_status === 'clean' ? (
                    <a href="#" onClick={async (e) => {
                      e.preventDefault();
                      try { const b = await api.get(`/attachments/${a.id}/file`, token); window.open(URL.createObjectURL(b)); }
                      catch (err) { setError(err.data?.error || err.message); }
                    }}>
                      📎 {a.file_name}
                    </a>
                  ) : a.scan_status === 'infected' ? (
                    <span style={{ color: 'var(--danger)' }}>{a.file_name}: blocked by the virus scanner; remove it and upload a clean copy</span>
                  ) : (
                    <span>
                      {a.file_name}: not scanned yet; it cannot be used until it passes the virus scan{' '}
                      <button className="btn-ghost btn-sm" onClick={() => rescanAttachment(a.id)}>Scan again</button>
                    </span>
                  )}
                  {EDITABLE.includes(previewData.question.question_status) && <button className="btn-ghost btn-sm" onClick={() => removeAttachment(a.id)} aria-label={`Remove ${a.file_name}`}>✕</button>}
                </div>
              ))}
            </div>
          )}

          {courseOutcomes.length > 0 && previewData.submit_mode && (
            <div className="card" style={{ background: '#fbfaf7', marginTop: 12 }}>
              <label>Which Course Outcome does this question map to? (optional — a reviewer will confirm/change it)</label>
              <div className="field" style={{ marginTop: 6 }}>
                <label style={{ fontWeight: 400 }}>Primary CO</label>
                <select value={primaryCO} onChange={e => setPrimaryCO(e.target.value)}>
                  <option value="">— not sure —</option>
                  {courseOutcomes.map(co => <option key={co.id} value={co.id}>{co.code} — {co.description}</option>)}
                </select>
              </div>
              {courseOutcomes.length > 1 && (
                <div className="field">
                  <label style={{ fontWeight: 400 }}>Secondary CO(s) (optional)</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {courseOutcomes.filter(co => co.id !== primaryCO).map(co => (
                      <label key={co.id} style={{ fontWeight: 400, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          type="checkbox"
                          disabled={!primaryCO}
                          checked={secondaryCOs.includes(co.id)}
                          onChange={e => setSecondaryCOs(e.target.checked ? [...secondaryCOs, co.id] : secondaryCOs.filter(id => id !== co.id))}
                        />
                        {co.code}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {previewData.submit_mode ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button className="btn-ghost" onClick={() => loadIntoForm(previewData.question)}>Edit</button>
                <button className="btn-primary" onClick={finalSubmit} disabled={!previewData.can_submit}>
                  {previewData.submit_mode === 'resubmit' ? 'Confirm & Resubmit' : 'Confirm & Submit Final'}
                </button>
              </div>
              {!previewData.can_submit && previewData.duplicate_candidates?.length > 0 && <p className="hint" style={{ color: 'var(--danger)' }}>Resolve the possible duplicate(s) above before submitting.</p>}
              {!previewData.can_submit && !previewData.duplicate_candidates?.length && <p className="hint" style={{ color: 'var(--danger)' }}>Cannot submit until every attachment has passed the virus scan.</p>}
            </>
          ) : (
            <p className="hint" style={{ marginTop: 16 }}>
              This question is {QUESTION_STATES[previewData.question.question_status]?.label || previewData.question.question_status}; it can no longer be edited or submitted from here.
            </p>
          )}

          {aiLoading && <div className="alert alert-info" style={{ marginTop: 12 }}>Running the automated check — spelling, clarity, duplicates and topic balance...</div>}
          {aiResult && (
            <div className={`alert ${aiResult.outcome === 'no_issues' ? 'alert-ok' : 'alert-warn'}`} style={{ marginTop: 12 }}>
              {aiResult.outcome === 'no_issues'
                ? 'The automated check found no issues. It is advisory only — the question now waits for the HOD to send it to a reviewer.'
                : (
                  <div>
                    <strong>The automated check found possible issues (advisory — the question&apos;s status has not changed):</strong>
                    <ul style={{ margin: '6px 0 10px' }}>
                      {aiResult.issues.map((iss, i) => <li key={i}>{iss.type.replace(/_/g, ' ')}: {iss.detail}</li>)}
                    </ul>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {aiResult.question_status === 'SUBMITTED' && (
                        <button className="btn-primary btn-sm" onClick={() => withdrawAndEdit(previewData.question)}>Withdraw to draft and edit</button>
                      )}
                      {['SUBMITTED', 'RESUBMITTED'].includes(aiResult.question_status) && disputeFor !== editingId && (
                        <button className="btn-ghost btn-sm" onClick={() => { setDisputeFor(editingId); setDisputeReason(''); }}>I disagree — note it for the HOD</button>
                      )}
                    </div>
                    {disputeFor === editingId && disputeForm(editingId)}
                  </div>
                )}
            </div>
          )}
        </div>
      )}

      {tab === 'bulk' && (
        <div className="card">
          <h3 className="section-title">Bulk upload {qType} questions from Excel / CSV</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Every row is validated before anything is imported. Invalid rows are reported and skipped. When you confirm,
            valid rows are submitted for review; diagram questions and rows that look like an existing question are saved
            as drafts for you to finish and submit.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button className="btn-ghost" onClick={downloadTemplate}>Download template (.xlsx, one example per question type)</button>
            <button className="btn-ghost" onClick={exportMine}>Export my questions (.xlsx)</button>
            <button className="btn-amber" onClick={() => bulkInputRef.current.click()}>Upload filled file</button>
            <input ref={bulkInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleBulkFile} />
          </div>
          {bulkResult && (
            <div>
              <div className={`alert ${bulkResult.error_rows > 0 ? 'alert-warn' : 'alert-ok'}`}>
                {bulkResult.submitted != null
                  ? `${bulkResult.submitted} submitted for review.${bulkResult.drafted > 0 ? ` ${bulkResult.drafted} saved as drafts (attach the diagram or resolve the possible duplicate under My questions, then submit).` : ''}`
                  : `${bulkResult.valid_rows} of ${bulkResult.total_rows} rows are valid and ready to submit (nothing is submitted until you confirm).`}
                {bulkResult.error_rows > 0 && ` ${bulkResult.error_rows} rows have errors and will be skipped.`}
                {bulkResult.needs_confirmation && bulkResult.submitted == null && (
                  <button className="btn-primary btn-sm" style={{ marginLeft: 12 }} onClick={async () => {
                    try {
                      const r = await api.post(`/bulk-upload/${bulkResult.batchId}/confirm`, {}, token);
                      setBulkResult({ ...bulkResult, submitted: r.submitted, drafted: r.drafted, drafts: r.drafts, needs_confirmation: false });
                      await loadMine();
                    } catch (e) { setError(e.data?.error || e.message); }
                  }}>Confirm &amp; submit {bulkResult.valid_rows} questions</button>
                )}
              </div>
              {bulkResult.errors.length > 0 && (
                <table>
                  <thead><tr><th>Row</th><th>Problem</th></tr></thead>
                  <tbody>{bulkResult.errors.map((e, i) => <tr key={i}><td>{e.row}</td><td>{e.errors.join(', ')}</td></tr>)}</tbody>
                </table>
              )}
              {bulkResult.warnings?.length > 0 && (
                <table style={{ marginTop: 12 }}>
                  <thead><tr><th>Row</th><th>Note</th></tr></thead>
                  <tbody>{bulkResult.warnings.map((w, i) => <tr key={i}><td>{w.row}</td><td>{w.warnings.join('; ')}</td></tr>)}</tbody>
                </table>
              )}
              {bulkResult.drafts?.length > 0 && (
                <ul className="hint" style={{ marginTop: 8 }}>
                  {bulkResult.drafts.map((d) => <li key={d.question_id}>Row {d.row}: saved as a draft — {d.reasons.map((x) => DRAFT_REASON[x] || x).join(', ')}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'mine' && (
        <div>
          <h3 className="section-title">Drafts ({drafts.length})</h3>
          {drafts.length === 0 && <p className="hint">No drafts yet.</p>}
          {drafts.map(q => (
            <div className="list-item" key={q.id}>
              <div>
                <div>{q.question_text}</div>
                <div className="meta">{typeLabel(q.question_type)} · Difficulty: {q.difficulty} · Marks: {q.marks}{q.bulk_batch_id ? ' · from a bulk upload' : ''}</div>
              </div>
              <div className="actions">
                <button className="btn-ghost btn-sm" onClick={() => loadIntoForm(q)}>Edit</button>
                <button className="btn-primary btn-sm" onClick={() => openPreview(q.id)}>Preview</button>
              </div>
            </div>
          ))}

          <h3 className="section-title" style={{ marginTop: 24 }}>Changes requested ({changesRequested.length})</h3>
          {changesRequested.length === 0 && <p className="hint">Nothing to revise.</p>}
          {changesRequested.map(q => (
            <div className="list-item" key={q.id}>
              <div>
                <div>{q.question_text}</div>
                <div className="meta">{typeLabel(q.question_type)} · Difficulty: {q.difficulty} · Marks: {q.marks}</div>
                {q.change_request_reason && <div className="meta" style={{ color: 'var(--danger)' }}>Reviewer asked for: {q.change_request_reason}</div>}
              </div>
              <div className="actions">
                <button className="btn-ghost btn-sm" onClick={() => loadIntoForm(q)}>Revise</button>
                <button className="btn-primary btn-sm" onClick={() => openPreview(q.id)}>Preview &amp; resubmit</button>
              </div>
            </div>
          ))}

          <h3 className="section-title" style={{ marginTop: 24 }}>Submitted ({submitted.length})</h3>
          {submitted.length === 0 && <p className="hint">Nothing submitted yet.</p>}
          {submitted.map(q => {
            const findings = aiFindings(q);
            return (
              <div className="list-item" key={q.id} style={{ flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  <div>{q.question_text}</div>
                  <div className="meta">{typeLabel(q.question_type)} · Difficulty: {q.difficulty}{q.submitted_bloom_level ? ` · Bloom: ${q.submitted_bloom_level}` : ''} · Marks: {q.marks}{q.submitted_at ? ` · Submitted ${new Date(q.submitted_at).toLocaleString()}` : ''}</div>
                  {findings.length > 0 && <div className="meta">Automated check (advisory): {findings.map(i => i.detail).join('; ')}</div>}
                  {q.ai_review_dispute && <div className="meta">Your note to the HOD: {q.ai_review_dispute}</div>}
                  {q.rejection_reason && <div className="meta" style={{ color: 'var(--danger)' }}>Reason: {q.rejection_reason}</div>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                  {q.status === 'withdrawn_duplicate' ? <span className="badge badge-draft">withdrawn (duplicate)</span> : <QuestionStatusBadge status={q.question_status} />}
                  {findings.length > 0 && !q.ai_review_dispute && DISPUTABLE.includes(q.question_status) && disputeFor !== q.id && (
                    <button className="btn-ghost btn-sm" onClick={() => { setDisputeFor(q.id); setDisputeReason(''); }}>Dispute automated findings</button>
                  )}
                </div>
                {disputeFor === q.id && <div style={{ width: '100%' }}>{disputeForm(q.id)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'syllabus' && <SyllabusReadOnly token={token} assignments={assignments} />}
    </div>
  );
}


// Matches the interactive resolution flow: show both questions side by
// side with a similarity score and the system's plain-language reasoning
// (never just a bare label — spec section 7's "similarity score alone is
// insufficient" applies to what's shown to the teacher too), and let them
// decide rather than silently either blocking them or letting the
// duplicate through. Which buttons are offered depends on the tier: an
// EXACT/LIKELY_DUPLICATE candidate offers "use existing" (merges into one
// canonical question); a RELATED candidate does not — the system was
// explicit that these aren't the same question, so "merging" them isn't a
// choice on offer, only "yes these are related" or "not related".
function DuplicateResolutionCard({ questionId, yourText, candidate, isBlocking, token, onResolved, onEdit }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function decide(decision) {
    setLoading(true); setError(null);
    try {
      await api.post(`/questions/${questionId}/duplicate-decision`, {
        relationship_id: candidate.relationship_id, decision
      }, token);
      await onResolved();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ background: isBlocking ? '#fff8f0' : '#f6f8fc', border: isBlocking ? '1px solid #f0d9b5' : '1px solid #dbe3f0', marginBottom: 16 }}>
      <h4 style={{ marginTop: 0 }}>{isBlocking ? 'Possible existing question' : 'Related question found'}</h4>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Your question</label>
          <p style={{ fontSize: '0.88rem' }}>{yourText}</p>
        </div>
        <div style={{ flex: 1 }}>
          <label>Existing</label>
          <p style={{ fontSize: '0.88rem' }}>{candidate.target_question_text}</p>
        </div>
      </div>
      <p className="meta">Similarity: {Math.round(candidate.similarity * 100)}% · classified <strong>{candidate.classification.replace(/_/g, ' ')}</strong></p>
      {candidate.reasons?.length > 0 && (
        <ul style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: '0.82rem', color: 'var(--ink-soft)' }}>
          {candidate.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {isBlocking ? (
          <>
            <button className="btn-primary btn-sm" disabled={loading} onClick={() => decide('use_existing')}>Use Existing Question</button>
            <button className="btn-ghost btn-sm" disabled={loading} onClick={() => decide('different')}>This Is Different</button>
          </>
        ) : (
          <>
            <button className="btn-primary btn-sm" disabled={loading} onClick={() => decide('related')}>Yes, Related (keep both)</button>
            <button className="btn-ghost btn-sm" disabled={loading} onClick={() => decide('different')}>Not Related</button>
          </>
        )}
        {isBlocking && <button className="btn-ghost btn-sm" disabled={loading} onClick={onEdit}>Edit Submission</button>}
      </div>
    </div>
  );
}
