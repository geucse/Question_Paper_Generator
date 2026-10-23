// Phase 4a (no database): every question type in output and input.
//   node --test test-paper-output.mjs
// - PDF content per type (options, Assertion-Reason choices, case text before the question, code in monospace with
//   its indentation, embedded diagrams, the answer key in each type's normal form) for all 13 types;
// - server-side per-type normalisation (normalizeQuestionData);
// - the type-aware AI review prompt and fallback checks;
// - export -> spreadsheet -> import round trip for all 13 types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as XLSX from 'xlsx';
import { streamPaperPdf, answerKeyText } from './src/paper-pdf.js';
import { pdfText, pdfTextRuns } from './test/pdf-text.mjs';
import { QUESTION_TYPE_CODES, ASSERTION_REASON_OPTIONS, normalizeQuestionData, validateQuestionByType, answerDataFromRow } from './src/question-types.js';
import { reviewPrompt, heuristicReview, typeSpecificBlock } from './src/ai-review-content.js';
import { SHEET_COLUMNS, TEMPLATE_EXAMPLES, exportRow } from './src/question-export.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const NBSP = ' ';

// One complete question of every type, as a paper snapshot carries it.
const QS = {
  mcq: { question_text: 'Which bound does binary search achieve?', option_a: 'O(n)', option_b: 'O(log n)', option_c: 'O(n^2)', option_d: 'O(1)', correct_answer: 'O(log n)', model_answer: 'Halving' },
  true_false: { question_text: 'Every AVL tree is a binary search tree.', correct_answer: 'TRUE', model_answer: 'Balance does not change the order' },
  assertion_reason: { question_text: 'Assess the assertion about heaps.', correct_answer: 'B', model_answer: 'Both true, unrelated',
    answer_data: { assertion: 'A heap has logarithmic height', reason: 'Heaps are stored in arrays' } },
  numerical: { question_text: 'What is g at sea level?', answer_data: { expected_value: 9.8, tolerance: 0.1, unit: 'm/s^2' }, model_answer: 'Standard gravity' },
  fill_blank: { question_text: 'A stack is ___ and a queue is ___.', answer_data: { answers: ['LIFO', 'FIFO'] }, model_answer: 'Orders of removal' },
  short_answer: { question_text: 'Define the height of a tree.', model_answer: 'Longest root-to-leaf path in edges' },
  long_answer: { question_text: 'Compare merge sort and quicksort.', model_answer: 'Stable versus in place' },
  derivation: { question_text: 'Derive the merge sort recurrence.', model_answer: 'T(n) = 2T(n/2) + cn' },
  proof: { question_text: 'Prove a tree on n vertices has n - 1 edges.', model_answer: 'Induction on n' },
  programming: { question_text: 'Complete the function:\n```\ndef depth(node):\n    if node is None:\n        return 0\n```\nso that it returns the depth.',
    answer_data: { language: 'Python', constraints: 'Recursion allowed' }, model_answer: 'def depth(node):\n    if node is None:\n        return 0\n    return 1 + max(depth(node.left), depth(node.right))' },
  case_study: { question_text: 'Which index structure should the library use?', answer_data: { case_text: 'A library stores two million records and needs daily range queries.' }, model_answer: 'A B-tree' },
  diagram: { question_text: 'Label the parts of the tree in the diagram.', model_answer: 'Root, internal nodes, leaves',
    attachments: [{ id: 'att1', file_name: 'tree.png', file_type: 'image/png', available: true, printable: true, data: PNG }] },
  descriptive: { question_text: 'Describe hashing with chaining.', model_answer: 'Each bucket keeps a list' },
};
const questions = QUESTION_TYPE_CODES.map((type, i) => ({ question_type: type, marks: 2, slot_number: i + 1, ...QS[type] }));

async function render(qs, extra = {}) {
  const out = new PassThrough(); const headers = {}; out.setHeader = (k, v) => { headers[k] = v; };
  const chunks = []; out.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => out.on('end', r));
  streamPaperPdf(out, { paper: { title: 'types', paper_status: 'GENERATED' }, questions: qs, includeAnswers: true, ...extra });
  await done;
  const buf = Buffer.concat(chunks);
  return { buf, text: pdfText(buf), runs: pdfTextRuns(buf), headers };
}

test('PDF: every one of the 13 types prints its question and its answer-key line', async () => {
  const { text } = await render(questions);
  const key = text.slice(text.indexOf('Answer Key'));
  questions.forEach((q, i) => {
    const firstLine = q.question_text.split('\n')[0];
    assert.ok(text.includes(firstLine), `${q.question_type}: question text`);
    assert.ok(key.includes(`Q${i + 1}:`), `${q.question_type}: answer key entry`);
  });
  for (const t of ['Define the height', 'Compare merge sort', 'Derive the merge', 'Prove a tree', 'Describe hashing']) assert.ok(text.includes(t));
  for (const m of ['Longest root-to-leaf path in edges', 'Stable versus in place', 'T(n) = 2T(n/2) + cn', 'Induction on n', 'Each bucket keeps a list']) {
    assert.ok(key.includes(m), `model answer in the key: ${m}`);
  }
});

test('PDF: MCQ options and the key as "(B) option text", also when the answer is stored as a letter', async () => {
  const { text } = await render([questions[0]]);
  for (const o of ['(A) O(n)', '(B) O(log n)', '(C) O(n^2)', '(D) O(1)']) assert.ok(text.includes(o), o);
  assert.ok(text.slice(text.indexOf('Answer Key')).includes('Q1: (B) O(log n)'));
  assert.equal(answerKeyText({ ...questions[0], correct_answer: 'b' }), '(B) O(log n)');
  assert.equal(answerKeyText({ ...questions[0], correct_answer: 'not an option' }), 'not an option', 'never invents a letter');
});

test('PDF: True/False, Assertion-Reason (A, R and the four standard choices), Numerical, Fill in the Blank', async () => {
  const { text } = await render(['true_false', 'assertion_reason', 'numerical', 'fill_blank'].map((t) => questions.find((q) => q.question_type === t)));
  assert.ok(text.includes('(True / False)'));
  assert.ok(text.includes('Assertion (A): A heap has logarithmic height') && text.includes('Reason (R): Heaps are stored in arrays'));
  for (const [k, v] of Object.entries(ASSERTION_REASON_OPTIONS)) assert.ok(text.includes(`(${k}) ${v}`), k);
  assert.ok(text.includes('(Give the answer in m/s^2)'));
  const key = text.slice(text.indexOf('Answer Key'));
  assert.ok(key.includes('Q1: True'));
  assert.ok(key.includes(`Q2: (B) ${ASSERTION_REASON_OPTIONS.B}`));
  assert.ok(key.includes('Q3: 9.8 m/s^2 (± 0.1)'));
  assert.ok(key.includes('Q4: Blank 1: LIFO; Blank 2: FIFO'));
});

test('PDF: a case study prints its case text BEFORE the question', async () => {
  const { text } = await render([questions.find((q) => q.question_type === 'case_study')]);
  const iCase = text.indexOf('A library stores two million records'); const iQ = text.indexOf('Which index structure');
  assert.ok(iCase > 0 && iQ > iCase, text.slice(0, 400));
  assert.ok(text.indexOf('Case:') < iCase);
});

test('PDF: programming code in Courier with its indentation kept (question and reference solution)', async () => {
  const { buf, runs, text } = await render([questions.find((q) => q.question_type === 'programming')]);
  assert.match(buf.toString('latin1'), /\/BaseFont \/Courier/);
  assert.ok(runs.includes(`${NBSP.repeat(4)}if${NBSP}node${NBSP}is${NBSP}None:`), 'question code indentation kept');
  assert.ok(runs.includes(`${NBSP.repeat(8)}return${NBSP}0`), 'nested indentation kept');
  assert.ok(runs.includes(`${NBSP.repeat(4)}return${NBSP}1${NBSP}+${NBSP}max(depth(node.left),${NBSP}depth(node.right))`), 'reference solution indentation kept');
  assert.ok(text.includes('Complete the function:') && text.includes('so that it returns the depth.'), 'prose around the fenced block');
  assert.ok(text.includes('Language: Python | Constraints: Recursion allowed'));
  // A programming question without fences is code as a whole; tabs become four spaces.
  const plain = await render([{ question_type: 'programming', marks: 2, question_text: 'for i in range(3):\n\tprint(i)', answer_data: { language: 'Python' }, model_answer: 'x' }]);
  assert.ok(plain.runs.includes(`${NBSP.repeat(4)}print(i)`));
});

test('PDF: a diagram PNG is embedded; a WEBP is named; a missing file is reported, never silently dropped', async () => {
  const diagram = questions.find((q) => q.question_type === 'diagram');
  const withImage = await render([diagram]);
  assert.match(withImage.buf.toString('latin1'), /\/Subtype \/Image/);
  assert.equal(withImage.text.includes('Refer to the diagram'), false);
  const named = await render([{ ...diagram, attachments: [{ id: 'w', file_name: 'tree.webp', file_type: 'image/webp', available: true, printable: false, data: null }] }]);
  assert.doesNotMatch(named.buf.toString('latin1'), /\/Subtype \/Image/);
  assert.ok(named.text.includes('(Supplied separately: tree.webp)'));
  const gone = await render([{ ...diagram, attachments: [{ id: 'g', file_name: 'tree.png', file_type: 'image/png', available: false, printable: false, data: null }] }]);
  assert.ok(gone.text.includes('(Diagram not available: tree.png)'));
  const corrupt = await render([{ ...diagram, attachments: [{ id: 'c', file_name: 'bad.png', file_type: 'image/png', available: true, printable: true, data: Buffer.from('not a png') }] }]);
  assert.ok(corrupt.text.includes('(Supplied separately: bad.png)'), 'an undecodable image is named instead of failing the PDF');
  const legacy = await render([{ ...diagram, attachments: [] }]);
  assert.ok(legacy.text.includes('(Refer to the diagram supplied with this paper)'));
});

test('PDF: Content-Disposition is attachment by default and inline for preview / print', async () => {
  assert.match((await render([questions[5]])).headers['Content-Disposition'], /^attachment; filename="types\.pdf"$/);
  assert.match((await render([questions[5]], { inline: true })).headers['Content-Disposition'], /^inline; filename="types\.pdf"$/);
});

test('normalizeQuestionData: MCQ letter -> option text, keys upper-cased, unused fields dropped', () => {
  const mcq = normalizeQuestionData({ question_type: 'mcq', option_a: ' O(n) ', option_b: 'O(log n)', correct_answer: 'b', answer_data: { case_text: 'stale' } });
  assert.deepEqual(mcq, { question_type: 'mcq', option_a: 'O(n)', option_b: 'O(log n)', option_c: null, option_d: null, correct_answer: 'O(log n)', answer_data: {} });
  assert.equal(normalizeQuestionData({ question_type: 'true_false', correct_answer: ' true ', option_a: 'x' }).correct_answer, 'TRUE');
  assert.equal(normalizeQuestionData({ question_type: 'true_false', correct_answer: 'true', option_a: 'x' }).option_a, null);
  const ar = normalizeQuestionData({ question_type: 'assertion_reason', correct_answer: 'c', answer_data: { assertion: ' A ', reason: 'R', answers: ['x'] } });
  assert.deepEqual([ar.correct_answer, ar.answer_data], ['C', { assertion: 'A', reason: 'R' }]);
  const num = normalizeQuestionData({ question_type: 'numerical', correct_answer: 'x', answer_data: { expected_value: '8', tolerance: '', unit: ' m ', language: 'C' } });
  assert.deepEqual([num.correct_answer, num.answer_data], [null, { expected_value: 8, unit: 'm' }]);
  assert.equal(normalizeQuestionData({ question_type: 'numerical', answer_data: { expected_value: 'abc' } }).answer_data.expected_value, 'abc', 'kept for the validator to name');
  assert.deepEqual(normalizeQuestionData({ question_type: 'fill_blank', answer_data: { answers: 'LIFO | FIFO |' } }).answer_data, { answers: ['LIFO', 'FIFO'] });
  assert.deepEqual(normalizeQuestionData({ question_type: 'descriptive', correct_answer: 'A', option_a: 'x', answer_data: { language: 'C' } }),
    { question_type: 'descriptive', option_a: null, option_b: null, option_c: null, option_d: null, correct_answer: null, answer_data: {} });
  assert.equal(normalizeQuestionData({ question_type: 'essay' }), null);
  assert.equal(normalizeQuestionData({ question_type: 'mcq', answer_data: '{not json' }), null);
});

test('validateQuestionByType: a diagram needs a printable PNG/JPEG before ACTIVE when the caller knows the image count', () => {
  const d = { question_type: 'diagram', question_text: 'Label the tree', model_answer: 'roots and leaves' };
  assert.match(validateQuestionByType({ ...d, attachment_count: 0 }, { forActivation: true })[0], /attached diagram/);
  assert.match(validateQuestionByType({ ...d, attachment_count: 1, diagram_image_count: 0 }, { forActivation: true })[0], /PNG or JPEG/);
  assert.deepEqual(validateQuestionByType({ ...d, attachment_count: 1, diagram_image_count: 1 }, { forActivation: true }), []);
  assert.deepEqual(validateQuestionByType({ ...d, attachment_count: 1 }, { forActivation: true }), [], 'bulk preview: count unknown');
});

test('AI review: the prompt carries each type\'s data; fallback checks are type-aware', () => {
  const expect = {
    mcq: ['Options: A) O(n) B) O(log n)', 'Marked correct answer: O(log n)'], true_false: ['Marked correct answer: TRUE'],
    assertion_reason: ['Assertion (A): A heap has logarithmic height', 'Reason (R): Heaps are stored in arrays', `Marked correct choice: (B) ${ASSERTION_REASON_OPTIONS.B}`],
    numerical: ['Expected numeric answer: 9.8 m/s^2 (tolerance ± 0.1)'], fill_blank: ['1) LIFO 2) FIFO'],
    programming: ['Language: Python', 'Constraints: Recursion allowed', 'Reference solution:'], case_study: ['A library stores two million records'],
    diagram: ['attached diagram'], short_answer: ['Model answer / solution: Longest root-to-leaf path in edges'],
  };
  for (const q of questions) {
    const p = reviewPrompt(q);
    assert.ok(p.includes(q.question_text), q.question_type);
    assert.match(p, /Question type: /);
    for (const s of expect[q.question_type] || []) assert.ok(p.includes(s), `${q.question_type}: ${s}\n${typeSpecificBlock(q)}`);
  }
  const kinds = (q) => heuristicReview(q).map((i) => `${i.type}:${i.detail}`).join(' | ');
  assert.match(kinds({ ...questions[0], option_c: 'O(log n)' }), /duplicate_options/);
  assert.match(kinds({ question_type: 'numerical', question_text: 'How far does the train travel in an hour?', answer_data: { expected_value: 60 }, model_answer: 'speed times time' }), /no unit/);
  assert.match(kinds({ question_type: 'fill_blank', question_text: 'LIFO means ___ in, first out.', answer_data: { answers: ['LIFO'] }, model_answer: 'last in' }), /already appears/);
  assert.match(kinds({ question_type: 'assertion_reason', question_text: 'Assess the assertion and the reason.', correct_answer: 'A', model_answer: 'same text',
    answer_data: { assertion: 'Same', reason: 'same' } }), /same statement/);
  assert.match(kinds({ question_type: 'programming', question_text: 'Write a function that sorts a list.', model_answer: 'def s(x): return sorted(x)', answer_data: {} }), /incomplete:Programming needs answer_data.language/);
  assert.match(kinds({ question_type: 'diagram', question_text: 'Label the parts of this tree diagram.', model_answer: 'root and leaves', attachment_count: 1, diagram_image_count: 0 }), /PNG or JPEG/);
  assert.equal(heuristicReview({ question_type: 'programming', question_text: 'def f():\n    return  1  # spaces kept', answer_data: { language: 'Python' }, model_answer: 'def f(): return 1' })
    .some((i) => i.type === 'formatting'), false, 'code spacing is not a formatting problem');
});

test('export -> spreadsheet -> import round trip keeps every type\'s data (all 13 types)', () => {
  const stored = questions.map((q) => ({ ...q, ...normalizeQuestionData(q), difficulty: 'easy', topic: 'Trees', subtopic: '', bloom: 'apply', cos: ['CO1', 'CO2'] }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stored.map(exportRow), { header: SHEET_COLUMNS }), 'Questions');
  const back = XLSX.utils.sheet_to_json(XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }).Sheets.Questions, { defval: '', raw: true });
  assert.equal(back.length, 13);
  assert.deepEqual(Object.keys(back[0]), SHEET_COLUMNS, 'the import template columns, in order');
  back.forEach((row, i) => {
    const want = stored[i];
    const got = normalizeQuestionData({ ...row, answer_data: answerDataFromRow(row) });
    assert.deepEqual(got, normalizeQuestionData(want), want.question_type);
    assert.equal(row.question_text, want.question_text);
    assert.equal(row.model_answer, want.model_answer || '');
    assert.equal(row.co, 'CO1, CO2'); assert.equal(row.bloom_level, 'apply'); assert.equal(Number(row.marks), 2);
    assert.deepEqual(validateQuestionByType({ ...row, answer_data: answerDataFromRow(row) }), [], `${want.question_type} re-imports valid`);
  });
});

test('template: one valid example row for each of the 13 types, in the export columns', () => {
  assert.deepEqual(TEMPLATE_EXAMPLES.map((r) => r.question_type).sort(), [...QUESTION_TYPE_CODES].sort());
  for (const r of TEMPLATE_EXAMPLES) {
    assert.ok(Object.keys(r).every((k) => SHEET_COLUMNS.includes(k)), r.question_type);
    assert.deepEqual(validateQuestionByType({ ...r, answer_data: answerDataFromRow(r) }, { forActivation: true, requireAssets: false }), [], r.question_type);
  }
});
