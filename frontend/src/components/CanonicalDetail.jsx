import { useEffect, useState } from 'react';
import { api } from '../api';
import { Pending } from './ui';
import { useAsync } from '../lib/useAsync';

// The canonical question behind a submission (GET /questions/:id/canonical): its current version and answer, the
// reviewer-verified classification and the CO mapping. The author, assigned reviewers and HODs in scope may read it.
export default function CanonicalDetail({ token, questionId }) {
  const [d, setD] = useState(null);
  const { error, run } = useAsync();
  useEffect(() => { run(async () => setD(await api.get(`/questions/${questionId}/canonical`, token))); }, [questionId, token, run]);
  if (!d) return <Pending error={error} what="the canonical record" />;
  if (!d.canonical) return <p className="hint">Not linked to a canonical question yet; it gets one when it is submitted.</p>;
  const c = d.canonical;
  return (
    <div className="card" style={{ background: '#fbfaf7', marginTop: 6 }}>
      <h5 style={{ margin: '0 0 4px' }}>Canonical question</h5>
      <div className="hint">
        Verified difficulty: {c.verified_difficulty || 'not verified'} · Verified Bloom: {c.verified_bloom_level || 'not verified'}
        {d.currentVersion ? ` · current version ${d.currentVersion.version_number}` : ''}
      </div>
      <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{d.currentVersion?.question_text || c.canonical_text}</p>
      {d.currentAnswer?.answer_text && <div className="answer-box"><label>Canonical answer</label><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{d.currentAnswer.answer_text}</p></div>}
      <div className="hint" style={{ marginTop: 4 }}>
        Course outcomes: {d.courseOutcomes.length === 0 ? 'none mapped'
          : d.courseOutcomes.map((x) => `${x.code} (${x.relationship_type}${x.verified_by ? ', verified' : ', unverified'})`).join(', ')}
      </div>
    </div>
  );
}
