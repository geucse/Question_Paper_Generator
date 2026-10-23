import { cloneElement } from 'react';
import { ASSERTION_REASON_OPTIONS, normalizeType, parseAnswerData, mcqKeyLetter } from '../lib/questionTypes';

// Inputs for the answer/marking data each question type needs (spec §10). Writes into
// form.option_*, form.correct_answer, form.model_answer and form.answer_data.
export default function TypeSpecificFields({ form, setForm }) {
  const type = normalizeType(form.question_type);
  const data = form.answer_data || {};
  const setData = (patch) => setForm({ ...form, answer_data: { ...data, ...patch } });
  // Every input is linked to its label (screen readers, click-to-focus).
  const field = (label, input, hint) => {
    const id = `tsf-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
    return <div className="field"><label htmlFor={id}>{label}</label>{cloneElement(input, { id })}{hint && <p className="hint">{hint}</p>}</div>;
  };
  const modelAnswer = (label = 'Model answer / solution (required before the question can be used in papers)') =>
    field(label, <textarea rows={4} value={form.model_answer} onChange={(e) => setForm({ ...form, model_answer: e.target.value })} />);

  if (type === 'mcq') {
    return (
      <>
        <div className="grid-2">
          {['a', 'b', 'c', 'd'].map((k) => (
            <div className="field" key={k}><label htmlFor={`tsf-option-${k}`}>Option {k.toUpperCase()}</label>
              <input id={`tsf-option-${k}`} value={form[`option_${k}`]} onChange={(e) => setForm({ ...form, [`option_${k}`]: e.target.value })} /></div>
          ))}
        </div>
        {field('Correct answer (must exactly match one option above)', <input value={form.correct_answer} onChange={(e) => setForm({ ...form, correct_answer: e.target.value })} />)}
      </>
    );
  }
  if (type === 'true_false') {
    return (
      <>
        {field('Correct answer', (
          <select value={String(form.correct_answer || '').toUpperCase()} onChange={(e) => setForm({ ...form, correct_answer: e.target.value })}>
            <option value="">— choose —</option><option value="TRUE">True</option><option value="FALSE">False</option>
          </select>
        ))}
        {modelAnswer('Explanation (required before the question can be used in papers)')}
      </>
    );
  }
  if (type === 'assertion_reason') {
    return (
      <>
        {field('Assertion (A)', <textarea rows={2} value={data.assertion || ''} onChange={(e) => setData({ assertion: e.target.value })} />)}
        {field('Reason (R)', <textarea rows={2} value={data.reason || ''} onChange={(e) => setData({ reason: e.target.value })} />)}
        {field('Correct option', (
          <select value={String(form.correct_answer || '').toUpperCase()} onChange={(e) => setForm({ ...form, correct_answer: e.target.value })}>
            <option value="">— choose —</option>
            {Object.entries(ASSERTION_REASON_OPTIONS).map(([k, t]) => <option key={k} value={k}>({k}) {t}</option>)}
          </select>
        ))}
        {modelAnswer('Explanation (required before the question can be used in papers)')}
      </>
    );
  }
  if (type === 'numerical') {
    return (
      <>
        <div className="row">
          {field('Expected answer', <input type="number" step="any" value={data.expected_value ?? ''} onChange={(e) => setData({ expected_value: e.target.value === '' ? '' : Number(e.target.value) })} />)}
          {field('Tolerance (±, optional)', <input type="number" step="any" min="0" value={data.tolerance ?? ''} onChange={(e) => setData({ tolerance: e.target.value === '' ? undefined : Number(e.target.value) })} />)}
          {field('Unit (optional)', <input value={data.unit || ''} onChange={(e) => setData({ unit: e.target.value })} />)}
        </div>
        {modelAnswer('Worked solution (required before the question can be used in papers)')}
      </>
    );
  }
  if (type === 'fill_blank') {
    // The text is kept exactly as typed (form.fill_blank_text, never sent as data); the answer list is derived from
    // it, so spaces and separators are not re-split or trimmed away while the teacher is still typing.
    const raw = form.fill_blank_text ?? (Array.isArray(data.answers) ? data.answers.join(' | ') : '');
    const onAnswers = (e) => setForm({ ...form, fill_blank_text: e.target.value,
      answer_data: { ...data, answers: e.target.value.split('|').map((x) => x.trim()).filter(Boolean) } });
    return (
      <>
        {field('Accepted answers, one per blank, separated by |', <input value={raw} onChange={onAnswers} />,
          'Mark each blank in the question text with ___ (three underscores).')}
        {modelAnswer('Explanation (required before the question can be used in papers)')}
      </>
    );
  }
  if (type === 'programming') {
    return (
      <>
        <div className="row">
          {field('Language', <input value={data.language || ''} onChange={(e) => setData({ language: e.target.value })} placeholder="e.g. Python" />)}
          {field('Constraints (optional)', <input value={data.constraints || ''} onChange={(e) => setData({ constraints: e.target.value })} placeholder="e.g. O(n log n), no libraries" />)}
        </div>
        {modelAnswer('Reference solution (required before the question can be used in papers)')}
      </>
    );
  }
  if (type === 'case_study') {
    return (
      <>
        {field('Case text (shown to students before the question)', <textarea rows={5} value={data.case_text || ''} onChange={(e) => setData({ case_text: e.target.value })} />)}
        {modelAnswer()}
      </>
    );
  }
  if (type === 'diagram') {
    return (
      <>
        <p className="hint">Attach the diagram below as a PNG or JPEG image (the printed paper embeds it). Choosing the file saves the question as a draft first. A diagram question can only become Active once the diagram is attached.</p>
        {modelAnswer()}
      </>
    );
  }
  return modelAnswer('Model answer (required before the question can be used in papers)');
}

// Read-only rendering of the type-specific part for previews, review screens and papers (the question text and
// a case study's case are shown by QuestionView). showAnswers=false hides the key and the model answer.
export function TypeSpecificView({ q, showAnswers = true }) {
  const type = normalizeType(q.question_type);
  const data = parseAnswerData(q.answer_data);
  const answerBox = (label, text, code = false) => (
    <div className="answer-box"><label>{label}</label>
      {code && text ? <pre className="code-block">{text}</pre> : <p style={{ margin: 0 }}>{text || '— none provided —'}</p>}
    </div>
  );
  const model = showAnswers && answerBox(type === 'programming' ? 'Reference solution' : 'Model answer', q.model_answer, type === 'programming');
  if (type === 'mcq') {
    const key = mcqKeyLetter(q);
    return (
      <>
        <ul style={{ margin: '0.3em 0', paddingLeft: 20, listStyle: 'none' }}>
          {['a', 'b', 'c', 'd'].filter((k) => q[`option_${k}`]).map((k) => {
            const correct = showAnswers && key === k.toUpperCase();
            return <li key={k} className={correct ? 'option-key' : undefined}>({k.toUpperCase()}) {q[`option_${k}`]}{correct ? ' ✓ correct answer' : ''}</li>;
          })}
        </ul>
        {showAnswers && !key && answerBox('Correct answer (does not match an option)', q.correct_answer)}
        {model}
      </>
    );
  }
  const arKey = String(q.correct_answer || '').toUpperCase();
  return (
    <>
      {type === 'true_false' && <p className="hint">(True / False)</p>}
      {type === 'assertion_reason' && (
        <>
          <p style={{ margin: '0.3em 0' }}><strong>Assertion (A):</strong> {data.assertion || '—'}<br /><strong>Reason (R):</strong> {data.reason || '—'}</p>
          <ul style={{ margin: '0.3em 0', paddingLeft: 20, listStyle: 'none' }}>
            {Object.entries(ASSERTION_REASON_OPTIONS).map(([k, t]) => (
              <li key={k} className={showAnswers && arKey === k ? 'option-key' : undefined}>({k}) {t}{showAnswers && arKey === k ? ' ✓ correct answer' : ''}</li>
            ))}
          </ul>
        </>
      )}
      {type === 'programming' && <p className="hint">Language: {data.language || '—'}{data.constraints ? ` · Constraints: ${data.constraints}` : ''}</p>}
      {type === 'numerical' && data.unit && <p className="hint">Answer in {data.unit}</p>}
      {showAnswers && type === 'true_false' && answerBox('Correct answer', arKey === 'TRUE' ? 'True' : arKey === 'FALSE' ? 'False' : q.correct_answer)}
      {showAnswers && type === 'assertion_reason' && !ASSERTION_REASON_OPTIONS[arKey] && answerBox('Correct option (not a standard choice)', q.correct_answer)}
      {showAnswers && type === 'numerical' && answerBox('Expected answer', data.expected_value != null && data.expected_value !== ''
        ? `${data.expected_value}${data.unit ? ` ${data.unit}` : ''}${data.tolerance ? ` (± ${data.tolerance})` : ''}` : '')}
      {showAnswers && type === 'fill_blank' && answerBox('Accepted answers', Array.isArray(data.answers) ? data.answers.map((a, i) => `Blank ${i + 1}: ${a}`).join('; ') : '')}
      {model}
    </>
  );
}
