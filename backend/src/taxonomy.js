// The single definition of the revised Bloom's taxonomy and of question difficulty used across the backend
// (the database CHECK constraints use the same lower-case values). frontend/src/lib/taxonomy.js mirrors it.
export const BLOOM = [
  { level: 'remember', label: 'Remember', order: 1, meaning: 'Retrieve facts and definitions' },
  { level: 'understand', label: 'Understand', order: 2, meaning: 'Explain, summarise, interpret, classify' },
  { level: 'apply', label: 'Apply', order: 3, meaning: 'Use a method, formula or algorithm on a concrete problem' },
  { level: 'analyze', label: 'Analyze', order: 4, meaning: 'Break down, compare relationships, diagnose, trace causes or structure' },
  { level: 'evaluate', label: 'Evaluate', order: 5, meaning: 'Justify a choice against criteria, critique, assess alternatives' },
  { level: 'create', label: 'Create', order: 6, meaning: 'Design, construct, formulate or develop a new solution' },
];
export const BLOOM_LEVELS = BLOOM.map((b) => b.level);
export const bloomLabel = (v) => BLOOM.find((b) => b.level === String(v || '').toLowerCase())?.label || v;
export const DIFFICULTIES = ['easy', 'medium', 'hard'];
