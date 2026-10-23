// The institution's formal paper template (paper-pdf.js), no database: metadata from the paper, OR alternatives,
// the CO column, numbering, derived instructions, pagination (one page, many pages, a question longer than a page),
// Unicode / maths, missing metadata, the approved-logo slot and sanitising of untrusted text.
//   node --test test-paper-template.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { streamPaperPdf, paperDistribution, paperLayout, printLabels, generalInstructions, examHeading, toRoman, cleanText, printConfig } from './src/paper-pdf.js';
import { paperSectionsView } from './src/paper-sections.js';
import { pdfText, pdfPages, pdfTextRuns } from './test/pdf-text.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const squash = (s) => s.replace(/\s+/g, '');

async function render(args) {
  const out = new PassThrough(); out.setHeader = () => {};
  const chunks = []; out.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => out.on('end', r));
  streamPaperPdf(out, { includeAnswers: false, sections: [], ...args });
  await done;
  return Buffer.concat(chunks);
}

// Five "attempt any 1 of 2" sections of 10 marks each: the shape of the institution's sample paper.
function orPaper({ cos = true, text = (i) => `Question ${i + 1}: explain topic ${i + 1} with an example.` } = {}) {
  const questions = [...Array(10)].map((_, i) => ({ question_id: `q${i}`, slot_number: i + 1, question_type: 'long_answer', marks: 10,
    section_name: `S${Math.floor(i / 2) + 1}`, question_text: text(i), model_answer: `answer ${i}`, ...(cos ? { cos: [`CO${(i % 3) + 1}`] } : {}) }));
  const fc = { sections: [1, 2, 3, 4, 5].map((n, i) => ({ name: `S${n}`, index: i, question_count: 2, mpq: 10, attempt: 1 })) };
  return { questions, sections: paperSectionsView(fc, questions) };
}
const META = { title: 'mid_term paper v1', paper_status: 'PRINT_READY', exam_type: 'mid_term', exam_date: '2026-09-22', program_name: 'B.Tech',
  course_title: 'Big Data Visualization', subject_code: 'TCS571', semester: 5, duration_minutes: 90, academic_session_label: '2026-27', campus_name: 'Main Campus' };

test('one-page OR paper: dynamic heading and metadata, Q1 (a) OR (b) ... Q5, marks and CO columns, Page 1 of 1', async () => {
  const { questions, sections } = orPaper();
  const buf = await render({ paper: META, questions, sections });
  const { pageCount, texts } = pdfPages(buf);
  assert.equal(pageCount, 1);
  const t = texts[0];
  for (const s of ['Roll No. :', 'MID SEMESTER EXAMINATION SEPT. 2026', 'Name of the Program: B.Tech', 'Name of the Course: Big Data Visualization',
    'Semester: V', 'Course Code: TCS571', 'Time: 90 Minutes', 'Maximum Marks: 50', 'Academic Session: 2026-27', 'Date: 22.09.2026', 'Main Campus',
    'Q. No. Question Marks CO', 'Page 1 of 1']) assert.ok(t.includes(s), `missing: ${s}`);
  assert.equal(t.slice(t.indexOf('Q. No.')).match(/\bOR\b/g).length, 5, 'one OR between the two alternatives of each question');
  for (const n of [1, 2, 3, 4, 5]) assert.ok(t.includes(`Q${n} Attempt any one of the 2 alternatives. 10`), `Q${n} header row`);
  assert.ok(t.includes('(a) Question 1: explain topic 1 with an example. CO1') && t.includes('(b) Question 2: explain topic 2 with an example. CO2'));
  assert.ok(t.includes('Answer all the questions, choosing any one of the alternatives separated by OR in each question.'));
  assert.ok(t.includes('Each question carries 10 marks.'));
  assert.equal(t.includes('S1'), false, 'section headings are not printed when every section is an OR choice');
  assert.equal(t.includes('DRAFT'), false, 'a PRINT_READY paper has no watermark');
});

test('nothing course-specific is hard-coded: other metadata prints other values', async () => {
  const { questions, sections } = orPaper();
  const t = pdfText(await render({ paper: { ...META, exam_type: 'end_term', exam_date: '2027-05-03', program_name: 'M.Tech', course_title: 'Compilers',
    subject_code: 'CS7001', semester: 2, duration_minutes: 180, academic_session_label: '2026-27' }, questions, sections }));
  for (const s of ['END SEMESTER EXAMINATION MAY 2027', 'M.Tech', 'Compilers', 'CS7001', 'Semester: II', 'Time: 180 Minutes', 'Date: 03.05.2027']) assert.ok(t.includes(s), s);
  for (const s of ['TCS571', 'Big Data', 'MID SEMESTER', 'SEPT', 'Semester: V ']) assert.equal(t.includes(s), false, s);
  assert.equal(examHeading({ exam_type: 'quiz', academic_session_label: '2025-26' }), 'QUIZ 2025-26', 'no date: the session is shown');
  assert.equal(examHeading({ title: 'legacy paper' }), 'legacy paper');
  assert.deepEqual([1, 4, 5, 9, 12].map(toRoman), ['I', 'IV', 'V', 'IX', 'XII']);
});

test('missing optional metadata: placeholders, not invented values; no CO column without recorded CO codes', async () => {
  const { questions, sections } = orPaper({ cos: false });
  const t = pdfText(await render({ paper: { title: 'end_term paper v2', paper_status: 'GENERATED' }, questions, sections }));
  assert.ok(t.includes('end_term paper v2') && t.includes('Name of the Program: —') && t.includes('Course Code: —') && t.includes('Time: _______________'));
  assert.ok(t.includes('Q. No. Question Marks') && !t.includes('Marks CO'), 'the CO column is left out when the paper recorded no CO codes');
  assert.equal(t.includes('Academic Session'), false);
  assert.ok(t.includes('DRAFT'));
});

test('multi-page paper: Page X of Y on every page, the column header repeated, no blank page', async () => {
  const questions = [...Array(45)].map((_, i) => ({ question_id: `m${i}`, slot_number: i + 1, question_type: 'short_answer', marks: 2,
    question_text: `Multi-page question number ${i + 1}. ${'Explain the idea in your own words. '.repeat(3)}`, model_answer: 'x' }));
  const { pageCount, texts } = pdfPages(await render({ paper: { ...META, paper_status: 'PRINT_READY' }, questions }));
  assert.ok(pageCount >= 3, `pages: ${pageCount}`);
  assert.equal(texts.length, pageCount);
  texts.forEach((t, i) => {
    assert.ok(t.includes(`Page ${i + 1} of ${pageCount}`), `page ${i + 1} footer`);
    assert.ok(t.includes('Q. No. Question Marks'), `page ${i + 1} column header`);
    assert.ok(t.replace(/Page \d+ of \d+/, '').trim().length > 40, `page ${i + 1} is not blank`);
  });
  const all = texts.join(' ');
  for (let i = 1; i <= 45; i++) assert.ok(all.includes(`Q${i}. Multi-page question number ${i}.`), `Q${i}`);
});

test('a question longer than a page is split across pages without losing any line; the answer key starts on its own page', async () => {
  const long = [...Array(260)].map((_, i) => `Sentence ${i + 1} of the long case.`).join(' ');
  const questions = [{ question_id: 'l', slot_number: 1, question_type: 'long_answer', marks: 937, question_text: long, model_answer: 'key text' },
    { question_id: 'm', slot_number: 2, question_type: 'short_answer', marks: 5, question_text: 'After the long one.', model_answer: 'k2' }];
  const buf = await render({ paper: { ...META, paper_status: 'VALIDATED' }, questions, includeAnswers: true });
  const { pageCount, texts } = pdfPages(buf);
  // The question's own text in drawing order, without the page furniture a page break puts in the middle of it.
  const furniture = (r) => ['Q1.', '937', 'Q. No.', 'Question', 'Marks'].includes(r) || /^Page \d+ of \d+$/.test(r) || /DRAFT|DISTRIBUTION|^NOT FOR/.test(r);
  const body = pdfTextRuns(buf).map((r) => r.trim()).filter((r) => r && !furniture(r)).join(' ').replace(/\s+/g, ' ');
  for (let i = 1; i <= 260; i++) assert.ok(body.includes(`Sentence ${i} of the long case.`), `sentence ${i} printed`);
  assert.ok(pageCount >= 3);
  assert.ok(texts.findIndex((t) => t.includes('Sentence 260 ')) > texts.findIndex((t) => t.includes('Sentence 1 ')), 'continues on a later page');
  const key = texts.findIndex((t) => t.includes('Answer Key'));
  assert.equal(key, pageCount - 1); assert.equal(texts[key].includes('Sentence'), false, 'the key has its own page');
  assert.ok(texts[key].includes('Q1: key text') && texts[key].includes('Q2: k2'));
  texts.forEach((t) => assert.ok(t.includes('DRAFT')));
});

test('Unicode and mathematical notation are drawn with the embedded font (selectable text), not dropped or garbled', async () => {
  const q = 'Show ∑ᵢ αᵢxᵢ² ≤ ‖x‖·√n for x ∈ ℝⁿ, with π ≈ 3.14, ∞, ∂f/∂x, θ ≥ 0, a² + b² and Ωμλ. Résumé naïve café — ±5 °C.';
  const buf = await render({ paper: META, questions: [{ question_id: 'u', slot_number: 1, question_type: 'derivation', marks: 4, question_text: q, model_answer: '∫₀¹ x² dx = ⅓' }], includeAnswers: true });
  const t = pdfText(buf);
  assert.ok(squash(t).includes(squash(q)), t.slice(t.indexOf('Show'), t.indexOf('Show') + 200));
  assert.ok(squash(t).includes(squash('Q1: ∫₀¹ x² dx = ⅓')));
  assert.equal(t.includes('\uFFFD'), false);
  assert.match(buf.toString('latin1'), /\/BaseFont \/[A-Z]{6}\+DejaVuSerif/, 'fallback font embedded (subset)');
  assert.match(buf.toString('latin1'), /\/BaseFont \/Times-Roman/, 'Latin text stays in Times');
});

test('untrusted text: control, zero-width and bidi-override characters are removed', async () => {
  assert.equal(cleanText('a\u202Eb\u200Bc\u0007d\te'), 'abcd e');
  assert.equal(cleanText('x\ty', { code: true }), 'x\ty');
  const t = pdfText(await render({ paper: META, questions: [{ question_id: 'x', slot_number: 1, question_type: 'short_answer', marks: 1, question_text: 'Safe\u202Etxet\u200B text', model_answer: 'm' }] }));
  assert.ok(t.includes('Safetxet text'));
});

test('the approved logo is embedded only when a PNG/JPEG is configured; otherwise nothing is drawn in its place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-'));
  const png = path.join(dir, 'logo.png'); fs.writeFileSync(png, PNG);
  const svg = path.join(dir, 'logo.svg'); fs.writeFileSync(svg, '<svg/>');
  const q = [{ question_id: 'x', slot_number: 1, question_type: 'short_answer', marks: 1, question_text: 'Q', model_answer: 'm' }];
  const prev = process.env.INSTITUTION_LOGO_PATH;
  try {
    process.env.INSTITUTION_LOGO_PATH = png;
    assert.equal(printConfig().logoPath, png);
    assert.match((await render({ paper: META, questions: q })).toString('latin1'), /\/Subtype \/Image/);
    process.env.INSTITUTION_LOGO_PATH = svg; assert.equal(printConfig().logoPath, null, 'only PNG/JPEG can be embedded');
    process.env.INSTITUTION_LOGO_PATH = path.join(dir, 'missing.png'); assert.equal(printConfig().logoPath, null);
    assert.doesNotMatch((await render({ paper: META, questions: q })).toString('latin1'), /\/Subtype \/Image/);
  } finally { if (prev === undefined) delete process.env.INSTITUTION_LOGO_PATH; else process.env.INSTITUTION_LOGO_PATH = prev; }
  assert.equal(printConfig({ INSTITUTION_NAME: '  ' }).institution, 'Institution Name Not Configured');
  assert.deepEqual(printConfig({ PAPER_GENERAL_INSTRUCTIONS: 'Use of calculators is not permitted. | Write legibly.\n' }).instructions,
    ['Use of calculators is not permitted.', 'Write legibly.']);
});

test('numbering: OR groups get one number with (a)/(b); a mixed paper keeps its section headings and numbers on', () => {
  const qs = [
    { question_id: 'a', section_name: 'Part A', marks: 2 }, { question_id: 'b', section_name: 'Part A', marks: 2 },
    { question_id: 'c', section_name: 'Part B', marks: 6 }, { question_id: 'd', section_name: 'Part B', marks: 6 }, { question_id: 'e', section_name: 'Part B', marks: 6 },
    { question_id: 'f', section_name: 'Part C', marks: 5 }, { question_id: 'g', section_name: 'Part C', marks: 5 }, { question_id: 'h', section_name: 'Part C', marks: 5 },
  ];
  const fc = { sections: [{ name: 'Part A', index: 0, question_count: 2, mpq: 2 }, { name: 'Part B', index: 1, question_count: 3, mpq: 6, attempt: 1 },
    { name: 'Part C', index: 2, question_count: 3, mpq: 5, attempt: 2 }] };
  const sections = paperSectionsView(fc, qs);
  const labels = printLabels(qs, sections);
  assert.deepEqual([...labels.values()], ['Q1', 'Q2', 'Q3(a)', 'Q3(b)', 'Q3(c)', 'Q4', 'Q5', 'Q6']);
  const layout = paperLayout(qs, sections);
  assert.equal(layout.allOr, false);
  assert.deepEqual(layout.units.filter((u) => u.kind === 'heading').map((u) => u.text.split('  ')[0]), ['Part A', 'Part B', 'Part C']);
  const notes = generalInstructions({}, layout, sections, ['Configured line.']);
  assert.equal(notes[0], 'Answer the questions as directed under each heading. Where alternatives are separated by OR, answer any one of them.');
  assert.equal(notes[1], 'The marks for each question are shown in the Marks column.');
  assert.equal(notes.at(-1), 'Configured line.');
  assert.deepEqual(generalInstructions({}, paperLayout([{ id: 'x', marks: 3 }], []), []), ['Answer all the questions.'], 'a one-question paper: no invented marks rule');
});

test('internal copy: a paper analysis page gives the distribution by CO, Bloom level, unit and difficulty; the candidate copy has none', async () => {
  const qs = [
    { question_id: 'a', slot_number: 1, question_type: 'short_answer', marks: 4, question_text: 'Explain hashing.', model_answer: 'm', cos: ['CO1'], bloom_level: 'understand', difficulty: 'easy', unit: { code: 'U1', title: 'Unit 1: Hashing' } },
    { question_id: 'b', slot_number: 2, question_type: 'long_answer', marks: 10, question_text: 'Design an index.', model_answer: 'm', cos: ['CO2', 'CO3'], bloom_level: 'create', difficulty: 'hard', unit: { code: 'U2', title: 'Unit 2: Indexing' } },
  ];
  const d = paperDistribution(qs);
  assert.deepEqual(d.co.map((r) => [r.key, r.questions, r.marks]), [['CO1', 1, 4], ['CO2', 1, 10], ['CO3', 1, 10]]);
  assert.equal(d.multi_co, 1);
  const internal = pdfPages(await render({ paper: { ...META, paper_status: 'VALIDATED' }, questions: qs, includeAnswers: true }));
  const page = internal.texts.find((t) => t.includes('Paper Analysis (Internal Use Only)'));
  assert.ok(page, 'analysis page present');
  for (const s of ['Course outcomes Questions Marks', 'CO1 1 4', 'CO2 1 10', 'CO3 1 10', "Bloom's taxonomy level", 'Understand 1 4', 'Create 1 10',
    'Unit 1: Hashing 1 4', 'Unit 2: Indexing 1 10', 'Easy 1 4', 'Hard 1 10', 'counted under each of their COs']) assert.ok(page.includes(s), s);
  assert.ok(internal.texts.findIndex((t) => t.includes('Paper Analysis')) < internal.texts.findIndex((t) => t.includes('Answer Key')), 'analysis before the key');
  const candidate = pdfText(await render({ paper: META, questions: qs, includeAnswers: false }));
  assert.equal(candidate.includes('Paper Analysis'), false); assert.equal(candidate.includes('Create'), false);
});
