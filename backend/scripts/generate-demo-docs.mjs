// Regenerates docs/demo-data/ from the demo dataset (data/syllabus-2023) and the demo seed's assignment and
// lifecycle rules, so the documentation always matches what `npm run seed:demo` creates.
//   npm run docs:demo   (from backend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDemoDataset, datasetSummary, lifecyclePlan } from '../src/demo-dataset.js';
import { ASSERTION_REASON_OPTIONS, QUESTION_TYPES } from '../src/question-types.js';
import { bloomLabel } from '../src/taxonomy.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'demo-data');
const TEACHERS = ['teacher1@portal.edu', 'teacher2@portal.edu', 'teacher3@portal.edu', 'teacher4@portal.edu'];
const REVIEWERS = ['reviewer@portal.edu', 'reviewer2@portal.edu', 'reviewer3@portal.edu'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const STATE = { ACTIVE: 'Active', APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', SUBMITTED: 'Submitted', DRAFT: 'Draft' };
const typeLabel = (c) => QUESTION_TYPES.find((t) => t.code === c)?.label || c;
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const fileOf = (code) => `${code.replace(/\s+/g, '')}.md`;

const { catalog, subjects, errors } = loadDemoDataset();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
fs.mkdirSync(path.join(OUT, 'subjects'), { recursive: true });

const rows = [];
subjects.forEach((s, index) => {
  const teachers = [TEACHERS[index % 4], TEACHERS[(index + 1) % 4]];
  const reviewer = REVIEWERS[index % 3];
  const plan = lifecyclePlan(s, { keepActive: s.code === 'TCS 571' ? [16] : [] });
  const md = [];
  md.push(`# ${s.code} — ${s.title}`, '');
  md.push('> **DEMO / SAMPLE questions.** The syllabus content below is the official 2023 CSE syllabus; the 20 questions are sample content written for testing this portal, not official examination questions.', '');
  md.push('| | |', '|---|---|');
  md.push(`| Semester | ${ROMAN[s.semester - 1]} |`, `| Category | ${s.category === 'DE' ? 'Departmental elective (DE)' : 'Departmental core (DC)'} |`);
  md.push(`| Source | \`Syllabus-2023-New.pdf\`, pages ${s.pages.join('–')} |`, `| Contact hours | ${s.units.map((u) => u.hours).join(' + ')} = ${s.total_hours ?? s.units.reduce((a, u) => a + u.hours, 0)} |`);
  md.push(`| Demo course offering | \`${s.code.replace(/\s+/g, '')}-2026-S${s.semester}-DEMO\` (B.Tech CSE, session 2026-2027) |`);
  md.push(`| Teachers (authors) | ${teachers.map((t) => `\`${t}\``).join(', ')} |`, `| Reviewer | \`${reviewer}\` |`, '');
  if (s.hod_flags?.length || s.corrections?.length || s.warnings?.length) {
    md.push('## HOD notes', '');
    for (const w of s.warnings || []) md.push(`- **Extraction warning:** ${w}`);
    for (const c of s.corrections || []) md.push(`- **Correction during verification (unit ${c.unit}):** “${c.from}” → “${c.to}”. ${c.reason}`);
    for (const f of s.hod_flags || []) md.push(`- **Gap flagged (${f.co}):** ${f.issue}`);
    md.push('');
  }
  md.push('## Course outcomes', '');
  for (const co of s.course_outcomes) md.push(`- **${co.code}** — ${co.text}`);
  md.push('', '## Units and verified topics', '');
  for (const u of s.units) {
    md.push(`### Unit ${u.number} (${u.hours} hours)${u.label_missing_in_source ? ' — no “Unit” label in the PDF' : ''}`, '');
    md.push(`*As printed:* ${u.text}`, '');
    md.push(`*Verified topics:* ${(s.topics[String(u.number)] || []).map((t) => `“${t}”`).join(', ')}`, '');
  }
  md.push('## Sample questions', '');
  md.push('| # | Type | Marks | Difficulty | Bloom | CO | Unit | After `seed:demo` | Author |', '|---|---|---|---|---|---|---|---|---|');
  s.questions.forEach((q, i) => {
    const st = plan.get(i + 1);
    md.push(`| [Q${i + 1}](#q${i + 1}) | ${typeLabel(q.question_type)} | ${q.marks} | ${q.difficulty} | ${bloomLabel(q.bloom_level)} | ${q.cos.join(', ')} | ${q.unit_number} | ${STATE[st]}${s.code === 'TCS 571' && i + 1 === 16 ? ' (after a revision cycle)' : ''} | ${teachers[i % 2].split('@')[0]} |`);
  });
  md.push('');
  s.questions.forEach((q, i) => {
    md.push(`### Q${i + 1}`, '');
    md.push(`**${typeLabel(q.question_type)} · ${q.marks} mark${q.marks === 1 ? '' : 's'} · ${q.difficulty} · ${bloomLabel(q.bloom_level)} · ${q.cos.join(', ')} · Unit ${q.unit_number}: “${q.topic_title}”**`, '');
    if (q.answer_data?.case_text) md.push(`> **Case:** ${q.answer_data.case_text}`, '');
    md.push(q.question_type === 'programming' && !/```/.test(q.question_text) ? q.question_text : q.question_text.replace(/```/g, '\n```\n'), '');
    if (q.question_type === 'mcq') ['a', 'b', 'c', 'd'].forEach((k) => md.push(`- (${k.toUpperCase()}) ${q[`option_${k}`]}`));
    if (q.question_type === 'assertion_reason') {
      md.push(`- **Assertion (A):** ${q.answer_data.assertion}`, `- **Reason (R):** ${q.answer_data.reason}`);
      Object.entries(ASSERTION_REASON_OPTIONS).forEach(([k, t]) => md.push(`- (${k}) ${t}`));
    }
    if (q.question_type === 'programming') md.push(`*Language:* ${q.answer_data.language}`);
    md.push('');
    const key = q.question_type === 'mcq' ? `(${'ABCD'['abcd'.split('').findIndex((k) => q[`option_${k}`] === q.correct_answer)]}) ${q.correct_answer}`
      : q.question_type === 'true_false' ? (q.correct_answer === 'TRUE' ? 'True' : 'False')
        : q.question_type === 'assertion_reason' ? `(${q.correct_answer}) ${ASSERTION_REASON_OPTIONS[q.correct_answer]}`
          : q.question_type === 'numerical' ? `${q.answer_data.expected_value}${q.answer_data.unit ? ` ${q.answer_data.unit}` : ''}${q.answer_data.tolerance ? ` (± ${q.answer_data.tolerance})` : ''}`
            : q.question_type === 'fill_blank' ? q.answer_data.answers.map((a, k) => `blank ${k + 1}: ${a}`).join('; ') : null;
    if (key) md.push(`**Answer:** ${key}`, '');
    if (q.model_answer) md.push(q.question_type === 'programming' ? `**Model answer:**\n\n\`\`\`${String(q.answer_data.language || '').toLowerCase()}\n${q.model_answer}\n\`\`\`` : `**Model answer:** ${q.model_answer}`, '');
  });
  fs.writeFileSync(path.join(OUT, 'subjects', fileOf(s.code)), md.join('\n'));
  rows.push(`| ${ROMAN[s.semester - 1]} | [${s.code}](subjects/${fileOf(s.code)}) | ${esc(s.title)} | ${s.pages.join('–')} | ${s.course_outcomes.length} | ${s.units.length} | ${Object.values(s.topics).flat().length} | ${s.questions.length} | ${teachers.map((t) => t.split('@')[0]).join(', ')} | ${reviewer.split('@')[0]} |`);
});

const sum = datasetSummary(subjects);
const idx = [`# Demo data: sample syllabus and questions`, '',
  '> All 280 questions are **DEMO / SAMPLE** content for testing the portal. The syllabus data (subjects, COs, units, hours) is the official Graphic Era 2023 CSE syllabus.', '',
  `Source: \`backend/data/syllabus-2023/Syllabus-2023-New.pdf\` (316 pages, SHA-256 \`${catalog.source.sha256}\`). Loaded by \`npm run seed:demo\`. Full background: [demo data catalog](CATALOG.md).`, '',
  `**Totals:** ${sum.subjects} subjects · ${sum.questions} questions · ${sum.course_outcomes} course outcomes · ${sum.units} units · ${sum.topics} verified topics.`, '',
  '| Sem | Code | Title | PDF pages | COs | Units | Topics | Questions | Teachers | Reviewer |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, '',
  '## Questions by type', '', '| Type | Count |', '|---|---|', ...Object.entries(sum.by_type).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${typeLabel(k)} | ${v} |`), '',
  '## Questions by Bloom level and difficulty', '', '| Bloom level | Count | | Difficulty | Count |', '|---|---|---|---|---|',
  ...['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'].map((k, i) => `| ${bloomLabel(k)} | ${sum.by_bloom[k] || 0} | | ${['easy', 'medium', 'hard'][i] ? `${['Easy', 'Medium', 'Hard'][i]} | ${sum.by_difficulty[['easy', 'medium', 'hard'][i]]}` : ' | '} |`), '',
  '## Lifecycle after seeding', '', 'Each subject: **16 Active** questions (covering every unit and every CO the subject can cover) and one each **Approved**, **Changes requested**, **Submitted** and **Draft**. Each subject page shows which.', ''];
fs.writeFileSync(path.join(OUT, 'README.md'), idx.join('\n'));
console.log(`docs/demo-data: README.md + ${subjects.length} subject pages`);
