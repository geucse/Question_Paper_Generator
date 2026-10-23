// Test helper: the text drawn by a pdfkit PDF, in drawing order (no PDF library needed). pdfkit writes text as hex
// strings inside TJ arrays in Flate-compressed content streams: standard fonts in WinAnsi bytes, embedded fonts
// (the Unicode fallback in paper-pdf.js) as 2-byte glyph ids that the font's ToUnicode CMap maps back to text.
// Used by the unit tests (test-paper-sections.mjs, test-paper-output.mjs, test-paper-template.mjs), the route test
// and the real-Postgres smoke test.
import zlib from 'node:zlib';

const WIN_ANSI = { 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—' };

function streamBody(buf, s, start) {
  const raw = buf.subarray(start, s.indexOf('endstream', start));
  try { return zlib.inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); }
}

// Font resource name (F1, F2, ...) -> Map(glyph code -> text) for every embedded font with a ToUnicode CMap.
function unicodeFonts(buf) {
  const s = buf.toString('latin1');
  const objs = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) objs.set(m[1], { body: m[2], at: m.index + m[0].indexOf(m[2]) });
  const names = new Map();
  for (const m of s.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) for (const r of m[1].matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) names.set(r[1], r[2]);
  const out = new Map();
  for (const [name, num] of names) {
    const ref = /\/ToUnicode\s+(\d+) 0 R/.exec(objs.get(num)?.body || '');
    const cm = ref && objs.get(ref[1]);
    if (!cm) continue;
    const st = s.indexOf('stream', cm.at);
    const nl = s.slice(st, st + 8).match(/^stream\r?\n/);
    const body = streamBody(buf, s, st + nl[0].length);
    const map = new Map();
    const u16 = (h) => String.fromCharCode(...(h.match(/.{4}/g) || []).map((x) => parseInt(x, 16)));
    for (const b of body.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1], 16), u16(p[2]));
    for (const b of body.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
        const lo = parseInt(p[1], 16); const hi = parseInt(p[2], 16);
        if (p[3].startsWith('[')) [...p[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, i) => map.set(lo + i, u16(d[1])));
        else { const base = parseInt(p[3].slice(1, -1), 16); for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + c - lo)); }
      }
    }
    out.set(name, map);
  }
  return out;
}

// The text runs of one content stream, decoding each TJ with the font selected by the last Tf.
function streamRuns(body, fonts) {
  const runs = []; let font = null;
  for (const m of body.matchAll(/\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ/g)) {
    if (m[1]) { font = m[1]; continue; }
    const map = fonts.get(font);
    runs.push([...m[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => (map
      ? (h[1].match(/.{4}/g) || []).map((g) => map.get(parseInt(g, 16)) ?? '\uFFFD').join('')
      : [...Buffer.from(h[1], 'hex')].map((b) => WIN_ANSI[b] || String.fromCharCode(b)).join(''))).join(''));
  }
  return runs;
}

function contentStreams(buf) {
  const s = buf.toString('latin1'); const fonts = unicodeFonts(buf); const out = [];
  for (const m of s.matchAll(/(?<!end)stream\r?\n/g)) out.push(streamRuns(streamBody(buf, s, m.index + m[0].length), fonts));
  return out;
}

export function pdfTextRuns(buf) {
  return contentStreams(buf).flat();
}

export const pdfText = (buf) => pdfTextRuns(buf).join('\n').replace(/\s+/g, ' ');

// Per page: the text of each page content stream (pdfkit writes one content stream per page), and the number of
// page objects, so a test can check that something (the DRAFT banner) is on EVERY page.
export function pdfPages(buf) {
  const s = buf.toString('latin1');
  const pageCount = [...s.matchAll(/\/Type \/Page(?!s)\b/g)].length;
  const texts = contentStreams(buf).filter((runs) => runs.length).map((runs) => runs.join(' ').replace(/\s+/g, ' '));
  return { pageCount, texts };
}
