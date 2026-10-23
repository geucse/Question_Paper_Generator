// The bulk import spreadsheet layout (routes/bulk.js), shared by the template and the question-bank export, so an
// exported file can be edited and imported again (spec §34 "import/export where supported"). Type-specific data
// travels as plain columns (question-types.js answerDataFromRow reads them back).
import { parseAnswerData } from './question-types.js';

export const SHEET_COLUMNS = ['question_type', 'question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_answer', 'model_answer',
  'difficulty', 'bloom_level', 'co', 'topic', 'subtopic', 'marks',
  'expected_value', 'tolerance', 'unit', 'language', 'constraints', 'case_text', 'assertion', 'reason', 'answers'];

const blank = (v) => (v == null ? '' : v);

// q: a question row plus `bloom` (the level to export) and `cos` (course outcome codes, primary first).
export function exportRow(q) {
  const d = parseAnswerData(q.answer_data) || {};
  return {
    question_type: q.question_type, question_text: q.question_text,
    option_a: blank(q.option_a), option_b: blank(q.option_b), option_c: blank(q.option_c), option_d: blank(q.option_d),
    correct_answer: blank(q.correct_answer), model_answer: blank(q.model_answer),
    difficulty: blank(q.difficulty), bloom_level: blank(q.bloom), co: (q.cos || []).join(', '), topic: blank(q.topic), subtopic: blank(q.subtopic),
    marks: blank(q.marks),
    expected_value: blank(d.expected_value), tolerance: blank(d.tolerance), unit: blank(d.unit), language: blank(d.language),
    constraints: blank(d.constraints), case_text: blank(d.case_text), assertion: blank(d.assertion), reason: blank(d.reason),
    answers: Array.isArray(d.answers) ? d.answers.join(' | ') : '',
  };
}

// One worked example per type for the template (spec §8).
const base = { difficulty: 'easy', bloom_level: 'remember', co: 'CO1', topic: 'Algorithms', subtopic: '', marks: 2 };
export const TEMPLATE_EXAMPLES = [
  { question_type: 'mcq', question_text: 'What is the time complexity of binary search?',
    option_a: 'O(n)', option_b: 'O(log n)', option_c: 'O(n^2)', option_d: 'O(1)', correct_answer: 'O(log n)', model_answer: 'Binary search halves the search space each step' },
  { question_type: 'true_false', question_text: 'Every binary search tree is a heap.', correct_answer: 'FALSE', model_answer: 'A BST orders keys left to right, a heap top to bottom' },
  { question_type: 'assertion_reason', question_text: 'Read the assertion and the reason, then choose the correct option.',
    assertion: 'Quicksort runs in O(n log n) time on average', reason: 'Random pivots split the input into balanced parts on average', correct_answer: 'A',
    model_answer: 'Both are true and the balanced expected split explains the average bound', bloom_level: 'understand' },
  { question_type: 'numerical', question_text: 'How many comparisons does binary search need for 1024 sorted items in the worst case?',
    expected_value: 11, tolerance: 0, model_answer: 'log2(1024) + 1 = 11', bloom_level: 'apply' },
  { question_type: 'fill_blank', question_text: 'A stack follows the ___ principle and a queue the ___ principle.', answers: 'LIFO | FIFO', model_answer: 'Last in first out; first in first out' },
  { question_type: 'short_answer', question_text: 'Define the height of a rooted tree.', model_answer: 'The number of edges on the longest root-to-leaf path' },
  { question_type: 'long_answer', question_text: 'Compare merge sort and quicksort in time, space and stability.', model_answer: 'Merge sort: O(n log n) always, O(n) space, stable; quicksort: O(n log n) average, in place, not stable', marks: 10, bloom_level: 'analyze' },
  { question_type: 'derivation', question_text: 'Derive the recurrence for the running time of merge sort and solve it.', model_answer: 'T(n) = 2T(n/2) + cn gives T(n) = O(n log n)', marks: 5, bloom_level: 'apply' },
  { question_type: 'proof', question_text: 'Prove that a tree with n vertices has n - 1 edges.', model_answer: 'By induction on n: removing a leaf removes one vertex and one edge', marks: 5, bloom_level: 'evaluate' },
  { question_type: 'programming', question_text: 'Write a function that returns the reverse of a singly linked list.', language: 'Python', constraints: 'O(n) time, O(1) extra space',
    model_answer: 'def reverse(head):\n    prev = None\n    while head:\n        head.next, prev, head = prev, head, head.next\n    return prev', marks: 5, bloom_level: 'create' },
  { question_type: 'case_study', question_text: 'Which data structure should the library use for its catalogue, and why?',
    case_text: 'A library stores two million book records and must answer range queries by publication year every day.',
    model_answer: 'A B-tree indexed by year: logarithmic search and efficient range scans on disk', marks: 5, bloom_level: 'evaluate' },
  { question_type: 'diagram', question_text: 'Label the root, internal nodes and leaves of the binary search tree shown in the diagram.',
    model_answer: 'Root at top; internal nodes have children; leaves have none', bloom_level: 'understand' },
  { question_type: 'descriptive', question_text: 'Describe how a hash table resolves collisions with chaining.', model_answer: 'Each bucket holds a list; colliding keys are appended to it', marks: 4, bloom_level: 'understand' },
].map((x) => ({ ...base, ...x }));
