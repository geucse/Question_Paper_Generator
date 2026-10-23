// Phase 4a route tests: per-type normalisation on draft save (create and edit, all 13 types, valid and invalid),
// diagram uploads, the full question in the review lists, type-aware mistake detection, the question-bank export
// (roles, scope, columns, round trip through the bulk import) and the 13-type template.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { sql, log, baseRules, start, call, tokenFor, USERS, IDS, installWorld } from './harness.mjs';
import { QUESTION_TYPE_CODES, normalizeQuestionData } from '../src/question-types.js';
import { SHEET_COLUMNS } from '../src/question-export.js';

const QID = '9a400000-0000-0000-0000-000000000001';
const PORT = () => process.env.PORT;
let existing;

before(start);
after(() => setTimeout(() => process.exit(0), 50).unref());
beforeEach(() => {
  baseRules();
  existing = null;
  sql(/FROM teacher_course_assignments tca/i, [{ course_offering_id: IDS.off, section_id: null, subject_id: IDS.subj }]);
  sql(/INSERT INTO questions/i, [{ id: QID }]);
  sql(/SELECT \* FROM questions WHERE id = \$1$/i, () => (existing ? [existing] : []));
  sql(/UPDATE questions SET question_type=\$1/i, () => [{ id: QID, question_status: existing?.question_status || 'DRAFT' }]);
});

const base = { question_text: 'Explain the following carefully', difficulty: 'easy', marks: 2, course_offering_id: IDS.off, model_answer: 'A long enough model answer' };
// Valid input per type, deliberately with fields the type does not use (they must be dropped) and loose forms
// (an MCQ letter, a lower-case key, numbers as strings, fill-blank answers as text).
const VALID = {
  mcq: { option_a: ' O(n) ', option_b: 'O(log n)', option_c: 'O(1)', option_d: 'O(n^2)', correct_answer: 'b', answer_data: { case_text: 'stale case text' } },
  true_false: { correct_answer: 'true', option_a: 'stale option' },
  assertion_reason: { correct_answer: 'a', answer_data: { assertion: ' Heaps are complete trees ', reason: 'They fill level by level', expected_value: 3 } },
  numerical: { correct_answer: 'B', answer_data: { expected_value: '9.8', tolerance: '0.1', unit: ' m/s^2 ', language: 'C' } },
  fill_blank: { question_text: 'A stack is ___ and a queue is ___.', answer_data: { answers: ' LIFO | FIFO ' } },
  programming: { answer_data: { language: ' Python ', constraints: 'O(n)', answers: ['x'] }, option_a: 'stale' },
  case_study: { answer_data: { case_text: 'A library holds two million records and needs range queries.', unit: 'kg' } },
  diagram: { correct_answer: 'A' },
  short_answer: {}, long_answer: {}, derivation: {}, proof: {}, descriptive: { answer_data: { language: 'C' } },
};
// What must be stored for each.
const STORED = {
  mcq: { option_a: 'O(n)', option_b: 'O(log n)', option_c: 'O(1)', option_d: 'O(n^2)', correct_answer: 'O(log n)', answer_data: null },
  true_false: { option_a: null, correct_answer: 'TRUE', answer_data: null },
  assertion_reason: { correct_answer: 'A', answer_data: { assertion: 'Heaps are complete trees', reason: 'They fill level by level' } },
  numerical: { correct_answer: null, answer_data: { expected_value: 9.8, tolerance: 0.1, unit: 'm/s^2' } },
  fill_blank: { answer_data: { answers: ['LIFO', 'FIFO'] } },
  programming: { option_a: null, answer_data: { language: 'Python', constraints: 'O(n)' } },
  case_study: { answer_data: { case_text: 'A library holds two million records and needs range queries.' } },
  diagram: { correct_answer: null, answer_data: null },
  short_answer: { answer_data: null }, long_answer: { answer_data: null }, derivation: { answer_data: null }, proof: { answer_data: null }, descriptive: { answer_data: null },
};
const INVALID = {
  mcq: [{ option_a: 'x', option_b: 'y', correct_answer: 'z' }, /exactly match one of the provided options/],
  true_false: [{ correct_answer: 'maybe' }, /TRUE or FALSE/],
  assertion_reason: [{ correct_answer: 'E', answer_data: { assertion: 'x', reason: 'y' } }, /A, B, C or D/],
  numerical: [{ answer_data: { expected_value: 'about nine' } }, /expected_value \(a number\)/],
  fill_blank: [{ question_text: 'A ___ and a ___ here', answer_data: { answers: 'x' } }, /2 blank\(s\) but 1 answer/],
  programming: [{ answer_data: { constraints: 'none' } }, /needs answer_data.language/],
  case_study: [{ answer_data: { case_text: 'too short' } }, /case_text/],
  diagram: [{ marks: 0 }, /marks must be greater than zero/],
  short_answer: [{ question_text: 'Hi' }, /at least 5 characters/],
  long_answer: [{ difficulty: 'impossible' }, /difficulty must be/],
  derivation: [{ marks: 2.5 }, /whole number/],
  proof: [{ answer_data: '{broken' }, /answer_data must be a JSON object/],
  descriptive: [{ question_type: 'essay' }, /question_type must be one of/],
};
// Column order of INSERT INTO questions (routes/questions.js) and of UPDATE questions SET question_type=$1...
const INS = { question_type: 4, option_a: 6, option_b: 7, option_c: 8, option_d: 9, correct_answer: 10, answer_data: 18 };
const UPD = { question_type: 0, option_a: 2, option_b: 3, option_c: 4, option_d: 5, correct_answer: 6, answer_data: 15 };
const stored = (params, idx, key) => (key === 'answer_data' ? (params[idx[key]] == null ? null : JSON.parse(params[idx[key]])) : params[idx[key]]);

test('draft create: each of the 13 types is stored in its normal form (letter -> text, upper-cased keys, unused data dropped)', async () => {
  for (const type of QUESTION_TYPE_CODES) {
    log.length = 0;
    const r = await call('POST', '/questions/draft', { ...base, question_type: type, ...VALID[type] }, 'teacher');
    assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.data)}`);
    const ins = log.find((l) => /^INSERT INTO questions/.test(l.text));
    assert.equal(ins.params[INS.question_type], type);
    for (const [k, v] of Object.entries(STORED[type])) assert.deepEqual(stored(ins.params, INS, k), v, `${type}.${k}`);
    if (type !== 'mcq') for (const k of ['option_a', 'option_b', 'option_c', 'option_d']) assert.equal(ins.params[INS[k]], null, `${type}: ${k} dropped`);
  }
});

test('draft edit: the same normal form on UPDATE for each of the 13 types; a type change strips the old type\'s data', async () => {
  for (const type of QUESTION_TYPE_CODES) {
    existing = { id: QID, submitted_by: USERS.teacher.id, question_status: 'DRAFT', course_offering_id: IDS.off, section_id: null, syllabus_version_id: IDS.sv, question_type: 'mcq',
      option_a: 'old a', option_b: 'old b', correct_answer: 'old a', answer_data: { case_text: 'old' }, question_text: base.question_text, difficulty: 'easy', marks: 2 };
    log.length = 0;
    const r = await call('POST', '/questions/draft', { ...base, id: QID, question_type: type, ...VALID[type] }, 'teacher');
    assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.data)}`);
    const upd = log.find((l) => /^UPDATE questions SET question_type=\$1/.test(l.text));
    assert.equal(upd.params[UPD.question_type], type);
    for (const [k, v] of Object.entries(STORED[type])) assert.deepEqual(stored(upd.params, UPD, k), v, `${type}.${k}`);
    const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'draft_updated');
    if (type !== 'mcq') assert.ok(JSON.parse(audit.params[4]).metadata_changes.question_type, `${type}: the type change is recorded`);
  }
});

test('draft create and edit: an invalid question of each of the 13 types is refused with the reason; nothing is written', async () => {
  for (const type of QUESTION_TYPE_CODES) {
    const [over, re] = INVALID[type];
    for (const id of [undefined, QID]) {
      existing = id ? { id: QID, submitted_by: USERS.teacher.id, question_status: 'DRAFT', course_offering_id: IDS.off } : null;
      log.length = 0;
      const r = await call('POST', '/questions/draft', { ...base, id, question_type: type, ...VALID[type], ...over }, 'teacher');
      assert.equal(r.status, 400, `${type} ${id ? 'edit' : 'create'}: ${JSON.stringify(r.data)}`);
      assert.ok(r.data.details.some((d) => re.test(d)), `${type}: ${JSON.stringify(r.data.details)}`);
      assert.equal(log.some((l) => /^(INSERT INTO|UPDATE) questions/.test(l.text)), false, `${type}: nothing written`);
    }
  }
  for (const who of ['hod', 'reviewer', 'coe', 'admin']) {
    assert.equal((await call('POST', '/questions/draft', { ...base, question_type: 'mcq', ...VALID.mcq }, who)).status, 403, who);
  }
});

// ---- diagram uploads must be printable ----
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from([0x0e, 0, 0, 0, 0x30, 0x01, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0])]);
async function upload(buf, name, type) {
  const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name);
  const r = await fetch(`http://localhost:${PORT()}/api/attachments/${QID}`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor('teacher')}` }, body: fd });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
test('attachments: a diagram question refuses a non-PNG/JPEG file with a clear reason (nothing stored); other types may attach it', async () => {
  let type = 'diagram';
  sql(/SELECT id, question_status, question_type FROM questions WHERE id = \$1 AND submitted_by/i, () => [{ id: QID, question_status: 'DRAFT', question_type: type }]);
  sql(/COUNT\(\*\)::int as c FROM question_attachments/i, [{ c: 0 }]);
  sql(/INSERT INTO question_attachments/i, []);
  const r = await upload(WEBP, 'tree.webp', 'image/webp');
  assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, /PNG or JPEG/);
  assert.equal(log.some((l) => /INSERT INTO question_attachments/.test(l.text)), false);
  const rej = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'attachment_rejected_type');
  assert.equal(JSON.parse(rej.params[4]).reason, 'diagram_not_printable');
  type = 'descriptive'; log.length = 0;
  const other = await upload(WEBP, 'notes.webp', 'image/webp');
  assert.equal(other.status, 409, 'past the type check (the scripted insert then finds the question no longer editable)');
  assert.ok(log.some((l) => /INSERT INTO question_attachments/.test(l.text)));
});

// ---- the full question on the review screens ----
test('HOD attention list and review-batch detail carry the full question and its clean attachments', async () => {
  sql(/FROM questions q JOIN users u/i, []);
  assert.equal((await call('GET', '/questions/queue', null, 'hod')).status, 200);
  const q = log.find((l) => /FROM questions q JOIN users u/.test(l.text));
  for (const c of ['q.option_a', 'q.correct_answer', 'q.model_answer', 'q.answer_data', 'q.subtopic']) assert.ok(q.text.includes(c), c);
  assert.match(q.text, /FROM question_attachments a WHERE a.question_id = q.id AND a.scan_status = 'clean'/);
});

// ---- mistake detection is type-aware ----
test('mistakes: the incomplete check applies every type\'s rules (forActivation), not only MCQ answers', async () => {
  installWorld();
  const rows = [
    { id: 'q-ok', question_type: 'numerical', question_text: 'How many?', answer_data: { expected_value: 3 }, model_answer: 'three things', marks: 2, attachment_count: 0, diagram_image_count: 0 },
    { id: 'q-num', question_type: 'numerical', question_text: 'How many?', answer_data: {}, model_answer: 'three things', marks: 2, attachment_count: 0, diagram_image_count: 0 },
    { id: 'q-prog', question_type: 'programming', question_text: 'Write it', answer_data: { language: 'C' }, model_answer: null, marks: 2, attachment_count: 0, diagram_image_count: 0 },
    { id: 'q-diag', question_type: 'diagram', question_text: 'Label it', model_answer: 'labels here', marks: 2, attachment_count: 1, diagram_image_count: 0 },
    { id: 'q-mcq', question_type: 'mcq', question_text: 'Pick', option_a: 'a', option_b: 'b', correct_answer: 'a', model_answer: 'because a', marks: 0, attachment_count: 0, diagram_image_count: 0 },
  ];
  sql(/diagram_image_count/i, rows);
  const r = await call('GET', `/questions/mistakes/${USERS.teacher.id}`, null, 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const inc = Object.fromEntries(r.data.issues.filter((i) => i.type === 'incomplete_question').map((i) => [i.question_id, i.detail]));
  assert.equal(inc['q-ok'], undefined);
  assert.match(inc['q-num'], /^Numerical: .*expected_value/);
  assert.match(inc['q-prog'], /^Programming: .*model answer/);
  assert.match(inc['q-diag'], /^Diagram: .*PNG or JPEG/);
  assert.match(inc['q-mcq'], /all four options/); assert.match(inc['q-mcq'], /Invalid marks/);
});

// ---- export ----
const exportRows = () => QUESTION_TYPE_CODES.map((type) => {
  const n = normalizeQuestionData({ question_type: type, ...VALID[type] });
  return { ...n, answer_data: Object.keys(n.answer_data).length ? n.answer_data : null, question_text: type === 'fill_blank' ? VALID.fill_blank.question_text : `Explain ${type} question number one`,
    model_answer: 'A long enough model answer', difficulty: 'easy', topic: 'Trees', subtopic: null, marks: 2, bloom: 'apply', cos: ['CO1', 'CO2'] };
});
async function exportAs(who, query = '') {
  const r = await fetch(`http://localhost:${PORT()}/api/question-bank/export${query}`, { headers: { Authorization: `Bearer ${tokenFor(who)}` } });
  return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
}
const exportQuery = () => log.find((l) => /FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p .* LIMIT \$5/.test(l.text));

test('export: teacher (own), reviewer (assigned, in scope, never own), HOD (scope); the import template columns; audited', async () => {
  installWorld();
  sql(/LIMIT \$5/i, exportRows);
  const t = await exportAs('teacher');
  assert.equal(t.status, 200); assert.match(t.type, /spreadsheetml/);
  const sheet = XLSX.read(t.buf, { type: 'buffer' }).Sheets.Questions;
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  assert.equal(rows.length, 13); assert.deepEqual(Object.keys(rows[0]), SHEET_COLUMNS);
  assert.match(exportQuery().text, /q.submitted_by = \$1 AND \$2::text = 'teacher'/);
  const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'question_bank_exported');
  assert.equal(JSON.parse(audit.params[4]).rows, 13);
  log.length = 0;
  assert.equal((await exportAs('reviewer')).status, 200);
  const rq = exportQuery().text;
  assert.match(rq, /q.submitted_by <> \$1/); assert.match(rq, /reviewer_assignments ra WHERE ra.reviewer_id = \$1/); assert.match(rq, /user_scopes/);
  log.length = 0;
  assert.equal((await exportAs('hod', `?course_offering_id=${IDS.off}&status=active`)).status, 200);
  assert.match(exportQuery().text, /q.question_status <> 'DRAFT'/);
  assert.deepEqual(exportQuery().params.slice(0, 4), [USERS.hod.id, 'hod', IDS.off, 'ACTIVE']);
});

test('export: out-of-scope offerings, other roles and malformed filters are refused before any query', async () => {
  installWorld();
  sql(/LIMIT \$5/i, []);
  for (const [who, off] of [['hod', IDS.offA2], ['hod', IDS.offB], ['reviewer', IDS.offB], ['reviewerA2', IDS.off]]) {
    log.length = 0;
    assert.equal((await exportAs(who, `?course_offering_id=${off}`)).status, 403, `${who} ${off}`);
    assert.equal(exportQuery(), undefined);
  }
  for (const who of ['coe', 'admin', 'v1']) assert.equal((await exportAs(who)).status, 403, who);
  assert.equal((await exportAs('hod', '?course_offering_id=nope')).status, 400);
  assert.equal((await exportAs('hod', '?status=IN_REVIEW')).status, 400);
});

test('export -> bulk import round trip: all 13 types come back valid with the same normalised data', async () => {
  installWorld();
  sql(/LIMIT \$5/i, exportRows);
  const file = await exportAs('teacher');
  sql(/FROM teacher_course_assignments tca/i, [{ course_offering_id: IDS.off, section_id: null, subject_id: IDS.subj }]);
  sql(/SELECT syllabus_version_id FROM course_offerings/i, [{ syllabus_version_id: IDS.sv }]);
  sql(/FROM course_outcomes/i, [{ code: 'CO1' }, { code: 'CO2' }]);
  sql(/FROM syllabus_topics/i, [{ title: 'Trees' }]);
  sql(/SELECT id FROM questions WHERE course_offering_id = \$1 AND question_hash/i, []);
  sql(/INSERT INTO bulk_upload_batches/i, [{ id: 'batch1' }]);
  sql(/FROM questions WHERE course_offering_id = \$1 AND question_hash = \$2 AND id != \$3/i, []);
  sql(/embedding <=> \$4::vector/i, []);
  const fd = new FormData(); fd.append('file', new Blob([file.buf]), 'export.xlsx'); fd.append('course_offering_id', IDS.off);
  const r = await fetch(`http://localhost:${PORT()}/api/bulk-upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor('teacher')}` }, body: fd });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  assert.equal(data.valid_rows, 13, JSON.stringify(data.errors)); assert.equal(data.error_rows, 0);
  const payload = JSON.parse(log.find((l) => /INSERT INTO bulk_upload_batches/.test(l.text)).params[7]);
  const want = exportRows();
  payload.rows.forEach((row, i) => {
    const w = want[i];
    assert.equal(row.__type, w.question_type);
    assert.equal(row.__correct, w.correct_answer, `${w.question_type} key`);
    assert.deepEqual(row.__answer_data, w.answer_data, `${w.question_type} answer data`);
    assert.deepEqual(row.__options, { option_a: w.option_a, option_b: w.option_b, option_c: w.option_c, option_d: w.option_d }, `${w.question_type} options`);
    assert.deepEqual(row.__cos, ['CO1', 'CO2']); assert.equal(row.__bloom, 'apply');
  });
});

test('template: one example row per type (13), in the export columns; teachers only', async () => {
  const r = await fetch(`http://localhost:${PORT()}/api/bulk-upload/template`, { headers: { Authorization: `Bearer ${tokenFor('teacher')}` } });
  assert.equal(r.status, 200);
  const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Questions, { defval: '' });
  assert.deepEqual(rows.map((x) => x.question_type).sort(), [...QUESTION_TYPE_CODES].sort());
  assert.deepEqual(Object.keys(rows[0]), SHEET_COLUMNS);
  assert.equal((await call('GET', '/bulk-upload/template', null, 'hod')).status, 403);
});
