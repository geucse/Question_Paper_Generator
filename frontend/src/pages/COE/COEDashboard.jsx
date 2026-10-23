import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Messages, Pending, StatusBadge, Tabs } from '../../components/ui';
import { useAsync } from '../../lib/useAsync';
import TotpSetup from '../../components/TotpSetup';
import ValidationSummary from '../../components/ValidationSummary';
import { SectionedQuestions, InternalChoiceSummary, OverrideNotice } from '../../components/PaperSections';
import { OverrideFields, BlueprintDetail, FeasibilityResult } from '../../components/BlueprintTools';
import { overrideBody, overrideIncomplete, emptyOverride } from '../../lib/overrides';
import { QUESTION_TYPES, typeLabel, fromPaperQuestion } from '../../lib/questionTypes';
import QuestionView from '../../components/QuestionView';
import { PrintedAs, CoChips } from '../../components/PaperSections';
import PdfActions, { PaperOutput } from '../../components/PdfActions';

const EXAM_TYPES = [['mid_term', 'Mid-term'], ['end_term', 'End-term'], ['quiz', 'Quiz'], ['supplementary', 'Supplementary'], ['makeup', 'Make-up']];

// Archivable states, mirroring backend/src/paper-policy.js PAPER_TRANSITIONS.
const ARCHIVABLE = ['GENERATED', 'CHANGES_REQUIRED', 'REGENERATED', 'PRINT_READY'];
// Mirrors paper-policy.js: REPLACEABLE_IN, COE_SEND_BACK_FROM, ISSUE_CLOSABLE_IN.
const REPLACEABLE_IN = ['GENERATED', 'VALIDATION_PENDING'];
const SEND_BACK_FROM = ['VALIDATION_PENDING', 'VALIDATED'];
const ISSUE_CLOSABLE_IN = ['GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED'];
const ENDED_REASON = {
  replaced: 'replaced', reassigned: 'reassigned (new round)', paper_regenerated: 'paper regenerated',
  paper_archived: 'paper archived', paper_reset: 'technical reset',
};
const fmt = (d) => (d ? new Date(d).toLocaleString() : '');

export default function COEDashboard({ token, user, onUserChange }) {
  const [tab, setTab] = useState('exams');
  const [paperId, setPaperId] = useState(null);
  const totpEnabled = !!user?.totp_enabled;

  return (
    <div>
      {!totpEnabled && tab !== 'security' && (
        <div className="alert alert-warn">
          Final paper approval needs your authenticator (TOTP).{' '}
          <button className="btn-ghost btn-sm" onClick={() => { setTab('security'); setPaperId(null); }}>Set it up now</button>
        </div>
      )}
      <Tabs
        tabs={[['exams', 'Examinations & Blueprints'], ['papers', 'Papers'], ['security', totpEnabled ? 'Authenticator' : 'Authenticator (required)']]}
        active={paperId ? 'papers' : tab}
        onChange={(t) => { setTab(t); setPaperId(null); }}
        primary
      />
      {tab === 'security' && (
        <TotpSetup token={token} user={user} purpose="Required for your final approval of examination papers." onEnabled={onUserChange} />
      )}
      {tab === 'exams' && !paperId && <Exams token={token} onOpenPaper={(id) => { setPaperId(id); setTab('papers'); }} />}
      {tab !== 'security' && (tab === 'papers' || paperId) && (paperId
        ? <PaperDetail token={token} paperId={paperId} totpEnabled={totpEnabled} onSetupTotp={() => { setPaperId(null); setTab('security'); }}
            onBack={() => setPaperId(null)} onOpen={setPaperId} />
        : <PaperList token={token} onOpen={setPaperId} />)}
    </div>
  );
}

function Exams({ token, onOpenPaper }) {
  const [exams, setExams] = useState([]);
  const [offerings, setOfferings] = useState([]);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ course_offering_id: '', exam_type: EXAM_TYPES[0][0], maximum_marks: 50, duration_minutes: 120 });
  const { error, reasons, ok, loading, run } = useAsync();

  const load = useCallback(async () => {
    setExams(await api.get('/examinations', token));
    setOfferings(await api.get('/examinations/offerings', token));
  }, [token]);
  useEffect(() => { run(load); }, [load, run]);

  async function create(e) {
    e.preventDefault();
    await run(async () => { await api.post('/examinations', form, token); await load(); }, 'Examination created');
  }

  return (
    <div>
      <Messages error={error} reasons={reasons} ok={ok} />
      <div className="card">
        <h3>Create examination</h3>
        <p className="hint">Campus, program, subject and syllabus version are taken from the course offering, never typed in.</p>
        <form onSubmit={create} className="grid-2">
          <div className="field"><label>Course offering</label>
            <select required value={form.course_offering_id} onChange={(e) => setForm({ ...form, course_offering_id: e.target.value })}>
              <option value="">Select…</option>
              {offerings.map((o) => <option key={o.id} value={o.id}>{o.subject_code} · {o.course_title} · sem {o.semester}{o.approval_status === 'hod_approved' ? '' : ' (syllabus not approved)'}</option>)}
            </select></div>
          <div className="field"><label>Exam type</label>
            <select value={form.exam_type} onChange={(e) => setForm({ ...form, exam_type: e.target.value })}>{EXAM_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="field"><label>Maximum marks</label>
            <input type="number" min="1" value={form.maximum_marks} onChange={(e) => setForm({ ...form, maximum_marks: e.target.value })} /></div>
          <div className="field"><label>Duration (minutes)</label>
            <input type="number" min="1" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} /></div>
          <div><button className="btn-primary" type="submit">Create examination</button></div>
        </form>
      </div>

      <h3 style={{ marginTop: 20 }}>Examinations</h3>
      {loading && exams.length === 0 && <p className="hint" role="status">Loading…</p>}
      {!loading && exams.length === 0 && <div className="empty-state">No examinations yet.</div>}
      {exams.map((x) => (
        <div key={x.id} className="list-item">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><strong>{x.subject_code}</strong> {x.course_title} · {x.exam_type} · {x.maximum_marks} marks · {x.paper_count} paper(s){x.live_paper_count > 0 ? ' · paper in progress' : ''}{x.printed_paper_count > 0 ? ' · printed' : ''}</div>
            <button className="btn-ghost btn-sm" onClick={() => setSelected(selected === x.id ? null : x.id)}>{selected === x.id ? 'Close' : 'Blueprint & generate'}</button>
          </div>
          {selected === x.id && <BlueprintPanel token={token} exam={x} onOpenPaper={onOpenPaper} onChange={load} />}
        </div>
      ))}
    </div>
  );
}

const BLOOMS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
const emptySection = (i) => ({ name: `Section ${String.fromCharCode(65 + i)}`, question_count: 1, marks_per_question: '', total_marks: '', question_types: [], easy: '', medium: '', hard: '', instructions: '', attempt_count: '' });
const blank = (v) => v === '' || v == null;
const blueprintLabel = (b) => `v${b.version_number}: ${b.easy_count}/${b.medium_count}/${b.hard_count} · ${b.total_marks} marks${Array.isArray(b.sections) && b.sections.length ? ` · ${b.sections.length} sections` : ''}`
  + ` · ${b.target_mode === 'hard' ? 'exact targets' : 'legacy (soft targets)'} · used by ${b.paper_count ?? 0}${b.is_active ? '' : ' (superseded)'}`;

// "CO1:2, CO2:3" <-> { CO1: 2, CO2: 3 }
const parseCoTargets = (text) => Object.fromEntries(String(text || '').split(/[,;\n]+/).map((x) => x.split(/[:=]/).map((y) => y.trim()))
  .filter(([k, v]) => k && v !== undefined && v !== '').map(([k, v]) => [k.toUpperCase(), Number(v)]));

function BlueprintPanel({ token, exam, onOpenPaper, onChange }) {
  const [bps, setBps] = useState([]);
  const [bp, setBp] = useState({ name: '', easy_count: 3, medium_count: 2, hard_count: 1, total_marks: exam.maximum_marks, reuse_lookback_exams: 2 });
  const [sections, setSections] = useState([]);
  const [coText, setCoText] = useState('');
  const [bloom, setBloom] = useState({});
  const [chosen, setChosen] = useState('');
  const [seed, setSeed] = useState('');
  const [override, setOverride] = useState(emptyOverride());
  const [viewing, setViewing] = useState(false);
  const [copiedFrom, setCopiedFrom] = useState(null);
  const [notes, setNotes] = useState([]);
  const [feasibility, setFeasibility] = useState(null);
  const { error, reasons, ok, run } = useAsync();

  const load = useCallback(async () => {
    const list = await api.get(`/examinations/blueprints?examination_id=${exam.id}`, token);
    setBps(list);
    if (list[0]) setChosen((c) => c || list[0].id);
  }, [exam.id, token]);
  useEffect(() => { run(load); }, [load, run]);

  const setSection = (i, patch) => setSections(sections.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const bloomSum = Object.values(bloom).reduce((a, v) => a + (Number(v) || 0), 0);
  const chosenRow = bps.find((b) => b.id === chosen);
  const blocked = chosenRow?.generation_blocked_reason;
  const live = exam.live_paper_count > 0;
  const printed = exam.printed_paper_count > 0;

  function payload() {
    const clean = (v) => (blank(v) ? undefined : Number(v));
    return {
      ...bp, name: bp.name?.trim() || undefined, examination_id: exam.id,
      sections: sections.length ? sections.map((x) => ({
        name: x.name.trim(), question_count: Number(x.question_count), marks_per_question: clean(x.marks_per_question), total_marks: clean(x.total_marks),
        question_types: x.question_types, easy: clean(x.easy), medium: clean(x.medium), hard: clean(x.hard), instructions: x.instructions || undefined,
        attempt_count: clean(x.attempt_count),
      })) : null,
      co_distribution: Object.keys(parseCoTargets(coText)).length ? parseCoTargets(coText) : null,
      bloom_distribution: Object.keys(bloom).some((k) => !blank(bloom[k]))
        ? Object.fromEntries(Object.entries(bloom).filter(([, v]) => !blank(v)).map(([k, v]) => [k, Number(v)])) : null,
    };
  }
  // Quick client-side sums; the server re-checks everything (backend/src/exam-generator.js blueprintConfigErrors).
  function draftProblems() {
    const out = [];
    const n = ['easy_count', 'medium_count', 'hard_count'].reduce((a, k) => a + (Number(bp[k]) || 0), 0);
    if (sections.length) {
      const held = sections.reduce((a, x) => a + (Number(x.question_count) || 0), 0);
      if (held !== n) out.push(`Sections hold ${held} question(s) but easy + medium + hard is ${n}`);
      for (const x of sections) {
        const split = [x.easy, x.medium, x.hard];
        if (split.every((v) => !blank(v)) && split.reduce((a, v) => a + Number(v), 0) !== Number(x.question_count)) out.push(`${x.name}: easy + medium + hard must equal its ${x.question_count} question(s)`);
        if (!blank(x.attempt_count)) {
          if (blank(x.marks_per_question)) out.push(`${x.name}: an internal choice needs marks each`);
          if (Number(x.attempt_count) >= Number(x.question_count)) out.push(`${x.name}: "attempt any ${x.attempt_count}" must be fewer than its ${x.question_count} question(s)`);
        }
      }
      if (sections.every((x) => !blank(x.marks_per_question) || !blank(x.total_marks))) {
        const fixed = sections.reduce((a, x) => a + (!blank(x.total_marks) ? Number(x.total_marks)
          : Number(x.marks_per_question) * Number(blank(x.attempt_count) ? x.question_count : x.attempt_count)), 0);
        if (fixed !== Number(bp.total_marks)) out.push(`Section marks add up to ${fixed} but total marks is ${bp.total_marks}`);
      }
    }
    if (Number(bp.total_marks) !== Number(exam.maximum_marks)) out.push(`Total marks must equal the examination's maximum marks (${exam.maximum_marks})`);
    if (bloomSum > 100) out.push(`Bloom percentages add up to ${bloomSum}%, more than 100%`);
    return out;
  }
  const problems = draftProblems();

  function copyIntoEditor(b) {
    setBp({ name: b.name || '', easy_count: b.easy_count, medium_count: b.medium_count, hard_count: b.hard_count, total_marks: b.total_marks, reuse_lookback_exams: b.reuse_lookback_exams });
    setSections((Array.isArray(b.sections) ? b.sections : []).map((x, i) => ({
      ...emptySection(i), ...x, marks_per_question: x.marks_per_question ?? '', total_marks: x.total_marks ?? '', easy: x.easy ?? '', medium: x.medium ?? '', hard: x.hard ?? '',
      question_types: x.question_types || [], instructions: x.instructions || '', attempt_count: x.attempt_count ?? '',
    })));
    setCoText(Object.entries(b.co_distribution || {}).map(([k, v]) => `${k}:${v}`).join(', '));
    setBloom(Object.fromEntries(Object.entries(b.bloom_distribution || {}).map(([k, v]) => [k.toLowerCase(), String(v)])));
    setCopiedFrom(b.version_number); setViewing(false);
  }
  async function saveBlueprint() {
    await run(async () => {
      const out = await api.post('/examinations/blueprints', payload(), token);
      setNotes(out.target_notes || []); setCopiedFrom(null); setChosen(out.id); await load();
    }, 'New blueprint version saved');
  }
  async function checkFeasibility(draft) {
    const body = draft ? { blueprint: payload() } : { blueprint_id: chosen, seed: seed || undefined, override: overrideBody(override) };
    setFeasibility(null);
    const out = await run(() => api.post(`/examinations/${exam.id}/feasibility`, body, token));
    if (out) setFeasibility(out);
  }
  async function generate() {
    const body = { blueprint_id: chosen, seed: seed || undefined, override: overrideBody(override) };
    const out = await run(() => api.post(`/examinations/${exam.id}/generate`, body, token), 'Paper generated');
    if (out) { onChange(); onOpenPaper(out.paperId); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <Messages error={error} reasons={reasons} ok={ok} />
      {copiedFrom != null && <div className="alert alert-info">Copied from v{copiedFrom}. Saving creates a new version with exact targets.</div>}
      <div className="grid-2">
        <div className="field"><label htmlFor="bp-name">Name (optional)</label><input id="bp-name" value={bp.name} onChange={(e) => setBp({ ...bp, name: e.target.value })} /></div>
        {['easy_count', 'medium_count', 'hard_count', 'total_marks', 'reuse_lookback_exams'].map((k) => (
          <div className="field" key={k}><label htmlFor={`bp-${k}`}>{k.replaceAll('_', ' ')}</label>
            <input id={`bp-${k}`} type="number" min="0" value={bp[k]} onChange={(e) => setBp({ ...bp, [k]: e.target.value })} /></div>
        ))}
      </div>

      <h4 style={{ marginTop: 12 }}>Sections (optional)</h4>
      <p className="hint">Each section has its own question count and may fix marks per question, a section total, allowed question types and its easy/medium/hard split. Section question counts must add up to easy + medium + hard.
        An internal choice (attempt any k of the section&apos;s questions) needs fixed marks each; totals then count k questions.</p>
      {sections.map((x, i) => (
        <div className="card" key={i} style={{ marginBottom: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="field"><label htmlFor={`sec-name-${i}`}>Name</label><input id={`sec-name-${i}`} maxLength={60} value={x.name} onChange={(e) => setSection(i, { name: e.target.value })} /></div>
            <div className="field"><label htmlFor={`sec-n-${i}`}>Questions</label><input id={`sec-n-${i}`} type="number" min="1" value={x.question_count} onChange={(e) => setSection(i, { question_count: e.target.value })} /></div>
            <div className="field"><label htmlFor={`sec-mpq-${i}`}>Marks each (optional)</label><input id={`sec-mpq-${i}`} type="number" min="1" value={x.marks_per_question} onChange={(e) => setSection(i, { marks_per_question: e.target.value })} /></div>
            <div className="field"><label htmlFor={`sec-total-${i}`}>Section total (optional)</label><input id={`sec-total-${i}`} type="number" min="1" value={x.total_marks} onChange={(e) => setSection(i, { total_marks: e.target.value })} /></div>
            <div className="field"><label htmlFor={`sec-attempt-${i}`}>Attempt any (optional internal choice)</label><input id={`sec-attempt-${i}`} type="number" min="1" value={x.attempt_count} onChange={(e) => setSection(i, { attempt_count: e.target.value })} /></div>
            {['easy', 'medium', 'hard'].map((d) => (
              <div className="field" key={d}><label htmlFor={`sec-${d}-${i}`}>{d} (optional)</label><input id={`sec-${d}-${i}`} type="number" min="0" value={x[d]} onChange={(e) => setSection(i, { [d]: e.target.value })} /></div>
            ))}
          </div>
          <div className="field"><label>Allowed question types (none ticked = any)</label>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              {QUESTION_TYPES.map((t) => (
                <label key={t.code} style={{ fontWeight: 400 }}>
                  <input type="checkbox" checked={x.question_types.includes(t.code)}
                    onChange={(e) => setSection(i, { question_types: e.target.checked ? [...x.question_types, t.code] : x.question_types.filter((c) => c !== t.code) })} /> {t.label}
                </label>
              ))}
            </div>
          </div>
          <div className="field"><label htmlFor={`sec-ins-${i}`}>Instructions printed under the heading (optional, up to 500 characters)</label><input id={`sec-ins-${i}`} maxLength={500} value={x.instructions} onChange={(e) => setSection(i, { instructions: e.target.value })} /></div>
          <button className="btn-ghost btn-sm" onClick={() => setSections(sections.filter((_, j) => j !== i))}>Remove section</button>
        </div>
      ))}
      <button className="btn-ghost btn-sm" onClick={() => setSections([...sections, emptySection(sections.length)])}>Add section</button>

      <h4 style={{ marginTop: 12 }}>CO and Bloom targets (enforced exactly; CO codes must exist in this syllabus version)</h4>
      <div className="field"><label htmlFor="bp-co">CO targets: number of questions per CO, e.g. CO1:2, CO2:3</label>
        <input id="bp-co" value={coText} onChange={(e) => setCoText(e.target.value)} /></div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {BLOOMS.map((b) => (
          <div className="field" key={b} style={{ maxWidth: 120 }}><label htmlFor={`bl-${b}`}>{b} %</label>
            <input id={`bl-${b}`} type="number" min="0" max="100" value={bloom[b] ?? ''} onChange={(e) => setBloom({ ...bloom, [b]: e.target.value })} /></div>
        ))}
      </div>
      <p className="hint">Bloom percentages total {bloomSum}%. At 100% every level is fixed exactly (unlisted levels get none); below 100% the listed levels get that share of the questions and the unlisted levels are free.</p>
      {problems.length > 0 && <div className="alert alert-warn"><strong>Fix before saving:</strong><ul style={{ margin: '4px 0 0 18px' }}>{problems.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      {notes.length > 0 && <div className="alert alert-info">Notes on the saved targets:<ul style={{ margin: '4px 0 0 18px' }}>{notes.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn-ghost btn-sm" disabled={problems.length > 0} onClick={saveBlueprint}>Save as new blueprint version</button>
        <button className="btn-ghost btn-sm" disabled={problems.length > 0} onClick={() => checkFeasibility(true)}>Check this draft</button>
      </div>
      <p className="hint">Saving never edits an earlier version. Papers keep the exact version they were generated from.</p>

      <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
        <select value={chosen} onChange={(e) => { setChosen(e.target.value); setViewing(false); }} aria-label="Blueprint version">
          <option value="">Choose blueprint…</option>
          {bps.map((b) => <option key={b.id} value={b.id}>{blueprintLabel(b)}</option>)}
        </select>
        <button className="btn-ghost btn-sm" disabled={!chosen} onClick={() => setViewing(!viewing)}>{viewing ? 'Hide' : 'View'}</button>
        <input placeholder="seed (optional, for reproducibility)" value={seed} onChange={(e) => setSeed(e.target.value)} aria-label="Seed" />
        <button className="btn-ghost btn-sm" disabled={!chosen || !!blocked || overrideIncomplete(override)} onClick={() => checkFeasibility(false)}>Check feasibility</button>
        <button className="btn-primary" disabled={!chosen || live || printed || !!blocked || overrideIncomplete(override)} onClick={generate}>Generate paper</button>
      </div>
      {blocked && (
        <div className="alert alert-warn" style={{ marginTop: 6 }}>{blocked}{' '}
          <button className="btn-ghost btn-sm" onClick={() => run(async () => copyIntoEditor(await api.get(`/examinations/blueprints/${chosen}`, token)))}>Copy into editor</button>
        </div>
      )}
      {live && <p className="hint">This examination already has a paper in progress. Open it from Papers and regenerate it as a new revision, or archive it, to generate again.</p>}
      {!live && printed && <p className="hint">This examination has a printed paper. A later change is a new revision of it: open it from Papers and use &quot;Revise printed paper&quot; (or archive it at the end of its exam cycle).</p>}
      {viewing && chosen && <BlueprintDetail key={chosen} token={token} id={chosen} onCopy={copyIntoEditor} />}
      <OverrideFields value={override} onChange={setOverride} idPrefix="gen" />
      <FeasibilityResult result={feasibility} onUseSeed={setSeed} />
    </div>
  );
}

function PaperList({ token, onOpen }) {
  const [rows, setRows] = useState([]);
  const { error, loading, run } = useAsync();
  useEffect(() => { run(async () => setRows(await api.get('/examinations/papers', token))); }, [token, run]);
  return (
    <div>
      <Messages error={error} reasons={[]} ok="" />
      {loading && rows.length === 0 && <p className="hint" role="status">Loading…</p>}
      {!loading && !error && rows.length === 0 && <div className="empty-state">No papers yet.</div>}
      {rows.map((p) => (
        <div key={p.id} className="list-item row" style={{ justifyContent: 'space-between' }}>
          <div>{p.subject_code} · {p.exam_type} · v{p.paper_version} <StatusBadge status={p.paper_status} />
            <span className="hint"> validators {p.validators}/4 · approvals {p.approvals}/{p.required_approvals || 4} needed · open issues {p.open_issues}</span></div>
          <button className="btn-ghost btn-sm" onClick={() => onOpen(p.id)}>Open</button>
        </div>
      ))}
    </div>
  );
}

function PaperDetail({ token, paperId, totpEnabled, onSetupTotp, onBack, onOpen }) {
  const [paper, setPaper] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [pick, setPick] = useState(['', '', '', '']);
  const [issues, setIssues] = useState([]);
  const [totp, setTotp] = useState('');
  const [reason, setReason] = useState('');
  const [excludeFlagged, setExcludeFlagged] = useState(true);
  const [archiveReason, setArchiveReason] = useState('');
  const [sendBackReason, setSendBackReason] = useState('');
  const [replacing, setReplacing] = useState(null);
  const [coeStatus, setCoeStatus] = useState(null);
  const [bpOptions, setBpOptions] = useState([]);
  const [regenBp, setRegenBp] = useState('');
  const [regenSeed, setRegenSeed] = useState('');
  const [regenOverride, setRegenOverride] = useState(emptyOverride());
  const [reviseReason, setReviseReason] = useState('');
  const { error, reasons, ok, run } = useAsync();

  const load = useCallback(async () => {
    const p = await api.get(`/examinations/papers/${paperId}`, token);
    setPaper(p);
    // Regenerate may use any version of this examination's blueprint. Default: the paper's own version, unless it
    // can no longer generate (legacy soft targets); then the newest active version that can.
    const list = await api.get(`/examinations/blueprints?examination_id=${p.examination_id}`, token);
    setBpOptions(list);
    const own = list.find((b) => b.id === p.blueprint_version_id);
    setRegenBp((cur) => cur || ((own && !own.generation_blocked_reason ? own : list.find((b) => b.is_active && !b.generation_blocked_reason))?.id || ''));
    setIssues(await api.get(`/examinations/papers/${paperId}/issues`, token));
    setAssignments(await api.get(`/examinations/papers/${paperId}/validators?history=1`, token));
    setCandidates(await api.get(`/examinations/validators?paper_id=${paperId}`, token));
    setCoeStatus(await api.get(`/coe/papers/${paperId}/coe-status`, token));
  }, [paperId, token]);
  useEffect(() => { run(load); }, [load, run]);

  if (!paper) return <Pending error={error} reasons={reasons} what="the paper" />;
  const st = paper.paper_status;
  const act = (fn, msg) => run(async () => { await fn(); await load(); }, msg);
  const active = assignments.filter((a) => a.is_active);
  const ended = assignments.filter((a) => !a.is_active);
  const openIssues = issues.filter((i) => i.status === 'open');
  const free = candidates.filter((u) => !u.conflicts.length && u.assigned_as == null);

  return (
    <div>
      <button className="btn-ghost btn-sm" onClick={onBack}>← Back</button>
      <h3>{paper.title} <StatusBadge status={st} /></h3>
      <p className="hint">Seed {paper.generation_seed} · generator {paper.generator_version} · {paper.maximum_marks} marks
        {paper.blueprint ? ` · blueprint v${paper.blueprint.version_number} (${paper.blueprint.target_mode === 'hard' ? 'exact targets' : 'legacy soft targets'})` : ''}
        {paper.required_approvals ? ` · needs ${paper.required_approvals} of 4 validator approvals` : ''}</p>
      <PaperOutput status={st}>
        <PdfActions token={token} run={run} path={`/examinations/papers/${paperId}/pdf`} filename={`paper-v${paper.paper_version || 1}.pdf`} label="paper" title="Question paper" />
        <PdfActions token={token} run={run} path={`/examinations/papers/${paperId}/pdf?include_answers=1`} filename={`paper-v${paper.paper_version || 1}-answers.pdf`} label="paper with answer key" title="With answer key (internal)" />
      </PaperOutput>
      {st === 'ARCHIVED' && paper.archive_reason && <div className="alert alert-info">Archived: {paper.archive_reason}</div>}
      {paper.send_backs?.length > 0 && (
        <div className="alert alert-info">Sent back from {String(paper.send_backs[0].from_status).replaceAll('_', ' ')} on {fmt(paper.send_backs[0].created_at)}: {paper.send_backs[0].reason}</div>
      )}
      <Messages error={error} reasons={reasons} ok={ok} />

      <ValidationSummary view={paper.validation_view} />

      <div className="card">
        <h4>Questions</h4>
        <OverrideNotice override={paper.constraint_overrides} />
        <InternalChoiceSummary paper={paper} />
        <SectionedQuestions paper={paper} renderQuestion={(q) => (
          <div className="list-item" style={{ display: 'block' }}>
            <strong>Q{q.slot_number}.</strong><PrintedAs q={q} /> <span className="badge badge-draft">{q.marks} marks</span><CoChips q={q} />{' '}
            <span className="hint">{typeLabel(q.meta?.question_type)} · {q.meta?.difficulty} · {q.meta?.bloom_level} · {q.meta?.topic}</span>
            <QuestionView q={fromPaperQuestion(q)} token={token} showType={false} fileUrl={(a) => `/examinations/papers/${paperId}/attachments/${a.id}`} />
            <div className="hint">Why selected: {q.selection_reason || '—'}</div>
          </div>
        )} />
      </div>

      {['GENERATED', 'CHANGES_REQUIRED'].includes(st) && (
        <div className="card">
          <h4>{st === 'GENERATED' ? 'Assign exactly 4 validators' : 'Regenerate (new revision)'}</h4>
          {st === 'GENERATED' && (
            <>
              <p className="hint">Validators with a conflict cannot be chosen: COE of this paper, author of one of its questions, inactive account,
                no validator scope for this campus, or (when the institutional policy is on) reviewer of one of its questions.</p>
              {pick.map((v, i) => (
                <div className="field" key={i}><label htmlFor={`pick-${i}`}>Validator {i + 1}</label>
                  <select id={`pick-${i}`} value={v} onChange={(e) => setPick(pick.map((x, j) => (j === i ? e.target.value : x)))}>
                    <option value="">Select…</option>
                    {candidates.map((u) => (
                      <option key={u.id} value={u.id} disabled={u.conflicts.length > 0 || pick.some((x, j) => j !== i && x === u.id)}>
                        {u.full_name || u.email}{u.conflicts.length ? ` — ${u.conflicts.join('; ')}` : ''}
                      </option>
                    ))}
                  </select></div>
              ))}
              <button className="btn-primary" disabled={pick.some((x) => !x) || new Set(pick).size !== 4}
                onClick={() => act(() => api.post(`/examinations/papers/${paperId}/validators`, { validator_ids: pick }, token), 'Validators assigned')}>Assign &amp; send for validation</button>
              <hr />
            </>
          )}
          <div className="field"><label htmlFor="regen-reason">Reason for regenerating</label><input id="regen-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <label style={{ fontWeight: 400, display: 'block', margin: '4px 0 8px' }}>
            <input type="checkbox" checked={excludeFlagged} onChange={(e) => setExcludeFlagged(e.target.checked)} /> Leave out questions with open issues (recommended)
          </label>
          {openIssues.length > 0 && (
            <p className="hint">{openIssues.length} open issue(s): issues on questions the new revision replaces are resolved automatically; the others are carried to the new revision and must be closed there.</p>
          )}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="field"><label htmlFor="regen-bp">Blueprint version</label>
              <select id="regen-bp" value={regenBp} onChange={(e) => setRegenBp(e.target.value)}>
                <option value="">Choose blueprint…</option>
                {bpOptions.map((b) => (
                  <option key={b.id} value={b.id} disabled={!!b.generation_blocked_reason}>
                    {blueprintLabel(b)}{b.id === paper.blueprint_version_id ? ' · this paper' : ''}{b.generation_blocked_reason ? ' · cannot generate' : ''}
                  </option>
                ))}
              </select></div>
            <div className="field"><label htmlFor="regen-seed">Seed (optional)</label><input id="regen-seed" value={regenSeed} onChange={(e) => setRegenSeed(e.target.value)} /></div>
          </div>
          {bpOptions.find((b) => b.id === paper.blueprint_version_id)?.generation_blocked_reason && (
            <p className="hint">This paper&apos;s blueprint version has legacy soft targets and can no longer generate; choose a newer version (copy it into the editor and save it under Examinations).</p>
          )}
          <OverrideFields value={regenOverride} onChange={setRegenOverride} idPrefix="regen" />
          <button className="btn-amber" style={{ marginTop: 8 }} disabled={reason.trim().length < 3 || !regenBp || overrideIncomplete(regenOverride)} onClick={async () => {
            const out = await run(() => api.post(`/examinations/papers/${paperId}/regenerate`, {
              reason, exclude_flagged_questions: excludeFlagged, blueprint_id: regenBp, seed: regenSeed || undefined, override: overrideBody(regenOverride),
            }, token), 'New revision generated');
            if (out) onOpen(out.paperId);
          }}>Regenerate as new revision</button>
        </div>
      )}

      {active.length > 0 && (
        <div className="card"><h4>Validators</h4>
          {active.map((a) => (
            <div key={a.assignment_id} className="list-item">
              {a.validator_number}. {a.full_name || a.email} — {a.decision ? <StatusBadge status={a.decision} /> : <span className="hint">pending</span>}
              <span className="hint"> · round {a.validation_round}</span>
              {a.comments && <div className="hint">“{a.comments}”</div>}
              {a.problems?.length > 0 && <div className="alert alert-warn" style={{ marginTop: 4 }}>Needs replacement: {a.problems.join('; ')}</div>}
              {REPLACEABLE_IN.includes(st) && (a.decision
                ? <div className="hint">Recorded decision — cannot be replaced</div>
                : replacing === a.validator_number
                  ? <ReplaceForm token={token} paperId={paperId} slot={a.validator_number} options={free} run={run}
                      onCancel={() => setReplacing(null)} onDone={async () => { setReplacing(null); await load(); }} />
                  : <button className="btn-ghost btn-sm" style={{ marginLeft: 8 }} disabled={!free.length} title={free.length ? '' : 'No eligible validator is free'}
                      onClick={() => setReplacing(a.validator_number)}>Replace</button>)}
            </div>
          ))}
          {ended.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary>Earlier assignments ({ended.length})</summary>
              {ended.map((a) => (
                <div key={a.assignment_id} className="list-item hint">
                  Round {a.validation_round}, validator {a.validator_number}: {a.full_name || a.email} — {a.decision ? <StatusBadge status={a.decision} /> : 'no decision'}
                  {' '}· ended {fmt(a.deactivated_at)} ({ENDED_REASON[a.deactivation_reason] || a.deactivation_reason}){a.deactivation_note ? `: ${a.deactivation_note}` : ''}
                  {a.comments && <div>“{a.comments}”</div>}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
      {active.length === 0 && ended.length > 0 && (
        <div className="card"><h4>Validators (ended)</h4>
          {ended.map((a) => (
            <div key={a.assignment_id} className="list-item hint">
              Round {a.validation_round}, validator {a.validator_number}: {a.full_name || a.email} — {a.decision ? <StatusBadge status={a.decision} /> : 'no decision'}
              {' '}· {ENDED_REASON[a.deactivation_reason] || a.deactivation_reason}{a.comments && <div>“{a.comments}”</div>}
            </div>
          ))}
        </div>
      )}

      {issues.length > 0 && (
        <div className="card"><h4>Issues reported by validators</h4>
          {issues.map((i) => <IssueRow key={i.id} issue={i} token={token} closable={ISSUE_CLOSABLE_IN.includes(st)} run={run} onDone={load} />)}
        </div>
      )}

      {SEND_BACK_FROM.includes(st) && (
        <div className="card"><h4>Send back for changes</h4>
          <p className="hint">{openIssues.length} open issue(s). The paper goes to CHANGES REQUIRED; regenerate it as a new revision. Validator decisions stay on record.</p>
          <div className="field"><label htmlFor="send-back-reason">Reason (at least 10 characters)</label>
            <textarea id="send-back-reason" value={sendBackReason} onChange={(e) => setSendBackReason(e.target.value)} /></div>
          <button className="btn-danger" disabled={sendBackReason.trim().length < 10}
            onClick={() => act(async () => { await api.post(`/coe/papers/${paperId}/send-back`, { reason: sendBackReason.trim() }, token); setSendBackReason(''); }, 'Paper sent back for changes')}>Send back</button>
        </div>
      )}

      {st === 'VALIDATED' && (
        <div className="card"><h4>Final COE approval</h4>
          <p className="hint">
            {coeStatus ? `${coeStatus.validator_approvals} of 4 validators approved (${coeStatus.required_approvals} required).` : ''}
            {' '}Approval needs your authenticator (TOTP) code.
          </p>
          {coeStatus?.blockers?.length > 0 && (
            <div className="alert alert-warn"><strong>Not ready yet:</strong>
              <ul style={{ margin: '4px 0 0 18px' }}>{coeStatus.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          )}
          {!totpEnabled ? (
            <div className="alert alert-warn">You have not set up an authenticator yet. <button className="btn-ghost btn-sm" onClick={onSetupTotp}>Set it up</button></div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <label htmlFor="coe-totp" className="hint">Authenticator code</label>
              <input id="coe-totp" placeholder="6-digit code" inputMode="numeric" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} />
              <button className="btn-primary" disabled={totp.length !== 6 || coeStatus?.blockers?.length > 0}
                onClick={() => act(() => api.post(`/coe/papers/${paperId}/coe-approve`, { totp_code: totp }, token), 'Approved')}>Approve</button>
            </div>
          )}
        </div>
      )}
      {st === 'COE_APPROVED' && (
        <div className="card"><h4>Lock for printing</h4>
          <p className="hint">Marking PRINT_READY locks this paper permanently. Any later change becomes a new revision. If this examination already has a printed paper (an earlier version), it is archived in the same step.</p>
          <button className="btn-primary" onClick={() => act(() => api.post(`/coe/papers/${paperId}/print-ready`, {}, token), 'Paper is PRINT_READY and locked')}>Mark PRINT_READY</button>
        </div>
      )}
      {st === 'PRINT_READY' && (
        <div className="card"><h4>Revise printed paper (new revision)</h4>
          <p className="hint">This paper is locked. A change becomes a new revision (v{(paper.paper_version || 1) + 1}) that goes through 4 validators and your approval again.
            This printed paper stays as it is until the revision is marked PRINT_READY; it is then archived automatically.</p>
          <div className="field"><label htmlFor="revise-reason">Reason (at least 10 characters)</label>
            <input id="revise-reason" value={reviseReason} onChange={(e) => setReviseReason(e.target.value)} /></div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="field"><label htmlFor="revise-bp">Blueprint version</label>
              <select id="revise-bp" value={regenBp} onChange={(e) => setRegenBp(e.target.value)}>
                <option value="">Choose blueprint…</option>
                {bpOptions.map((b) => (
                  <option key={b.id} value={b.id} disabled={!!b.generation_blocked_reason}>
                    {blueprintLabel(b)}{b.id === paper.blueprint_version_id ? ' · this paper' : ''}{b.generation_blocked_reason ? ' · cannot generate' : ''}
                  </option>
                ))}
              </select></div>
            <div className="field"><label htmlFor="revise-seed">Seed (optional)</label><input id="revise-seed" value={regenSeed} onChange={(e) => setRegenSeed(e.target.value)} /></div>
          </div>
          <OverrideFields value={regenOverride} onChange={setRegenOverride} idPrefix="revise" />
          <button className="btn-amber" style={{ marginTop: 8 }} disabled={reviseReason.trim().length < 10 || !regenBp || overrideIncomplete(regenOverride)} onClick={async () => {
            const out = await run(() => api.post(`/examinations/papers/${paperId}/revise`, {
              reason: reviseReason.trim(), blueprint_id: regenBp, seed: regenSeed || undefined, override: overrideBody(regenOverride),
            }, token), 'New revision generated');
            if (out) onOpen(out.paperId);
          }}>Create new revision</button>
        </div>
      )}
      {ARCHIVABLE.includes(st) && (
        <div className="card"><h4>Archive</h4>
          <p className="hint">
            {st === 'PRINT_READY' ? 'Archive this printed paper at the end of its exam cycle. Nothing is deleted or changed. (Printing a revision of it archives it automatically.)'
              : 'Archive this revision if it will not be used. It stays in the history; nothing is deleted.'}
          </p>
          <div className="field"><label htmlFor="archive-reason">Reason (at least 10 characters)</label>
            <input id="archive-reason" value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} /></div>
          <button className="btn-ghost" disabled={archiveReason.trim().length < 10}
            onClick={() => act(() => api.post(`/coe/papers/${paperId}/archive`, { reason: archiveReason.trim() }, token), 'Paper archived')}>Archive paper</button>
        </div>
      )}
    </div>
  );
}

// Replace one undecided validator: eligible, unassigned candidates only, with a reason.
function ReplaceForm({ token, paperId, slot, options, run, onCancel, onDone }) {
  const [who, setWho] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" style={{ marginTop: 6 }}>
      <div className="field"><label htmlFor={`replace-${slot}`}>New validator {slot}</label>
        <select id={`replace-${slot}`} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Select…</option>
          {options.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
        </select></div>
      <div className="field"><label htmlFor={`replace-why-${slot}`}>Reason (at least 10 characters)</label>
        <input id={`replace-why-${slot}`} minLength={10} value={why} onChange={(e) => setWhy(e.target.value)} /></div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn-primary btn-sm" disabled={busy || !who || why.trim().length < 10} onClick={async () => {
          setBusy(true);
          try {
            const out = await run(() => api.post(`/examinations/papers/${paperId}/validators/${slot}/replace`, { validator_id: who, reason: why.trim() }, token), 'Validator replaced');
            if (out) await onDone();
          } finally { setBusy(false); }
        }}>Replace validator</button>
        <button className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// One validator issue: close it once (resolved / won't fix) or refer its source question to the reviewer.
function IssueRow({ issue, token, closable, run, onDone }) {
  const [mode, setMode] = useState('');
  const [resolution, setResolution] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (fn, msg) => {
    setBusy(true);
    try { const out = await run(fn, msg); if (out) await onDone(); } finally { setBusy(false); }
  };
  const i = issue;
  return (
    <div className="list-item">
      {i.slot_number ? `Q${i.slot_number} · ` : 'Whole paper · '}<strong>{i.issue_type}</strong> — {i.description} <StatusBadge status={i.status} />
      <div className="hint">
        Reported by {i.reported_by_email || 'a validator'} on {fmt(i.created_at)}
        {i.carried_from_version ? ` · carried from v${i.carried_from_version}` : ''}
        {i.resolution ? ` · Resolution: ${i.resolution}` : ''}{i.resolved_by_email ? ` (${i.resolved_by_email})` : ''}
        {i.referred_at ? ` · referred to ${i.referred_to_count} ${i.referred_to_role === 'hod' ? 'HOD(s)' : 'reviewer(s)'} on ${fmt(i.referred_at)}` : ''}
      </div>
      {i.status === 'open' && closable && (
        <fieldset style={{ border: 0, padding: 0, margin: '6px 0' }}>
          <legend className="hint">Close this issue (final)</legend>
          <label style={{ fontWeight: 400, marginRight: 12 }}><input type="radio" name={`close-${i.id}`} checked={mode === 'resolved'} onChange={() => setMode('resolved')} /> Resolved — no longer applies to this paper</label>
          <label style={{ fontWeight: 400 }}><input type="radio" name={`close-${i.id}`} checked={mode === 'wont_fix'} onChange={() => setMode('wont_fix')} /> Won&apos;t fix — accepted as is</label>
          <div className="field"><label htmlFor={`res-${i.id}`}>Resolution ({resolution.trim().length} characters, at least 10)</label>
            <textarea id={`res-${i.id}`} value={resolution} onChange={(e) => setResolution(e.target.value)} /></div>
          <p className="hint">The paper itself never changes; to change its content, send it back and regenerate.</p>
          <button className="btn-ghost btn-sm" disabled={busy || !mode || resolution.trim().length < 10}
            onClick={() => send(() => api.post(`/examinations/issues/${i.id}/resolve`, { status: mode, resolution: resolution.trim() }, token), 'Issue closed')}>Close issue</button>
        </fieldset>
      )}
      {i.question_id && !i.referred_at && (
        <details style={{ marginTop: 4 }}>
          <summary>Refer source question to reviewer</summary>
          <div className="field"><label htmlFor={`ref-${i.id}`}>Note for the reviewer (at least 10 characters)</label>
            <textarea id={`ref-${i.id}`} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <p className="hint">The reviewer sees only your note and the issue type; do not mention the paper or exam.</p>
          <button className="btn-ghost btn-sm" disabled={busy || note.trim().length < 10}
            onClick={() => send(() => api.post(`/examinations/issues/${i.id}/refer`, { note: note.trim() }, token), 'Source question referred')}>Refer</button>
        </details>
      )}
    </div>
  );
}
