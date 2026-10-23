import { useEffect, useState } from 'react';
import { api } from '../api';
import { TypeSpecificView } from './TypeSpecificFields';
import { normalizeType, parseAnswerData, typeLabel } from '../lib/questionTypes';

// The whole question as reviewers, the HOD, validators and the COE judge it (phase 4a): its type, a case study's
// case first, the question text (code in monospace with its spacing), the type-specific body with the answer key
// and the model answer, and its attachments (images inline). The server decides who may see it.
// fileUrl(att): API path of an attachment, e.g. `/attachments/${id}/file` (question bank) or the paper's own route.
export default function QuestionView({ q, token, fileUrl, showAnswers = true, showType = true }) {
  const type = normalizeType(q.question_type);
  const data = parseAnswerData(q.answer_data);
  return (
    <div className="question-full">
      {showType && <span className="badge badge-pending" style={{ marginRight: 6 }}>{typeLabel(type)}</span>}
      {type === 'case_study' && data.case_text && <div className="case-text"><strong style={{ fontStyle: 'normal' }}>Case: </strong>{data.case_text}</div>}
      <QuestionText text={q.question_text} code={type === 'programming'} />
      <TypeSpecificView q={q} showAnswers={showAnswers} />
      {fileUrl && <AttachmentList attachments={q.attachments} token={token} fileUrl={fileUrl} />}
    </div>
  );
}

// Prose with ``` fenced code blocks; a programming question without fences is code as a whole.
export function QuestionText({ text, code }) {
  const parts = String(text ?? '').split(/```[^\n]*\n?/);
  if (parts.length === 1) return code ? <pre className="code-block">{text}</pre> : <div className="q-text">{text}</div>;
  return parts.map((p, i) => (i % 2 === 1
    ? <pre key={i} className="code-block">{p.replace(/\n$/, '')}</pre>
    : p.trim() && <div key={i} className="q-text">{p.trim()}</div>));
}

export function AttachmentList({ attachments, token, fileUrl }) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      {list.map((a) => <Attachment key={a.id} att={a} token={token} path={fileUrl(a)} />)}
    </div>
  );
}

// The token cannot go in <img src>, so the file is fetched with it and shown from a blob URL (revoked on unmount).
function Attachment({ att, token, path }) {
  const isImage = /^image\//.test(att.file_type || '');
  const usable = att.available !== false;
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isImage || !usable) return undefined;
    let cancelled = false; let objectUrl = null;
    api.get(path, token)
      .then((blob) => { if (cancelled) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load the file'); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, token, isImage, usable]);

  async function open() {
    setError('');
    try {
      const blob = await api.get(path, token);
      const u = URL.createObjectURL(blob);
      window.open(u, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(u), 60000);
    } catch (e) { setError(e.message || 'Could not open the file'); }
  }

  if (!usable) return <div className="hint" style={{ color: 'var(--danger)' }}>{att.file_name}: not available (the recorded file is missing or no longer passes the virus scan)</div>;
  return (
    <div>
      {isImage && url && <img className="attachment-image" src={url} alt={`Diagram: ${att.file_name}`} />}
      {isImage && !url && !error && <div className="hint">Loading {att.file_name}…</div>}
      <span className="hint">📎 {att.file_name}{att.legacy_reference ? ' (file of the question when this paper was generated)' : ''} </span>
      <button className="btn-ghost btn-sm" onClick={open}>Open</button>
      {error && <div className="alert alert-error">{att.file_name}: {error}</div>}
    </div>
  );
}
