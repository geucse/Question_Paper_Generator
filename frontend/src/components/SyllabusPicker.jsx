// One syllabus version's units > topics > subtopics (migration 042), as dependent selects. `tree` is the response of
// GET /academic/course-offerings/:id/syllabus-tree (the offering's ACTIVE version) or GET /academic/syllabus-versions/:id/tree.
// value = { unitId, topicId, subtopicId }; onChange gets the next value (a new unit clears the topic, a new topic the
// subtopic). The server re-checks every id against the version, so this only offers valid choices.
export function SyllabusPicker({ tree, value, onChange, idPrefix, disabled = false, subtopicLabel = 'Subtopic (optional)' }) {
  const units = tree?.units || [];
  if (!units.length) return <p className="hint">This syllabus version has no units and topics yet.</p>;
  const unit = units.find((u) => u.id === value.unitId) || null;
  const topic = unit?.topics.find((t) => t.id === value.topicId) || null;
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-unit`}>Unit</label>
        <select id={`${idPrefix}-unit`} value={value.unitId || ''} disabled={disabled}
          onChange={(e) => onChange({ unitId: e.target.value, topicId: '', subtopicId: '' })}>
          <option value="">—</option>
          {units.map((u) => <option key={u.id} value={u.id}>{u.code} — {u.title}</option>)}
        </select>
      </div>
      {unit && (
        <div className="field">
          <label htmlFor={`${idPrefix}-topic`}>Topic</label>
          <select id={`${idPrefix}-topic`} value={value.topicId || ''} disabled={disabled}
            onChange={(e) => onChange({ ...value, topicId: e.target.value, subtopicId: '' })}>
            <option value="">—</option>
            {unit.topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>
      )}
      {topic && topic.subtopics.length > 0 && (
        <div className="field">
          <label htmlFor={`${idPrefix}-subtopic`}>{subtopicLabel}</label>
          <select id={`${idPrefix}-subtopic`} value={value.subtopicId || ''} disabled={disabled}
            onChange={(e) => onChange({ ...value, subtopicId: e.target.value })}>
            <option value="">— whole topic —</option>
            {topic.subtopics.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </div>
      )}
    </>
  );
}
