import { useRef, useState } from 'react';
import { api } from '../api';
import { SYLLABUS_STEPS, syllabusStepIndex } from '../lib/syllabus';

// HOD: upload the official syllabus PDF of a course offering (POST /academic/course-offerings/:id/syllabus-upload).
// The server reads the PDF, finds this course by its subject code and creates a DRAFT version with the COs, units
// and topics exactly as printed. Nothing becomes active here: the HOD reviews what was extracted (and every
// warning), corrects it in the version below, then confirms, submits and approves it.
export function SyllabusUpload({ token, offeringId, offeringLabel, onCreated }) {
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [found, setFound] = useState(null);
  const [result, setResult] = useState(null);

  async function upload() {
    if (!file) return;
    setBusy(true); setError(null); setFound(null); setResult(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await api.upload(`/academic/course-offerings/${offeringId}/syllabus-upload`, form, token);
      setResult(r);
      setFile(null); if (input.current) input.current.value = '';
      onCreated?.(r);
    } catch (e) {
      setError(e.message);
      if (Array.isArray(e.data?.courses_found)) setFound(e.data.courses_found);
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3 className="section-title">Upload the official syllabus (PDF)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Upload the department&apos;s syllabus document for {offeringLabel || 'this offering'}. The course is found by its subject code and a
        draft version is created with the course outcomes, units and topics exactly as printed. Nothing is published until you review
        it, confirm it and approve it. Scanned PDFs without a text layer cannot be read; enter those syllabi manually.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="syl-upload-file">Syllabus PDF (up to 25 MB)</label>
          <input id="syl-upload-file" ref={input} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <button className="btn-primary" onClick={upload} disabled={!file || !offeringId || busy}>{busy ? 'Reading the PDF…' : 'Upload and extract'}</button>
      </div>
      {error && <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
      {found && found.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>Courses found in this PDF ({found.length})</summary>
          <ul className="hint">{found.map((c) => <li key={`${c.code}-${c.pages?.[0]}`}>{c.code}: {c.title || 'untitled'} (semester {c.semester ?? '?'}, pages {c.pages?.join('–')})</li>)}</ul>
        </details>
      )}
      {result && <ExtractionResult result={result} />}
    </div>
  );
}

function ExtractionResult({ result }) {
  const c = result.course || {};
  return (
    <div style={{ marginTop: 14 }}>
      <div className="alert alert-ok" role="status">
        Version {result.version?.version_number} created as a draft from {c.code} {c.title} (PDF pages {c.pages?.join('–')}). {result.next}
      </div>
      {result.warnings?.length > 0 && (
        <div className="alert alert-warn">
          <strong>Check these before confirming:</strong>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <div className="grid-2">
        <div>
          <h4>Course outcomes as printed ({c.course_outcomes?.length || 0})</h4>
          {(c.course_outcomes || []).map((co) => <p key={co.code} style={{ margin: '0 0 6px', fontSize: '0.88rem' }}><strong>{co.code}</strong> {co.text}</p>)}
          {!c.course_outcomes?.length && <p className="hint">None printed: resolve this before the version can be confirmed.</p>}
        </div>
        <div>
          <h4>Units</h4>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Unit</th><th>Contact hours</th><th>Topics extracted</th></tr></thead>
              <tbody>
                {(c.units || []).map((u) => (
                  <tr key={u.number}><td>Unit {u.number}{u.label_missing_in_source ? ' (no label in the PDF)' : ''}</td><td>{u.hours ?? '—'}</td><td>{u.topics}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.total_hours != null && <p className="hint">Total stated in the syllabus: {c.total_hours} hours.</p>}
        </div>
      </div>
    </div>
  );
}

// Opens the PDF a version was extracted from (GET /academic/syllabus-versions/:id/source), for the HOD and the
// course's teachers and reviewers.
export function SourcePdfButton({ token, versionId, pages }) {
  const [error, setError] = useState(null);
  async function open() {
    setError(null);
    try {
      const blob = await api.blob(`/academic/syllabus-versions/${versionId}/source`, token);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setError(e.message); }
  }
  return (
    <span>
      <button className="btn-ghost btn-sm" onClick={open}>View the official PDF{pages ? ` (pages ${pages.join('–')})` : ''}</button>
      {error && <span className="hint" role="alert" style={{ marginLeft: 8 }}>{error}</span>}
    </span>
  );
}

// Where a syllabus version stands in the HOD's workflow.
export function SyllabusSteps({ status }) {
  const at = syllabusStepIndex(status);
  if (at < 0) return null;
  return (
    <ol className="ge-steps" aria-label="Syllabus approval steps">
      {SYLLABUS_STEPS.map((label, i) => (
        <li key={label} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="n">{i + 1}</span>{label}
        </li>
      ))}
    </ol>
  );
}
