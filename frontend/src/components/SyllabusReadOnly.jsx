import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { SYLLABUS_STATUS, syllabusSource } from '../lib/syllabus';
import { SourcePdfButton } from './SyllabusUpload';

// Teachers (and reviewers) read the official syllabus of their course offerings: the ACTIVE version's course
// outcomes, units, topics and subtopics, with the official PDF when the version was extracted from one. Only the
// HOD uploads, verifies and approves the syllabus; questions are written against the active version.
export default function SyllabusReadOnly({ token, assignments }) {
  const [chosen, setChosen] = useState('');
  const offeringId = chosen || assignments[0]?.course_offering_id || '';
  const [tree, setTree] = useState(null);
  const [versions, setVersions] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback((id) => {
    if (!id) return;
    api.get(`/academic/course-offerings/${id}/syllabus-tree`, token)
      .then((t) => { setTree(t); setError(null); }, (e) => { setTree(null); setError(e.message); });
    api.get(`/academic/syllabus-versions?course_offering_id=${id}`, token).then(setVersions, () => setVersions([]));
  }, [token]);
  useEffect(() => { load(offeringId); }, [load, offeringId]);

  const active = versions.find((v) => v.status === 'ACTIVE');
  const source = active && syllabusSource(active.extracted_units);
  const pending = versions.filter((v) => ['DRAFT', 'TEACHER_VERIFIED', 'HOD_REVIEW'].includes(v.status));

  return (
    <div className="card">
      <h3 className="section-title">Official syllabus</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        The syllabus your questions are written against. Your HOD uploads, verifies and approves it; if something in it looks wrong, tell
        your HOD. Each question must be placed on a topic below and mapped to this subject&apos;s own course outcomes.
      </p>
      <div className="field" style={{ maxWidth: 480 }}>
        <label htmlFor="syl-read-offering">Course offering</label>
        <select id="syl-read-offering" value={offeringId} onChange={(e) => setChosen(e.target.value)}>
          {assignments.map((a) => <option key={a.course_offering_id} value={a.course_offering_id}>{a.subject_code} — {a.course_title}</option>)}
        </select>
      </div>
      {error && <div className="alert alert-warn">{/no active syllabus|not found|404/i.test(error) ? 'This offering has no active syllabus yet. Your HOD publishes it.' : error}</div>}
      {pending.length > 0 && (
        <p className="hint">A new version is being prepared by your HOD ({pending.map((v) => `version ${v.version_number}: ${(SYLLABUS_STATUS[v.status] || [])[1] || v.status}`).join('; ')}). The active version stays in force until it is approved.</p>
      )}
      {tree && (
        <>
          <p className="hint">Active version {tree.version_number}{source ? '. ' : ''}{source && active && <SourcePdfButton token={token} versionId={active.id} pages={source.pages} />}</p>
          <h4>Course outcomes</h4>
          {(tree.course_outcomes || []).length === 0 && <p className="hint">No course outcomes recorded.</p>}
          {(tree.course_outcomes || []).map((co) => <p key={co.id} style={{ margin: '0 0 6px', fontSize: '0.9rem' }}><strong>{co.code}</strong> {co.description}</p>)}
          <h4 style={{ marginTop: 14 }}>Units and topics</h4>
          {(tree.units || []).map((u) => (
            <details key={u.id} style={{ marginBottom: 6 }}>
              <summary>{u.code} {u.title} ({u.topics.length} topic{u.topics.length === 1 ? '' : 's'})</summary>
              <ul style={{ margin: '6px 0 0 18px', padding: 0, fontSize: '0.88rem' }}>
                {u.topics.map((t) => (
                  <li key={t.id}>{t.title}{t.subtopics?.length ? <span className="hint"> — {t.subtopics.map((st) => st.title).join(', ')}</span> : null}</li>
                ))}
              </ul>
            </details>
          ))}
        </>
      )}
    </div>
  );
}
