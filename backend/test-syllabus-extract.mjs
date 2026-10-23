// The in-app syllabus extraction (pdf-text-extract.js + syllabus-parse.js) and the demo dataset (demo-dataset.js),
// against the official 2023 CSE syllabus PDF in data/syllabus-2023. No database.
//   node --test test-syllabus-extract.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import PDFDocument from 'pdfkit';
import { extractPdfText, PdfError } from './src/pdf-text-extract.js';
import { parseSyllabusDocument, normalizeCode, topicsFromUnitText } from './src/syllabus-parse.js';
import { loadDemoDataset, datasetSummary, toQuestionFields, QUESTIONS_PER_SUBJECT } from './src/demo-dataset.js';
import { BLOOM_LEVELS, DIFFICULTIES } from './src/taxonomy.js';
import { QUESTION_TYPE_CODES } from './src/question-types.js';

const PDF = fs.readFileSync(new URL('./data/syllabus-2023/Syllabus-2023-New.pdf', import.meta.url));
const catalog = JSON.parse(fs.readFileSync(new URL('./data/syllabus-2023/catalog.json', import.meta.url)));
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
let parsed;
const courses = () => (parsed ||= parseSyllabusDocument(extractPdfText(PDF).text));

test('the official PDF: every page has text, and the in-app extraction reproduces the catalog for all 14 subjects', () => {
  const r = extractPdfText(PDF);
  assert.equal(r.pages, 316); assert.equal(r.pagesWithText, 316);
  assert.equal(catalog.subjects.length, 14);
  for (const s of catalog.subjects) {
    const c = courses().find((x) => x.code === s.code);
    assert.ok(c, `${s.code} found`);
    assert.equal(c.title, s.title, `${s.code} title`);
    assert.equal(c.semester, s.semester, `${s.code} semester`);
    assert.deepEqual(c.pages, s.pages, `${s.code} pages`);
    assert.deepEqual(c.course_outcomes.map((x) => [x.code, squash(x.text)]), s.course_outcomes.map((x) => [x.code, squash(x.text)]), `${s.code} COs verbatim`);
    assert.deepEqual(c.units.map((u) => [u.number, u.hours, squash(u.text)]), s.units.map((u) => [u.number, u.hours, squash(u.text)]), `${s.code} units`);
    // The parser's own consistency check: unit hours add up to the printed total.
    assert.equal(c.units.reduce((a, u) => a + u.hours, 0), c.total_hours, `${s.code} hours reconcile`);
  }
});

test('source irregularities are reported, not hidden: TCS 503 unit 3 has no "Unit 3" label in the PDF', () => {
  const c = courses().find((x) => x.code === 'TCS 503');
  assert.ok(c.warnings.some((w) => /Unit 3 has no "Unit 3" label/.test(w)));
  assert.equal(c.units[2].label_missing_in_source, true);
  for (const code of ['TCS 101', 'TCS 571', 'TCS 704']) assert.deepEqual(courses().find((x) => x.code === code).warnings, [], code);
});

test('COs are never copied between subjects: each subject has its own CO1..CO6 text', () => {
  const co1 = catalog.subjects.map((s) => s.course_outcomes[0].text);
  assert.equal(new Set(co1).size, co1.length);
});

test('codes, topics and helpers', () => {
  assert.equal(normalizeCode('TCS-503'), 'TCS 503'); assert.equal(normalizeCode('TCS503'), 'TCS 503'); assert.equal(normalizeCode('Total'), null);
  // "Heading: a, b" gives a topic with subtopics; an inner "Heading:" inside the comma list starts the next topic.
  const t = topicsFromUnitText('Functions: Function prototype, call by value, Storage classes: Automatic, Static; Arrays');
  assert.deepEqual(t.map((x) => x.title), ['Functions', 'Storage classes', 'Arrays']);
  assert.deepEqual(t[0].subtopics, ['Function prototype', 'call by value']);
  assert.deepEqual(t[1].subtopics, ['Automatic', 'Static']);
});

test('untrusted uploads: non-PDF, encrypted, decompression bomb and damaged files are refused with PdfError', () => {
  assert.throws(() => extractPdfText(Buffer.from('<html>not a pdf</html>')), PdfError);
  assert.throws(() => extractPdfText(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF')), /Encrypted/);
  const bomb = zlib.deflateSync(Buffer.alloc(40 * 1024 * 1024));
  const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`), bomb, Buffer.from('\nendstream\nendobj\n%%EOF')]);
  assert.doesNotThrow(() => extractPdfText(pdf)); // the oversized stream is skipped, not expanded
  assert.equal(extractPdfText(pdf).pagesWithText, 0);
  assert.throws(() => extractPdfText(Buffer.from('%PDF-1.4\ngarbage')), PdfError);
});

async function pdfkit(draw) {
  const out = new PassThrough(); const chunks = []; out.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => out.on('end', r));
  const doc = new PDFDocument({ size: 'A4' }); doc.pipe(out); draw(doc); doc.end(); await done;
  return Buffer.concat(chunks);
}

test('a scanned-style PDF (no text) yields no text; a generated text PDF is read line by line', async () => {
  const scanned = await pdfkit((d) => d.rect(50, 50, 400, 600).fill('#999999'));
  assert.equal(extractPdfText(scanned).pagesWithText, 0);
  const text = await pdfkit((d) => { d.text('Unit 1: Graphs and Trees', 50, 50); d.text('CO1: Model problems using graphs.', 50, 80); });
  const r = extractPdfText(text);
  assert.equal(r.pagesWithText, 1);
  assert.deepEqual(r.text.split('\n'), ['Unit 1: Graphs and Trees', 'CO1: Model problems using graphs.']);
});

test('demo dataset: exactly 14 theory subjects x 20 questions = 280, every reference valid, no errors', () => {
  const { subjects, errors } = loadDemoDataset();
  assert.deepEqual(errors, []);
  assert.equal(subjects.length, 14);
  assert.ok(subjects.every((s) => s.category === 'DC' || s.category === 'DE'), 'theory courses (no labs)');
  assert.ok(subjects.every((s) => !/lab/i.test(s.title)));
  const semesters = subjects.reduce((m, s) => ({ ...m, [s.semester]: (m[s.semester] || 0) + 1 }), {});
  assert.deepEqual(semesters, { 1: 1, 2: 1, 3: 3, 4: 3, 5: 2, 6: 2, 7: 2 }, 'Semesters I-VII only (VIII excluded); I and II have one theory course each in the source');
  const summary = datasetSummary(subjects);
  assert.equal(summary.questions, 280);
  for (const s of subjects) {
    assert.equal(s.questions.length, QUESTIONS_PER_SUBJECT, s.code);
    const cos = new Set(s.course_outcomes.map((c) => c.code));
    for (const q of s.questions) {
      assert.ok(q.cos.every((c) => cos.has(c)), `${q.key} COs belong to ${s.code}`);
      assert.ok(BLOOM_LEVELS.includes(q.bloom_level) && DIFFICULTIES.includes(q.difficulty) && QUESTION_TYPE_CODES.includes(q.question_type), q.key);
      assert.ok((s.topics[String(q.unit_number)] || []).includes(q.topic_title), `${q.key} topic belongs to its unit`);
    }
    for (const u of s.units) assert.ok(s.questions.some((q) => q.unit_number === u.number), `${s.code} unit ${u.number} covered`);
  }
  assert.ok(Object.keys(summary.by_bloom).length === 6, 'all six Bloom levels used');
  assert.deepEqual(subjects.find((s) => s.code === 'TCS 409').hod_flags.map((f) => f.co), ['CO3'], 'the one CO the syllabus units do not cover is flagged');
});

test('demo dataset: authoring records map onto the app\'s question fields (MCQ answer is the option text)', () => {
  const f = toQuestionFields({ type: 'mcq', q: 'Pick one option here', marks: 1, diff: 'easy', bloom: 'remember', opts: ['a', 'b', 'c', 'd'], ans: 'C', model: 'c is right' });
  assert.equal(f.correct_answer, 'c');
  assert.deepEqual(toQuestionFields({ type: 'numerical', q: 'x', marks: 1, diff: 'easy', bloom: 'apply', val: 3, tol: 0, unit: 'ms' }).answer_data, { expected_value: 3, tolerance: 0, unit: 'ms' });
});
