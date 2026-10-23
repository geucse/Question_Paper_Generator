// The printable examination paper (the institution's formal paper format) for examination-domain papers and the
// legacy HOD papers. Layout, following the institution's sample paper:
//   Roll No. line · [approved logo] · institution / campus · exam heading (type + month/year or session)
//   Program / Course / Time on the left, Semester / Course code / Maximum marks on the right
//   "Note:" with Roman-numbered instructions derived from the paper's frozen rules (plus configured ones)
//   a bordered question grid: Q. No. | Question | Marks | CO (CO only when the paper recorded CO codes), with
//   "attempt any 1" sections printed as one question with alternatives (a) OR (b), long questions split across
//   pages, the column header repeated on every page
//   "Page X of Y" on every page; a DRAFT watermark on every page of a paper that is not final.
// Everything printed comes from the paper's frozen snapshots and its examination; nothing is hard-coded per course.
//
// Text is drawn line by line by this module (no PDFKit auto-pagination), so page breaks are deterministic and
// no blank or clipped page can appear. Latin text uses the standard Times/Courier fonts (selectable, searchable);
// any character outside WinAnsi (Greek, maths symbols, sub/superscripts, most other scripts) is drawn with the
// embedded DejaVu fonts in assets/fonts, so Unicode and mathematical notation print instead of being garbled.
//
// `questions[].attachments` (paper-attachments.js withImageData) are the files the snapshot recorded: PNG/JPEG
// diagrams are embedded under their question, other files are named. `questions[].cos` are the course-outcome codes
// frozen on the paper at generation (exam_papers.candidate_metrics.question_cos). `inline` serves the PDF for the
// browser's viewer (preview / print) instead of as a download. `sections` is the paper-sections.js view built from
// the paper's frozen format_config; the legacy HOD route passes none and gets plain computed headings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { normalizeQuestionType, parseAnswerData, ASSERTION_REASON_OPTIONS } from './question-types.js';
import { paperCountedMarks } from './paper-sections.js';

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const FONT_DIR = path.join(ASSET_DIR, 'fonts');
// Only an institution-approved PNG/JPEG belongs here (see assets/brand/README.md). When it is missing, the paper is
// printed without a logo: nothing is drawn or invented in its place.
export const DEFAULT_LOGO_PATH = path.join(ASSET_DIR, 'brand', 'institution-logo.png');

// A paper_questions row (its frozen snapshot columns) in the shape streamPaperPdf and the paper APIs use. Papers
// are always rendered from these snapshots, never from the live question bank (spec §28, invariant 7).
// reconstructed: the snapshot was rebuilt by migration 040 for a legacy paper created before snapshots existed;
// snapshot_missing: no snapshot was ever recorded (its question no longer exists).
export function snapshotQuestion(row) {
  const m = row.metadata_snapshot || {};
  return {
    id: row.question_id ?? null,
    question_text: row.question_text_snapshot ?? '[question text not recorded]', marks: row.marks_snapshot,
    question_type: m.question_type, difficulty: m.difficulty, bloom_level: m.bloom_level, topic: m.topic,
    option_a: m.option_a, option_b: m.option_b, option_c: m.option_c, option_d: m.option_d,
    correct_answer: m.correct_answer, model_answer: m.model_answer, answer_data: m.answer_data || null,
    section_name: row.section_name ?? null, slot_number: row.slot_number ?? null,
    reconstructed: !!m.reconstructed, reconstructed_at: m.reconstructed_at || null,
    snapshot_missing: row.question_text_snapshot == null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration (read per render, so a deployment changes it through the environment without code changes)
// ---------------------------------------------------------------------------------------------------------------
export function printConfig(env = process.env) {
  const logo = env.INSTITUTION_LOGO_PATH || DEFAULT_LOGO_PATH;
  return {
    institution: (env.INSTITUTION_NAME || '').trim() || 'Institution Name Not Configured',
    logoPath: logo && /\.(png|jpe?g)$/i.test(logo) && fs.existsSync(logo) ? logo : null,
    // Institution-wide notes printed after the derived ones, separated by "|" or new lines.
    instructions: String(env.PAPER_GENERAL_INSTRUCTIONS || '').split(/\||\n/).map((s) => s.trim()).filter(Boolean),
  };
}

// Exam headings per exam type (examinations.exam_type CHECK constraint, migration 028).
const EXAM_HEADINGS = {
  mid_term: 'Mid Semester Examination', end_term: 'End Semester Examination', quiz: 'Quiz',
  supplementary: 'Supplementary Examination', makeup: 'Make-up Examination',
};
const MONTHS = ['JAN.', 'FEB.', 'MAR.', 'APR.', 'MAY', 'JUNE', 'JULY', 'AUG.', 'SEPT.', 'OCT.', 'NOV.', 'DEC.'];

// exam_date is a DATE: pg returns a local-midnight Date; tests and JSON give 'YYYY-MM-DD'.
function dateParts(d) {
  if (!d) return null;
  if (d instanceof Date && !Number.isNaN(d.getTime())) return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) } : null;
}
export function examHeading(paper) {
  const base = EXAM_HEADINGS[paper.exam_type];
  if (!base) return String(paper.title || 'Examination');
  const dp = dateParts(paper.exam_date);
  const when = dp ? `${MONTHS[dp.m]} ${dp.y}` : (paper.academic_session_label || '');
  return `${base.toUpperCase()}${when ? ` ${when}` : ''}`;
}
export function toRoman(n) {
  let v = Number(n); if (!Number.isInteger(v) || v <= 0 || v >= 40) return n == null ? '' : String(n);
  let out = '';
  for (const [k, s] of [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (v >= k) { out += s; v -= k; }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Paper structure: numbering, OR alternatives, section headings, derived instructions
// ---------------------------------------------------------------------------------------------------------------
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const isOrSection = (s) => !!s && Number(s.attempt_count) === 1 && Number(s.questions) >= 2;
const marksText = (m) => (m == null ? '' : String(m));

// questions in slot order; sections from paper-sections.js. Returns the printed units in order:
//   { kind: 'heading', text, lines }            a section heading row (and its instruction lines)
//   { kind: 'note', lines }                     section instructions only (when headings are suppressed)
//   { kind: 'single', number, q, label, keyLabel, marks }
//   { kind: 'or', number, label, marks, parts: [{ q, label, keyLabel }] }   "attempt any 1": (a) OR (b) ...
// A paper whose every section is an "attempt any 1" choice prints like the institution's sample (Q1 (a) OR (b),
// Q2 ...) without section headings; any other paper keeps its section headings.
export function paperLayout(questions, sections = []) {
  const byName = new Map(sections.map((s) => [s.name, s]));
  const allOr = sections.length > 0 && sections.every(isOrSection) && questions.every((q) => byName.has(q.section_name));
  const units = []; let n = 0; let current;
  for (let i = 0; i < questions.length;) {
    const q = questions[i]; const s = byName.get(q.section_name);
    if (q.section_name && q.section_name !== current) {
      current = q.section_name;
      if (!allOr) {
        const secQs = questions.filter((x) => x.section_name === q.section_name);
        const secMarks = secQs.reduce((a, x) => a + (Number(x.marks) || 0), 0);
        units.push(s ? { kind: 'heading', text: s.heading, lines: s.instruction_lines || [], choice: s.attempt_count != null }
          : { kind: 'heading', text: `${q.section_name}  (${secQs.length} question${secQs.length === 1 ? '' : 's'}, ${secMarks} marks)`, lines: [], choice: false });
      } else if (s?.instructions) units.push({ kind: 'note', lines: [String(s.instructions)] });
    } else if (!q.section_name) current = null;
    if (isOrSection(s)) {
      const group = [];
      while (i < questions.length && questions[i].section_name === q.section_name && group.length < LETTERS.length) group.push(questions[i++]);
      n += 1;
      units.push({ kind: 'or', number: n, label: `Q${n}`, marks: s.marks_per_question ?? group[0].marks,
        parts: group.map((x, j) => ({ q: x, label: `(${LETTERS[j]})`, keyLabel: `Q${n}(${LETTERS[j]})` })) });
    } else {
      n += 1; i += 1;
      units.push({ kind: 'single', number: n, q, label: `Q${n}.`, keyLabel: `Q${n}`, marks: q.marks });
    }
  }
  return { units, allOr, showCo: questions.some((q) => Array.isArray(q.cos) && q.cos.length > 0) };
}

// The label each question carries on the printed paper (Q3 / Q2(a)), by question id, for the paper screens.
export function printLabels(questions, sections = []) {
  const out = new Map();
  for (const u of paperLayout(questions, sections).units) {
    if (u.kind === 'single') out.set(u.q.question_id ?? u.q.id, u.keyLabel);
    if (u.kind === 'or') u.parts.forEach((p) => out.set(p.q.question_id ?? p.q.id, p.keyLabel));
  }
  return out;
}

// "Note:" lines. Only statements that follow from the paper's own frozen rules, then the paper's stored
// instructions (legacy column) and the institution's configured lines. Nothing institutional is invented here.
export function generalInstructions(paper, layout, sections = [], configured = []) {
  const out = [];
  const hasOr = layout.units.some((u) => u.kind === 'or');
  const otherChoice = sections.some((s) => s.attempt_count != null && !isOrSection(s));
  if (otherChoice) out.push(`Answer the questions as directed under each heading.${hasOr ? ' Where alternatives are separated by OR, answer any one of them.' : ''}`);
  else if (layout.allOr) out.push('Answer all the questions, choosing any one of the alternatives separated by OR in each question.');
  else if (hasOr) out.push('Answer all the questions. Where alternatives are separated by OR, answer any one of them.');
  else out.push('Answer all the questions.');
  const marks = layout.units.filter((u) => u.kind === 'single' || u.kind === 'or').map((u) => Number(u.marks));
  if (marks.length > 1 && marks.every((m) => m === marks[0])) out.push(`Each question carries ${marks[0]} mark${marks[0] === 1 ? '' : 's'}.`);
  else if (marks.length > 1) out.push('The marks for each question are shown in the Marks column.');
  if (layout.showCo) out.push('CO denotes the course outcome assessed by the question.');
  if (paper.instructions) out.push(...String(paper.instructions).split(/\n+/).map((s) => s.trim()).filter(Boolean));
  out.push(...configured);
  return out;
}

// The paper's distribution by CO, Bloom level, unit and difficulty (internal analysis page). Every printed question
// counts, including each OR alternative. A question mapped to several COs counts once under EACH of its COs (as the
// generator counts CO targets), so the CO rows can add up to more than the number of questions; questions without a
// recorded value are counted as "Not recorded" rather than guessed.
export function paperDistribution(questions) {
  const add = (m, key, q) => { const r = m.get(key) || { key, questions: 0, marks: 0 }; r.questions += 1; r.marks += Number(q.marks) || 0; m.set(key, r); };
  const co = new Map(); const bloom = new Map(); const unit = new Map(); const difficulty = new Map();
  for (const q of questions) {
    const cos = Array.isArray(q.cos) && q.cos.length ? q.cos : ['Not recorded'];
    cos.forEach((c) => add(co, c, q));
    add(bloom, q.bloom_level || 'Not recorded', q);
    add(unit, q.unit ? `${q.unit.code}` : 'Not recorded', q);
    add(difficulty, q.difficulty || 'Not recorded', q);
  }
  const BLOOM_ORDER = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
  const DIFF_ORDER = ['easy', 'medium', 'hard'];
  const NR = 'Not recorded';
  const byOrder = (order) => (a, b) => ((a.key === NR) - (b.key === NR)) || ((order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99)) || String(a.key).localeCompare(String(b.key), undefined, { numeric: true });
  return {
    questions: questions.length, marks: questions.reduce((a, q) => a + (Number(q.marks) || 0), 0),
    multi_co: questions.filter((q) => Array.isArray(q.cos) && q.cos.length > 1).length,
    co: [...co.values()].sort(byOrder([])),
    bloom: [...bloom.values()].sort(byOrder(BLOOM_ORDER)), unit: [...unit.values()].sort(byOrder([])), difficulty: [...difficulty.values()].sort(byOrder(DIFF_ORDER)),
    units: Object.fromEntries(questions.filter((q) => q.unit).map((q) => [q.unit.code, q.unit.title])),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Text engine: Unicode fallback, wrapping, justification
// ---------------------------------------------------------------------------------------------------------------
const PAGE_W = 595.28; const PAGE_H = 841.89;
const M_X = 50; const TOP = 42; const CONTENT_BOTTOM = PAGE_H - 58; const FOOTER_Y = PAGE_H - 40;
const CONTENT_W = PAGE_W - 2 * M_X;
const BODY = 'Times-Roman'; const BOLD = 'Times-Bold'; const ITALIC = 'Times-Italic'; const MONO = 'Courier';
const FALLBACK_FILES = {
  'Times-Roman': 'DejaVuSerif.ttf', 'Times-Bold': 'DejaVuSerif-Bold.ttf', 'Times-Italic': 'DejaVuSerif-Italic.ttf',
  'Times-BoldItalic': 'DejaVuSerif-BoldItalic.ttf', Courier: 'DejaVuSansMono.ttf', 'Courier-Bold': 'DejaVuSansMono-Bold.ttf',
};
const CP1252 = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((c) => c.codePointAt(0)));
// Characters drawn with the standard (WinAnsi) PDF fonts. Superscript digits are WinAnsi too, but viewers that
// substitute the non-embedded standard fonts drop them, so they go to the embedded font with the other maths symbols.
const SUPERSCRIPTS = new Set([0xb2, 0xb3, 0xb9]);
export const isWinAnsi = (cp) => ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252.has(cp)) && !SUPERSCRIPTS.has(cp);
// The embedded fallback (DejaVu) is set slightly smaller so its x-height matches Times; all fonts share one baseline.
const scaleOf = (font) => (String(font).startsWith('U-') ? 0.9 : 1);
const BASELINE = 0.74;

// Untrusted text from the bank: control characters, zero-width and bidi-override characters are removed (they can
// hide or reorder printed text); tabs outside code become spaces.
export function cleanText(s, { code = false } = {}) {
  let t = String(s ?? '').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '');
  if (!code) t = t.replace(/\t/g, ' ');
  return t;
}

function registerFallbacks(doc) {
  const fb = {};
  for (const [std, file] of Object.entries(FALLBACK_FILES)) {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) { doc.registerFont(`U-${std}`, p); fb[std] = `U-${std}`; }
  }
  return fb;
}

// runs [{ text, font }] -> tokens: words (pieces per font), spaces (with the font they are set in), line breaks.
function tokenize(runs, fb) {
  const tokens = []; let word = null; let sp = null;
  const flush = () => { if (word) { tokens.push(word); word = null; } };
  for (const r of runs) {
    for (const ch of Array.from(String(r.text ?? ''))) {
      if (ch === '\n') { flush(); tokens.push({ br: true }); sp = null; continue; }
      if (ch === ' ') { flush(); sp = r.font; continue; }
      const std = isWinAnsi(ch.codePointAt(0));
      const font = std ? r.font : (fb[r.font] || r.font);
      const c = std || fb[r.font] ? ch : '?';
      if (!word) { word = { pieces: [], sp }; sp = null; }
      const last = word.pieces[word.pieces.length - 1];
      if (last && last.font === font) last.text += c; else word.pieces.push({ text: c, font });
    }
  }
  flush();
  return tokens;
}

function measure(doc, size) {
  return (p) => doc.font(p.font).fontSize(size * scaleOf(p.font)).widthOfString(p.text);
}
const put = (doc, s, x, y, size, opts = {}) => doc.font(s.font).fontSize(size * scaleOf(s.font))
  .text(s.text, x, y + size * BASELINE, { lineBreak: false, baseline: 'alphabetic', ...opts });

// Greedy line breaking; a word longer than the line is broken between characters.
function wrapTokens(doc, tokens, width, size) {
  const W = measure(doc, size);
  const lines = []; let cur = []; let curW = 0;
  const push = (last) => { lines.push({ words: cur, width: curW, last }); cur = []; curW = 0; };
  const wordW = (w) => w.pieces.reduce((a, p) => a + W(p), 0);
  for (const t of tokens) {
    if (t.br) { push(true); continue; }
    let w = t;
    for (;;) {
      const spW = cur.length ? W({ text: ' ', font: w.sp || cur[cur.length - 1].pieces.at(-1).font }) : 0;
      const ww = wordW(w);
      if (curW + spW + ww <= width + 0.01) { cur.push(w); curW += spW + ww; break; }
      if (cur.length) { push(false); continue; }
      // The word alone is wider than the line: take as many characters as fit.
      const head = { pieces: [], sp: null }; let hw = 0; const rest = { pieces: [], sp: null }; let full = false;
      for (const p of w.pieces) {
        for (const ch of Array.from(p.text)) {
          const cw = W({ text: ch, font: p.font });
          const target = full ? rest : head;
          if (!full && hw + cw > width && head.pieces.length) { full = true; }
          const into = full ? rest : target;
          const last = into.pieces[into.pieces.length - 1];
          if (last && last.font === p.font) last.text += ch; else into.pieces.push({ text: ch, font: p.font });
          if (!full) hw += cw;
        }
      }
      cur.push(head); curW = hw; push(false);
      if (!rest.pieces.length) break;
      w = rest;
    }
  }
  push(true);
  return lines;
}

// One line: consecutive pieces in the same font become one text run. A justified line is set word by word at
// computed positions, each word followed by a real space character, so copied or searched text keeps its spaces
// (PDFKit's own wordSpacing drops them from the text stream).
function drawLine(doc, line, x, y, width, size, align) {
  const W = measure(doc, size);
  if (align === 'justify' && !line.last && line.words.length > 1) {
    const ww = line.words.map((w) => w.pieces.reduce((a, p) => a + W(p), 0));
    const gap = (width - ww.reduce((a, b) => a + b, 0)) / (line.words.length - 1);
    if (gap > 0 && gap < size * 1.25) {
      let cx = x;
      line.words.forEach((w, i) => {
        let px = cx;
        w.pieces.forEach((p, j) => {
          const trailing = j === w.pieces.length - 1 && i < line.words.length - 1 ? ' ' : '';
          put(doc, { text: p.text + trailing, font: p.font }, px, y, size); px += W(p);
        });
        cx += ww[i] + gap;
      });
      return;
    }
  }
  const segs = [];
  const add = (text, font) => { const l = segs[segs.length - 1]; if (l && l.font === font) l.text += text; else segs.push({ text, font }); };
  line.words.forEach((w, i) => {
    if (i > 0) add(' ', w.sp || line.words[i - 1].pieces.at(-1).font);
    w.pieces.forEach((p) => add(p.text, p.font));
  });
  if (!segs.length) return;
  const natural = segs.reduce((a, s) => a + W(s), 0);
  let cx = x + (align === 'center' ? (width - natural) / 2 : align === 'right' ? width - natural : 0);
  for (const s of segs) { put(doc, s, cx, y, size); cx += W(s); }
}

// ---- Layout items: the unit of pagination. An item is { h, draw(x, y) }. ----
const lineHeight = (size) => size * 1.2;
function para(doc, ctx, runs, width, { size = 11, align = 'left', gap = 0.6, after = 0, color = null } = {}) {
  const lines = wrapTokens(doc, tokenize(runs, ctx.fb), width, size);
  return lines.map((ln, i) => ({
    h: lineHeight(size) + gap + (i === lines.length - 1 ? after : 0),
    draw: (x, y) => { if (color) doc.fillColor(color); drawLine(doc, ln, x, y, width, size, align); if (color) doc.fillColor('black'); },
  }));
}
const text = (doc, ctx, s, width, opts = {}) => para(doc, ctx, [{ text: cleanText(s), font: opts.font || BODY }], width, opts);

// Code keeps its layout: tabs become four spaces and spaces become no-break spaces, so neither the PDF writer nor a
// viewer collapses indentation; a line longer than the column breaks between characters.
function codeItems(doc, ctx, code, width, size = 9.5) {
  const out = [];
  for (const raw of cleanText(code, { code: true }).split('\n')) {
    const line = raw.replace(/\t/g, '    ').replace(/ /g, '\u00a0') || '\u00a0';
    out.push(...para(doc, ctx, [{ text: line, font: MONO }], width, { size, gap: 0.4 }));
  }
  return out;
}
export function codeBlock(doc, code, x = M_X, width = CONTENT_W) {
  // Kept for callers that draw code directly onto the current page (no pagination).
  const ctx = { fb: doc._examFallbacks || {} };
  let y = doc.y;
  for (const it of codeItems(doc, ctx, code, width)) { it.draw(x, y); y += it.h; }
  doc.y = y;
}

const space = (h) => ({ h, draw: () => {} });

// Diagrams recorded in the paper's snapshot: PNG/JPEG embedded, scaled to the column; any other file is named so
// the invigilator knows it is supplied separately.
function attachmentItems(doc, ctx, q, type, width) {
  const out = [];
  const list = q.attachments || [];
  for (const a of list) {
    if (a.printable && a.data) {
      try {
        const img = doc.openImage(a.data);
        const scale = Math.min(1, width / img.width, 220 / img.height);
        const w = Math.max(1, img.width * scale); const h = Math.max(1, img.height * scale);
        out.push({ h: h + 8, draw: (x, y) => doc.image(img, x + (width - w) / 2, y + 4, { width: w, height: h }) });
        continue;
      } catch { /* not decodable: named below */ }
    }
    out.push(...text(doc, ctx, a.available ? `(Supplied separately: ${a.file_name})` : `(Diagram not available: ${a.file_name})`, width, { font: ITALIC, size: 9.5 }));
  }
  if (type === 'diagram' && !list.length) out.push(...text(doc, ctx, '(Refer to the diagram supplied with this paper)', width, { font: ITALIC, size: 9.5 }));
  return out;
}

// Everything a candidate needs for one question of any of the 13 types (spec §8).
function questionItems(doc, ctx, q, width) {
  const type = normalizeQuestionType(q.question_type);
  const data = parseAnswerData(q.answer_data) || {};
  const out = [];
  const line = (t, opts = {}) => out.push(...text(doc, ctx, t, width, { size: 10.5, ...opts }));
  // A case study prints the case first: the candidate reads it before the question that depends on it.
  if (type === 'case_study' && data.case_text) {
    line('Case:', { font: BOLD });
    line(String(data.case_text), { font: ITALIC, align: 'justify', after: 3 });
  }
  const parts = cleanText(q.question_text, { code: true }).split(/```[^\n]*\n?/);
  if (parts.length === 1 && type === 'programming') out.push(...codeItems(doc, ctx, q.question_text, width));
  else {
    parts.forEach((part, i) => {
      if (i % 2 === 1) out.push(...codeItems(doc, ctx, part.replace(/\n$/, ''), width));
      else if (part.trim()) out.push(...text(doc, ctx, part.trim(), width, { size: 11, align: 'justify' }));
    });
  }
  if (type === 'mcq') {
    [['A', q.option_a], ['B', q.option_b], ['C', q.option_c], ['D', q.option_d]].filter(([, t]) => t).forEach(([k, t]) => line(`(${k}) ${t}`));
  } else if (type === 'true_false') {
    line('(True / False)');
  } else if (type === 'assertion_reason') {
    line(`Assertion (A): ${data.assertion || ''}`);
    line(`Reason (R): ${data.reason || ''}`);
    Object.entries(ASSERTION_REASON_OPTIONS).forEach(([k, t]) => line(`(${k}) ${t}`));
  } else if (type === 'programming' && (data.language || data.constraints)) {
    line(`Language: ${data.language || 'any'}${data.constraints ? ` | Constraints: ${data.constraints}` : ''}`);
  } else if (type === 'numerical' && data.unit) {
    line(`(Give the answer in ${data.unit})`);
  }
  out.push(...attachmentItems(doc, ctx, q, type, width));
  if (!out.length) out.push(space(lineHeight(11)));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Page flow and the bordered question grid
// ---------------------------------------------------------------------------------------------------------------
class Flow {
  constructor(doc) { this.doc = doc; this.y = TOP; this.pageTop = TOP; this.onPage = null; }
  get room() { return CONTENT_BOTTOM - this.y; }
  get fresh() { return this.y <= this.pageTop + 0.5; }
  newPage() { this.doc.addPage(); this.y = TOP; this.pageTop = TOP; if (this.onPage) { this.onPage(); this.pageTop = this.y; } }
  // Plain flowing items (header, notes, answer key): break between items only.
  place(items, x) {
    for (const it of items) {
      if (it.h > this.room && !this.fresh) this.newPage();
      it.draw(x, this.y); this.y += it.h;
    }
  }
}

const PAD_X = 5; const PAD_Y = 4; const RULE = 0.6;

// cols: [{ w }]; cells: [{ items }] per column, or one cell when span. Rows taller than the room left move to the
// next page; a row taller than a whole page is split between items (each column independently), so a very long
// question continues on the next page under the repeated column header instead of being clipped.
function drawRow(flow, cols, cells, { span = false, fill = null } = {}) {
  const doc = flow.doc;
  const widths = span ? [cols.reduce((a, c) => a + c.w, 0)] : cols.map((c) => c.w);
  const queues = cells.map((c) => [...c.items]);
  const height = (items) => items.reduce((a, it) => a + it.h, 0) + 2 * PAD_Y;
  const full = Math.max(...queues.map(height));
  for (let first = true; first || queues.some((q) => q.length); first = false) {
    if (first && full > flow.room && !flow.fresh && full <= CONTENT_BOTTOM - TOP - 40) flow.newPage();
    const room = flow.room - 2 * PAD_Y;
    const taken = queues.map((q) => {
      const t = []; let h = 0;
      while (q.length && (h + q[0].h <= room || (!t.length && flow.fresh))) { h += q[0].h; t.push(q.shift()); }
      return t;
    });
    if (!first && taken.every((t) => !t.length) && !flow.fresh) { flow.newPage(); first = true; continue; }
    const h = Math.max(...taken.map(height));
    if (taken.every((t) => !t.length) && queues.some((q) => q.length)) { flow.newPage(); first = true; continue; }
    let x = M_X;
    if (fill) doc.save().rect(M_X, flow.y, widths.reduce((a, w) => a + w, 0), h).fill(fill).restore().fillColor('black');
    taken.forEach((items, i) => {
      let y = flow.y + PAD_Y;
      for (const it of items) { it.draw(x + PAD_X, y); y += it.h; }
      x += widths[i];
    });
    doc.save().lineWidth(RULE).strokeColor('black');
    doc.rect(M_X, flow.y, widths.reduce((a, w) => a + w, 0), h).stroke();
    let vx = M_X; widths.slice(0, -1).forEach((w) => { vx += w; doc.moveTo(vx, flow.y).lineTo(vx, flow.y + h).stroke(); });
    doc.restore();
    flow.y += h;
    if (queues.some((q) => q.length)) flow.newPage();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The paper
// ---------------------------------------------------------------------------------------------------------------
export function streamPaperPdf(res, { paper, questions, sections = [], includeAnswers, inline = false }) {
  const cfg = printConfig();
  const heading = examHeading(paper);
  const doc = new PDFDocument({
    size: 'A4', margins: { top: TOP, bottom: 20, left: M_X, right: M_X }, bufferPages: true,
    info: { Title: [heading, paper.subject_code, paper.course_title].filter(Boolean).join(' · '), Creator: 'Examination Portal' },
  });
  res.setHeader('Content-Type', 'application/pdf');
  const safeTitle = (paper.title || 'exam-paper').replace(/[^\w\- ]/g, '').replace(/\s+/g, '_');
  // inline: shown by the browser's PDF viewer (preview / print) instead of saved as a download.
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeTitle}.pdf"`);
  doc.pipe(res);
  const ctx = { fb: registerFallbacks(doc) };
  doc._examFallbacks = ctx.fb;
  const flow = new Flow(doc);

  // Legacy papers used status='locked'; examination-domain papers are final once PRINT_READY (or archived after it).
  const isFinal = paper.status === 'locked' || paper.paper_status === 'PRINT_READY' || (paper.paper_status === 'ARCHIVED' && !!paper.locked_at);
  const totalMarks = paperCountedMarks(sections, questions); // marks a candidate can score (internal choices counted once)
  const layout = paperLayout(questions, sections);

  // ---- Header ----
  doc.font(BOLD).fontSize(11).text('Roll No. :', M_X, flow.y, { lineBreak: false });
  const lx = M_X + doc.widthOfString('Roll No. :') + 6;
  doc.save().lineWidth(0.9).dash(1, { space: 2.5 }).moveTo(lx, flow.y + 11).lineTo(lx + 175, flow.y + 11).stroke().undash().restore();
  flow.y += 24;
  if (cfg.logoPath) {
    try {
      const img = doc.openImage(cfg.logoPath);
      const scale = Math.min(54 / img.height, 220 / img.width);
      const w = img.width * scale; const h = img.height * scale; // aspect ratio preserved, never stretched
      doc.image(img, (PAGE_W - w) / 2, flow.y, { width: w, height: h });
      flow.y += h + 6;
    } catch { /* an unreadable logo file is left out rather than failing the paper */ }
  }
  flow.place(text(doc, ctx, cfg.institution, CONTENT_W, { font: BOLD, size: 15, align: 'center', after: 1 }), M_X);
  const sub = [paper.campus_name, paper.department_name].filter(Boolean).join(' · ');
  if (sub) flow.place(text(doc, ctx, sub, CONTENT_W, { size: 10.5, align: 'center' }), M_X);
  flow.y += 6;
  flow.place(text(doc, ctx, heading, CONTENT_W, { font: BOLD, size: 12.5, align: 'center', after: 8 }), M_X);

  // ---- Examination details (two columns) ----
  const dash = '—';
  const dp = dateParts(paper.exam_date);
  const rows = [
    [['Name of the Program: ', paper.program_name || dash, BODY, BOLD], ['Semester: ', paper.semester ? toRoman(paper.semester) : dash, BODY, BODY]],
    [['Name of the Course: ', paper.course_title || dash, BODY, BODY], ['Course Code: ', paper.subject_code || dash, BODY, BODY]],
    [['Time: ', paper.duration_minutes ? `${paper.duration_minutes} Minutes` : '_______________', BOLD, BOLD], ['Maximum Marks: ', String(totalMarks), BOLD, BOLD]],
  ];
  if (paper.academic_session_label || dp) {
    rows.push([['Academic Session: ', paper.academic_session_label || dash, BODY, BODY],
      ['Date: ', dp ? `${String(dp.d).padStart(2, '0')}.${String(dp.m + 1).padStart(2, '0')}.${dp.y}` : dash, BODY, BODY]]);
  }
  const LEFT_W = 310; const RIGHT_X = M_X + 335; const RIGHT_W = CONTENT_W - 335;
  for (const [l, r] of rows) {
    const li = para(doc, ctx, [{ text: l[0], font: l[2] }, { text: cleanText(l[1]), font: l[3] }], LEFT_W, { size: 11, gap: 2 });
    const ri = para(doc, ctx, [{ text: r[0], font: r[2] }, { text: cleanText(r[1]), font: r[3] }], RIGHT_W, { size: 11, gap: 2 });
    const y0 = flow.y; let y = y0; li.forEach((it) => { it.draw(M_X, y); y += it.h; });
    let y2 = y0; ri.forEach((it) => { it.draw(RIGHT_X, y2); y2 += it.h; });
    flow.y = Math.max(y, y2) + 2;
  }
  flow.y += 8;

  // ---- Note (instructions) ----
  const notes = generalInstructions(paper, layout, sections, cfg.instructions);
  flow.place(text(doc, ctx, 'Note:', CONTENT_W, { font: BOLD, size: 11, after: 2 }), M_X);
  notes.forEach((t, i) => {
    const items = text(doc, ctx, t, CONTENT_W - 34, { size: 10.5 });
    const label = `${toRoman(i + 1).toLowerCase()}.`;
    const first = items[0];
    items[0] = { h: first.h, draw: (x, y) => { doc.font(BODY).fontSize(10.5).text(label, x - 26, y, { lineBreak: false }); first.draw(x, y); } };
    flow.place(items, M_X + 34);
  });
  flow.y += 10;

  // ---- Question grid ----
  const showCo = layout.showCo;
  const cols = [{ w: 46 }, { w: 0 }, { w: 46 }, ...(showCo ? [{ w: 52 }] : [])];
  cols[1].w = CONTENT_W - cols.reduce((a, c) => a + c.w, 0);
  const cw = (i) => cols[i].w - 2 * PAD_X;
  const cell = (i, t, opts = {}) => ({ items: t == null || t === '' ? [] : text(doc, ctx, t, cw(i), { size: 10.5, align: 'center', ...opts }) });
  const coText = (q) => (Array.isArray(q.cos) && q.cos.length ? q.cos.join(', ') : dash);
  const headerRow = () => drawRow(flow, cols, [cell(0, 'Q. No.', { font: BOLD }), cell(1, 'Question', { font: BOLD, align: 'left' }), cell(2, 'Marks', { font: BOLD }),
    ...(showCo ? [cell(3, 'CO', { font: BOLD })] : [])], { fill: '#eeeeee' });
  // Keep a heading or a question's first row with what follows it.
  const keep = (h) => { if (h > flow.room && !flow.fresh) flow.newPage(); };

  if (questions.length) {
    keep(60);
    headerRow();
    flow.onPage = headerRow;
    for (const u of layout.units) {
      if (u.kind === 'heading' || u.kind === 'note') {
        const items = [];
        if (u.kind === 'heading') items.push(...text(doc, ctx, u.text, CONTENT_W - 2 * PAD_X, { font: BOLD, size: 11, align: 'center' }));
        u.lines.forEach((l, i) => items.push(...text(doc, ctx, l, CONTENT_W - 2 * PAD_X,
          { font: i === 0 && u.choice ? BOLD : ITALIC, size: 9.5, align: 'center' })));
        keep(items.reduce((a, it) => a + it.h, 0) + 2 * PAD_Y + 50);
        drawRow(flow, cols, [{ items }], { span: true });
      } else if (u.kind === 'single') {
        keep(70);
        drawRow(flow, cols, [cell(0, u.label, { font: BOLD }), { items: questionItems(doc, ctx, u.q, cw(1)) }, cell(2, marksText(u.marks)),
          ...(showCo ? [cell(3, coText(u.q))] : [])]);
      } else {
        keep(90);
        drawRow(flow, cols, [cell(0, u.label, { font: BOLD }),
          cell(1, `Attempt any one of the ${u.parts.length} alternatives.`, { font: ITALIC, align: 'left' }), cell(2, marksText(u.marks)),
          ...(showCo ? [cell(3, '')] : [])]);
        u.parts.forEach((p, j) => {
          if (j > 0) drawRow(flow, cols, [cell(0, ''), cell(1, 'OR', { font: BOLD, align: 'left' }), cell(2, ''), ...(showCo ? [cell(3, '')] : [])]);
          drawRow(flow, cols, [cell(0, p.label), { items: questionItems(doc, ctx, p.q, cw(1)) }, cell(2, ''),
            ...(showCo ? [cell(3, coText(p.q))] : [])]);
        });
      }
    }
    flow.onPage = null;
  }

  // ---- Internal copy only: paper analysis (distribution by CO, Bloom level, unit, difficulty) ----
  if (includeAnswers && questions.length) {
    const d = paperDistribution(questions);
    flow.newPage();
    flow.place(text(doc, ctx, 'Paper Analysis (Internal Use Only)', CONTENT_W, { font: BOLD, size: 14, align: 'center', after: 2 }), M_X);
    flow.place(text(doc, ctx, `${d.questions} printed question(s), ${d.marks} printed marks (each OR alternative is counted). `
      + `${d.multi_co ? `${d.multi_co} question(s) map to more than one CO and are counted under each of their COs, so the CO rows can total more than ${d.questions}.` : 'Each question maps to one CO.'}`,
    CONTENT_W, { font: ITALIC, size: 9.5, align: 'center', after: 8 }), M_X);
    const tcols = [{ w: CONTENT_W - 2 * 90 }, { w: 90 }, { w: 90 }];
    const tcell = (i, t, opts = {}) => ({ items: text(doc, ctx, String(t), tcols[i].w - 2 * PAD_X, { size: 10, align: i ? 'center' : 'left', ...opts }) });
    const label = { remember: 'Remember', understand: 'Understand', apply: 'Apply', analyze: 'Analyze', evaluate: 'Evaluate', create: 'Create', easy: 'Easy', medium: 'Medium', hard: 'Hard' };
    for (const [title, rowsOf] of [['Course outcomes', d.co], ["Bloom's taxonomy level", d.bloom], ['Syllabus unit', d.unit], ['Difficulty', d.difficulty]]) {
      if (flow.room < 90) flow.newPage();
      drawRow(flow, tcols, [tcell(0, title, { font: BOLD }), tcell(1, 'Questions', { font: BOLD }), tcell(2, 'Marks', { font: BOLD })], { fill: '#eeeeee' });
      for (const r of rowsOf) {
        const name = title === 'Syllabus unit' && d.units[r.key] ? d.units[r.key] : (label[r.key] || r.key);
        drawRow(flow, tcols, [tcell(0, name), tcell(1, r.questions), tcell(2, r.marks)]);
      }
      flow.y += 10;
    }
  }

  // ---- Answer key appendix (COE / assigned validators; gated by the route) ----
  if (includeAnswers && questions.length) {
    flow.newPage();
    flow.place(text(doc, ctx, 'Answer Key (Internal Use Only)', CONTENT_W, { font: BOLD, size: 14, align: 'center', after: 4 }), M_X);
    doc.save().lineWidth(RULE).strokeColor('#888888').moveTo(M_X, flow.y).lineTo(M_X + CONTENT_W, flow.y).stroke().restore();
    flow.y += 8;
    const entries = layout.units.flatMap((u) => (u.kind === 'single' ? [{ q: u.q, label: u.keyLabel }] : u.kind === 'or' ? u.parts.map((p) => ({ q: p.q, label: p.keyLabel })) : []));
    for (const { q, label } of entries) {
      const type = normalizeQuestionType(q.question_type);
      if (type === 'programming') {
        // The reference solution is code: monospace, indentation kept.
        const data = parseAnswerData(q.answer_data) || {};
        const items = text(doc, ctx, `${label}:`, CONTENT_W, { font: BOLD, size: 10.5 });
        if (data.language) items.push(...text(doc, ctx, `Language: ${data.language}`, CONTENT_W - 20, { size: 9.5 }));
        flow.place(items, M_X);
        flow.place(codeItems(doc, ctx, q.model_answer || '—', CONTENT_W - 20), M_X + 20);
      } else {
        flow.place(para(doc, ctx, [{ text: `${label}: `, font: BOLD }, { text: cleanText(answerKeyText(q)), font: BODY }], CONTENT_W, { size: 10.5 }), M_X);
      }
      flow.y += 4;
    }
  }

  // Honest provenance for legacy papers whose snapshot was rebuilt from the question bank (migration 040).
  const rebuilt = questions.filter((q) => q.reconstructed);
  if (rebuilt.length || questions.some((q) => q.snapshot_missing)) {
    const when = rebuilt.map((q) => q.reconstructed_at).filter(Boolean).sort()[0];
    flow.y += 6;
    flow.place(text(doc, ctx, `Some questions were reconstructed from the question bank${when ? ` on ${String(when).slice(0, 10)}` : ''}; no snapshot was recorded when this legacy paper was created.`,
      CONTENT_W, { font: ITALIC, size: 8.5, color: '#555555' }), M_X);
  }

  // ---- Every page: DRAFT watermark (non-final papers) and "Page X of Y" ----
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    if (!isFinal) {
      doc.save();
      doc.font('Helvetica-Bold').fontSize(60).fillColor('#e5484d').opacity(0.15)
        .rotate(-30, { origin: [300, 400] })
        .text('DRAFT — NOT FOR DISTRIBUTION', 0, 380, { align: 'center', width: 600 });
      doc.restore();
      doc.fillColor('black').opacity(1);
    }
    const label = `Page ${i - start + 1} of ${count}`;
    doc.font(BODY).fontSize(9.5).fillColor('black');
    doc.text(label, PAGE_W - M_X - doc.widthOfString(label), FOOTER_Y, { lineBreak: false });
  }
  doc.end();
}

// The option letter an MCQ answer names: the stored option text (or a letter, older rows) -> 'B'.
function mcqLetter(q) {
  const ans = String(q.correct_answer ?? '').trim();
  if (/^[A-Da-d]$/.test(ans) && q[`option_${ans.toLowerCase()}`]) return ans.toUpperCase();
  return ['a', 'b', 'c', 'd'].find((k) => String(q[`option_${k}`] ?? '').trim() === ans && ans)?.toUpperCase() || null;
}

// One line of the answer key for any of the 13 types, in each type's normal form.
export function answerKeyText(q) {
  const type = normalizeQuestionType(q.question_type);
  const data = parseAnswerData(q.answer_data) || {};
  switch (type) {
    case 'mcq': {
      const letter = mcqLetter(q);
      if (letter) return `(${letter}) ${String(q[`option_${letter.toLowerCase()}`]).trim()}`;
      return q.correct_answer || '—';
    }
    case 'true_false': {
      const v = String(q.correct_answer || '').trim().toUpperCase();
      return v === 'TRUE' ? 'True' : v === 'FALSE' ? 'False' : '—';
    }
    case 'assertion_reason': return q.correct_answer ? `(${String(q.correct_answer).toUpperCase()}) ${ASSERTION_REASON_OPTIONS[String(q.correct_answer).toUpperCase()] || ''}` : '—';
    case 'numerical': return data.expected_value != null
      ? `${data.expected_value}${data.unit ? ` ${data.unit}` : ''}${Number(data.tolerance) ? ` (± ${data.tolerance})` : ''}${q.model_answer ? ` — ${q.model_answer}` : ''}` : (q.model_answer || '—');
    case 'fill_blank': return Array.isArray(data.answers) && data.answers.length
      ? data.answers.map((a, i) => `Blank ${i + 1}: ${a}`).join('; ') : (q.model_answer || '—');
    default: return q.model_answer || '—';
  }
}
