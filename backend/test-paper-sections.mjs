// Sections in output (no database): the frozen section rules -> preview view and PDF text.
//   node --test test-paper-sections.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { paperSectionRules, paperSectionsView, paperCountedMarks } from './src/paper-sections.js';
import { streamPaperPdf } from './src/paper-pdf.js';
import { pdfText, pdfPages } from './test/pdf-text.mjs';

const RULES = [
  { name: 'Section A', index: 0, instructions: 'Answer all questions briefly.', question_count: 2, types: ['short_answer'], mpq: 2, total: null, diff: null, attempt: null },
  { name: 'Section B', index: 1, instructions: 'Draw diagrams where they help.', question_count: 3, types: ['long_answer'], mpq: 5, total: 10, diff: { easy: 0, medium: 1, hard: 2 }, attempt: 2 },
];
const FC = JSON.stringify({ easy: 2, medium: 1, hard: 2, sections: RULES });
const Q = (slot, section_name, marks, question_type, difficulty, text = `Question text ${slot}`) =>
  ({ slot_number: slot, section_name, marks, question_type, difficulty, question_text: text, model_answer: 'm' });
const QS = [Q(1, 'Section A', 2, 'short_answer', 'easy'), Q(2, 'Section A', 2, 'short_answer', 'easy'),
  Q(3, 'Section B', 5, 'long_answer', 'medium'), Q(4, 'Section B', 5, 'long_answer', 'hard'), Q(5, 'Section B', 5, 'long_answer', 'hard')];

test('format_config: TEXT or object; invalid JSON and pre-037 shapes give no rules', () => {
  assert.equal(paperSectionRules(FC).length, 2);
  assert.equal(paperSectionRules(JSON.parse(FC)).length, 2);
  assert.deepEqual(paperSectionRules('{not json'), []);
  assert.deepEqual(paperSectionRules(JSON.stringify({ easy: 2, medium: 1, hard: 1 })), []);
  assert.deepEqual(paperSectionRules(null), []);
});

test('view: headings, instruction lines (choice rule first), counted marks and a real per-section check', () => {
  const [a, b] = paperSectionsView(FC, QS);
  assert.equal(a.heading, 'Section A  (2 questions, 4 marks)'); assert.deepEqual(a.instruction_lines, ['Answer all questions briefly.']);
  assert.equal(b.heading, 'Section B  (Attempt any 2 of 3 questions, 10 marks)');
  assert.deepEqual(b.instruction_lines, ['Attempt any 2 of the 3 questions in this section. Each question carries 5 marks.', 'Draw diagrams where they help.']);
  assert.equal(b.printed_marks, 15); assert.equal(b.marks_counted, 10); assert.deepEqual(b.allowed_types, ['long_answer']);
  assert.ok(a.check.passed && b.check.passed, JSON.stringify([a.check, b.check]));
  assert.equal(paperCountedMarks([a, b], QS), 14);
});

test('a tampered snapshot fails the check with errors naming the section and slot', () => {
  const bad = [QS[0], { ...QS[1], question_type: 'mcq' }, { ...QS[2], marks: 4 }, QS[3]];
  const [a, b] = paperSectionsView(FC, bad);
  assert.equal(a.check.passed, false); assert.match(a.check.errors.join(' '), /Section A: slot 2 type mcq not allowed/);
  assert.equal(b.check.passed, false);
  assert.match(b.check.errors.join(' '), /Section B: expected 3 question\(s\), got 2/);
  assert.match(b.check.errors.join(' '), /slot 3 has 4 marks, section requires 5/);
  assert.match(b.check.errors.join(' '), /needs more than 2 question\(s\) in the section, got 2/);
});

test('a section without a recorded rule is shown with check = null, never a made-up pass', () => {
  const view = paperSectionsView(JSON.stringify({ easy: 1 }), [Q(1, 'Old section', 3, 'descriptive', 'easy')]);
  assert.equal(view.length, 1); assert.equal(view[0].check, null); assert.equal(view[0].heading, 'Old section  (1 question, 3 marks)');
});

async function renderPdfBuffer(args) {
  const out = new PassThrough(); out.setHeader = () => {};
  const chunks = []; out.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => out.on('end', r));
  streamPaperPdf(out, args);
  await done;
  return Buffer.concat(chunks);
}
const renderPdf = async (args) => pdfText(await renderPdfBuffer(args));

test('PDF: section headings in order, the choice rule and instructions, counted maximum marks, DRAFT banner', async () => {
  const sections = paperSectionsView(FC, QS);
  const text = await renderPdf({ paper: { title: 'end_term paper v1', paper_status: 'GENERATED', duration_minutes: 90 }, questions: QS, sections, includeAnswers: false });
  const iA = text.indexOf('Section A (2 questions, 4 marks)'); const iB = text.indexOf('Section B (Attempt any 2 of 3 questions, 10 marks)');
  assert.ok(iA >= 0 && iB > iA, text.slice(0, 500));
  assert.ok(text.indexOf('Attempt any 2 of the 3 questions in this section. Each question carries 5 marks.') > iB);
  assert.ok(text.includes('Answer all questions briefly.') && text.includes('Draw diagrams where they help.'));
  assert.ok(text.includes('Maximum Marks: 14'));
  assert.ok(text.indexOf('Q3.') > iB, 'Q3 under the B heading');
  assert.ok(text.includes('DRAFT'));
});

test('PDF: a legacy call without sections still renders; maximum marks = sum of question marks', async () => {
  const text = await renderPdf({ paper: { title: 'legacy', status: 'locked' }, questions: [Q(1, null, 3, 'descriptive', 'easy'), Q(2, null, 4, 'descriptive', 'easy')], includeAnswers: false });
  assert.ok(text.includes('Maximum Marks: 7')); assert.equal(text.includes('Section'), false); assert.equal(text.includes('DRAFT'), false);
});

test('PDF: every page of a non-final paper carries the DRAFT banner (answer-key and overflow pages too); a final paper none', async () => {
  // 40 long questions overflow onto pages PDFKit adds itself; the answer key starts on its own page.
  const long = 'A very long question text that wraps over several lines of the printed page. '.repeat(12);
  const many = [...Array(40)].map((_, i) => Q(i + 1, null, 2, 'descriptive', 'easy', `${long} (${i + 1})`));
  for (const status of ['VALIDATION_PENDING', 'VALIDATED']) {
    const { pageCount, texts } = pdfPages(await renderPdfBuffer({ paper: { title: 'draft', paper_status: status }, questions: many, includeAnswers: true }));
    assert.ok(pageCount >= 6, `many pages expected, got ${pageCount}`);
    assert.equal(texts.length, pageCount, 'one content stream with text per page');
    texts.forEach((t, i) => assert.ok(t.includes('DRAFT'), `${status}: page ${i + 1} of ${pageCount} has no DRAFT banner`));
    assert.ok(texts.some((t) => t.includes('Answer Key')) && texts.filter((t) => t.includes('DRAFT')).length === pageCount);
  }
  for (const paper of [{ title: 'final', paper_status: 'PRINT_READY' }, { title: 'archived print', paper_status: 'ARCHIVED', locked_at: new Date() }]) {
    const { texts } = pdfPages(await renderPdfBuffer({ paper, questions: many, includeAnswers: true }));
    assert.equal(texts.some((t) => t.includes('DRAFT')), false, paper.paper_status);
  }
});
