// Question lifecycle badge (PIVOT_SPEC_V2 §7). State labels/classes live in ../lib/questionStates.js.
import { QUESTION_STATES } from '../lib/questionStates';

export default function QuestionStatusBadge({ status }) {
  const cfg = QUESTION_STATES[status] || { cls: 'badge-draft', label: String(status || 'Unknown') };
  return <span className={`badge ${cfg.cls}`} title={`Question status: ${cfg.label}`}>{cfg.label}</span>;
}

// Main path through the lifecycle with the question's position on it.
const MAIN_PATH = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE'];
const POSITION = { RESUBMITTED: 'UNDER_REVIEW', CHANGES_REQUESTED: 'UNDER_REVIEW', RETIRED: 'ACTIVE' };

export function QuestionLifecycleTimeline({ status }) {
  const idx = MAIN_PATH.indexOf(POSITION[status] || status);
  if (status === 'REJECTED') return <span className="hint">Rejected — terminal state</span>;
  return (
    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }} aria-label={`Lifecycle position: ${status}`}>
      {MAIN_PATH.map((s, i) => (
        <span key={s} className="hint" style={{ fontWeight: i === idx ? 700 : 400, opacity: i <= idx ? 1 : 0.5 }}>
          {i > 0 && '→ '}{QUESTION_STATES[s].label}
        </span>
      ))}
      {POSITION[status] && <QuestionStatusBadge status={status} />}
    </div>
  );
}
