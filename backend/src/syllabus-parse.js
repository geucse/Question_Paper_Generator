// Parses the text of a Graphic Era course-syllabus document (one course per block, the department's standard form:
// "1. Subject Code / Course Title / 2. Contact Hours ... 9. Course Outcome: CO1 ... 10. Details of the Course ...
// 11. Suggested Books") into structured courses: code, title, semester, COs exactly as printed, and units with their
// contact hours and topics. Input is the text in content-stream order with "\f" between pages (pdf-text-extract.js,
// or `pdftotext -raw`). Nothing is invented: what the text does not contain is reported in `warnings`, and a course
// whose COs or units cannot be found is still returned with those warnings so the HOD can resolve them.
//
// The form's header VALUES are stored apart from their labels in these PDFs: they appear as a run of lines at the end
// of the course's first page (title, code, L, T, P, theory/practical hours, CIE, MSE, SEE, credits, semester,
// category, in varying order). stripHeaderRuns() removes exactly that run so it does not leak into unit text.

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const CODE_RX = /^([A-Z]{2,4})\s*[- ]?\s*(\d{3}[A-Z]?)$/;
const CATEGORY = /^(DC|DE|OE|PC|PE|HS|BS|ES|MC|AU)$/;
const SEMESTER_TOKEN = /^([IVX]+|\d(st|nd|rd|th))$/;
const HEADER = /GRAPHIC ERA \(DEEMED TO BE UNIVERSITY\),\s*DEHRADUN\s*\n\s*SEMESTER\s+([IVX]+)/g;

export const normalizeCode = (s) => {
  const m = CODE_RX.exec(String(s || '').trim().replace(/\s+/g, ' '));
  return m ? `${m[1]} ${m[2]}` : null;
};
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const pageAt = (text, pos) => (text.slice(0, pos).match(/\f/g) || []).length + 1;

// The header-value run: the course code on a line of its own, surrounded by the other printed values (up to nine
// numbers, the semester, the category) and the title (one to three short lines). Found on the course's first page.
// Title lines are short, start with a capital and carry no commas (unit text wraps in long, comma-separated lines).
const isTitleLine = (l) => /^[A-Z][A-Za-z0-9&()+#\-/' ]{0,60}$/.test(l)
  && !/^(CO\s*\d|Unit|UNIT|Total|Sl\.?|SL\.?|No\.?|NO\.?|Contents|Contact|Hours|Hrs|\d+\.)/.test(l);
function headerRun(lines, code) {
  // The code on a line of its own, or after the title on the same baseline ("Computer Networks II TCS-703").
  const codeOf = (l) => {
    const t = l.trim();
    const own = normalizeCode(t);
    if (own) return { code: own, prefix: '' };
    const m = /^(.*?[A-Za-z)])\s+([A-Z]{2,4}\s*[- ]?\s*\d{3}[A-Z]?)$/.exec(t);
    return m && normalizeCode(m[2]) && isTitleLine(m[1]) ? { code: normalizeCode(m[2]), prefix: m[1] } : null;
  };
  const at = [];
  lines.forEach((l, i) => { const c = codeOf(l); if (c && (!code || c.code === code)) at.push(i); });
  if (!at.length) return null;
  const c = at[at.length - 1];
  const found = codeOf(lines[c]);
  let numbers = 0; let semester = null; let category = null; const title = found.prefix ? [found.prefix] : [];
  // A value line: every token is a number, the semester (roman or ordinal, its superscript suffix printed on
  // its own baseline as in "7" + "th"), or the category. Nine numbers; one more when the semester is a digit.
  let suffixSemester = false;
  const take = (l, allowTitle) => {
    const toks = l.split(/\s+/).filter(Boolean);
    let n = 0; let sem = null; let cat = null; let suffix = false;
    const ok = toks.every((t) => {
      if (/^\d{1,3}$/.test(t)) { n++; return true; }
      if (!cat && !category && CATEGORY.test(t)) { cat = t; return true; }
      if (!sem && !semester && SEMESTER_TOKEN.test(t)) { sem = t; return true; }
      if (!sem && !semester && /^(st|nd|rd|th)$/.test(t)) { sem = t; suffix = true; return true; }
      return false;
    });
    const limit = (semester || sem) && !(suffix || suffixSemester) ? 9 : 10;
    if (ok && toks.length && numbers + n <= limit) {
      numbers += n; if (cat) category = cat; if (sem) { semester = sem; suffixSemester = suffix; }
      return true;
    }
    if (allowTitle && title.length < 3 && isTitleLine(l)) return 'title';
    return false;
  };
  // Values after the code first (they fill the nine numbers), then before it.
  let lo = c; let hi = c;
  for (let i = c + 1; i < lines.length; i++) {
    const l = lines[i].trim(); if (!l) { hi = i; continue; }
    const t = take(l, false); if (!t) break;
    hi = i;
  }
  for (let i = c - 1; i >= 0; i--) {
    const l = lines[i].trim(); if (!l) continue;
    const t = take(l, true); if (!t) break;
    if (t === 'title') { if (found.prefix) break; title.unshift(l); }
    lo = i;
  }
  // A title can also follow the values ("TCS-402 ... 0 IV 3 DC" then nothing): only when none was found before.
  if (!title.length) {
    for (let i = hi + 1; i < lines.length && title.length < 3; i++) {
      const l = lines[i].trim(); if (!l) continue;
      if (!isTitleLine(l)) break;
      title.push(l); hi = i;
    }
  }
  return { code: found.code, title: squash(title.join(' ')), semester, category, lo, hi, numbers };
}
function headerValues(block) {
  const lines = block.split('\f')[0].split('\n');
  return headerRun(lines) || { code: null, title: '', semester: null, category: null };
}

// Remove the header-value run (title, code, the nine numbers, semester, category) wherever it sits in the block.
export function stripHeaderRuns(block, code) {
  return block.split('\f').map((page) => {
    const lines = page.split('\n');
    const run = headerRun(lines, code);
    if (!run || run.numbers < 5) return page;
    return [...lines.slice(0, run.lo), ...lines.slice(run.hi + 1)].join('\n');
  }).join('\n');
}

// "Heading: a, b, c; Other heading: d, e. Plain item, plain item" -> topics with subtopics.
export function topicsFromUnitText(text) {
  const topics = [];
  const seen = new Set();
  const add = (title, subtopics = []) => {
    const t = squash(title).replace(/^[-–,:;.\s]+|[-–,:;\s]+$/g, '').replace(/\.$/, '');
    if (t.length < 2) return;
    const key = t.toLowerCase().slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    const subs = [...new Set(subtopics.map((s) => squash(s).replace(/^[-–,:;.\s]+|[-–,:;.\s]+$/g, '')).filter((s) => s.length > 1))];
    topics.push({ title: t.slice(0, 200), subtopics: subs.slice(0, 40) });
  };
  // Commas inside parentheses do not separate items.
  const splitTop = (s, sep) => {
    const out = []; let depth = 0; let cur = '';
    for (const ch of s) {
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  };
  const clauses = splitTop(squash(text), ';').flatMap((c) => c.split(/\.\s+(?=[A-Z])/));
  const heading = (c) => /^([^:]{3,70}?)\s*:\s*(.+)$/.exec(c) || /^(.{3,60}?[A-Za-z)])\s*[-–]\s+(.+)$/.exec(c);
  for (const clause of clauses) {
    let m = heading(clause);
    if (m && m[1].split(/\s+/).length <= 9) {
      // "Taxonomy: Choosing a chart type: Dot plot, ..." -> the innermost heading carries the items.
      const inner = heading(m[2]);
      if (inner && !inner[1].includes(',') && inner[1].split(/\s+/).length <= 9 && splitTop(inner[2], ',').length > 1) m = inner;
      // An item that carries its own heading ("... each other Loops: for loops") starts a new topic.
      let title = m[1]; let subs = [];
      for (const item of splitTop(m[2], ',')) {
        const h = /^(.*?)\b([A-Z][^:,]{2,60}?)\s*:\s*(.+)$/.exec(item);
        if (h && h[2].split(/\s+/).length <= 8) {
          if (h[1].trim()) subs.push(h[1]);
          add(title, subs.length ? subs : []); title = h[2]; subs = [h[3]];
        } else subs.push(item);
      }
      add(title, subs.length > 1 ? subs : subs.length ? [subs[0].replace(/\.$/, '')] : []);
      continue;
    }
    const items = splitTop(clause, ',');
    if (items.length > 1) items.forEach((x) => add(x)); else add(clause);
  }
  return topics;
}

function parseUnits(body, warnings) {
  // Units are labelled "Unit 1:", "UNIT- I", "Unit – III" (optionally after the row number "2 Unit 2:").
  const rx = /(?:^|\n)[ \t]*(?:\d+[ \t]+)?(?:Unit|UNIT)[ \t]*[-–]?[ \t]*([IVX]+|\d+)[ \t]*[:.\-–]?[ \t]*/g;
  const marks = [...body.matchAll(rx)].map((m) => ({ n: ROMAN[m[1]] || Number(m[1]), at: m.index, end: m.index + m[0].length }));
  const units = [];
  marks.forEach((m, k) => {
    const next = marks[k + 1];
    let content = body.slice(m.end, next ? next.at : body.length);
    // The row number of the next unit ("3") sits on its own line right before it.
    if (next) content = content.replace(new RegExp(`\\n\\s*${next.n}\\s*$`), '');
    // A row whose "Unit n" label is missing in the source: the row number on its own line, followed by text,
    // between labelled units n-1 and n+1.
    if (next && next.n > m.n + 1) {
      const gap = new RegExp(`\\n\\s*(${m.n + 1})\\s*\\n(?=\\s*[A-Z])`);
      const g = gap.exec(content);
      if (g) {
        units.push(unitFrom(m.n, content.slice(0, g.index)));
        units.push({ ...unitFrom(m.n + 1, content.slice(g.index + g[0].length)), label_missing_in_source: true });
        warnings.push(`Unit ${m.n + 1} has no "Unit ${m.n + 1}" label in the source; it was identified by its row number`);
        return;
      }
    }
    units.push(unitFrom(m.n, content));
  });
  return units;
}

function unitFrom(number, content) {
  const standalone = [...content.matchAll(/(?:^|\n)\s*(\d{1,2})\s*(?=\n|$)/g)].map((x) => Number(x[1]));
  let text = content.replace(/(?:^|\n)\s*\d{1,2}\s*(?=\n|$)/g, '\n');
  let hours = standalone.length ? standalone[0] : null;
  // Hours printed at the end of the last text line ("... SNMP 9").
  const trailing = /\s(\d{1,2})\s*$/.exec(squash(text));
  if (hours == null && trailing) { hours = Number(trailing[1]); text = squash(text).replace(/\s\d{1,2}$/, ''); }
  text = squash(text);
  return { number, hours, text, topics: topicsFromUnitText(text) };
}

// text: the document text (stream order, "\f" between pages). Returns [{ code, title, semester, department,
// category, credits, contact_hours: {L,T,P}, pages: [first, last], course_outcomes: [{code, text}], units, warnings }].
export function parseSyllabusDocument(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const heads = [...src.matchAll(HEADER)].map((m) => ({ at: m.index, semester: m[1] }));
  const courses = [];
  heads.forEach((h, k) => {
    const block = src.slice(h.at, k + 1 < heads.length ? heads[k + 1].at : src.length);
    const warnings = [];
    const hv = headerValues(block);
    const code = hv.code;
    if (!code) return; // not a course block
    const title = hv.title || null;
    if (!title) warnings.push('Course title not found in the header values');
    const clean = stripHeaderRuns(block, code);
    const dept = /Name of Department\s*:?\s*-?\s*(.+)/.exec(clean)?.[1]?.trim() || null;
    const coPart = /Outcome\s*\**\s*:?([\s\S]*?)(?:\*\*\s*Describe|10\.\s*Details|10\.\s*Detailed)/.exec(clean)?.[1] || '';
    const course_outcomes = [...coPart.matchAll(/(?:^|\s)CO\s*(\d+)\s*[:.\-–]\s*([\s\S]+?)(?=\sCO\s*\d+\s*[:.\-–]\s|$)/g)]
      .map((m) => ({ code: `CO${Number(m[1])}`, text: squash(m[2]) }));
    if (!course_outcomes.length) warnings.push('No course outcomes (CO1, CO2, ...) were found: the HOD must resolve this before the syllabus can be activated');
    const body = /(?:Details of the Course|Detailed Syllabus)\s*:?([\s\S]*?)(?:\n\s*Total\b|11\.\s*Suggested)/.exec(clean)?.[1] || '';
    const units = parseUnits(body.replace(/^[\s\S]*?(?:Hours|Hrs|CONTENTS)\s*\n/, ''), warnings);
    if (!units.length) warnings.push('No units were found in the course details');
    units.filter((u) => u.hours == null).forEach((u) => warnings.push(`Contact hours of unit ${u.number} not found`));
    units.filter((u) => !u.topics.length).forEach((u) => warnings.push(`Unit ${u.number} has no topics`));
    const numbers = units.map((u) => u.number);
    if (numbers.some((n, i) => n !== i + 1)) warnings.push(`Unit numbering is not consecutive: ${numbers.join(', ')}`);
    const total = /\n\s*Total\s+(\d{1,3})/.exec(clean)?.[1];
    const sum = units.reduce((a, u) => a + (u.hours || 0), 0);
    if (total && units.every((u) => u.hours != null) && Number(total) !== sum) warnings.push(`Unit hours add up to ${sum}, the syllabus states a total of ${total}`);
    const endRel = clean.search(/12\.\s*Mode of Evaluation/);
    const first = pageAt(src, h.at);
    const evalAt = block.search(/12\.\s*Mode of Evaluation/);
    courses.push({
      code, title, semester: ROMAN[h.semester] || null, department: dept, category: hv.category,
      credits: null, pages: [first, pageAt(src, h.at + (evalAt >= 0 ? evalAt : block.length - 1))],
      course_outcomes, units, total_hours: total ? Number(total) : null, warnings, _evaluation_found: endRel >= 0,
    });
  });
  return courses;
}
