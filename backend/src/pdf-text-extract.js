// Text of a PDF in content-stream order, one line per baseline, "\f" between pages: the input syllabus-parse.js
// expects. Self-contained (zlib only) because uploads are parsed on the server without third-party PDF libraries.
//
// Supports what text-based syllabus PDFs use: classic objects and object streams (/ObjStm), Flate-compressed
// content, nested page trees with inherited /Resources, simple fonts (WinAnsi) and composite fonts (Type0 /
// Identity-H) with ToUnicode CMaps, the Tj, TJ, ', " text operators, and inline images (skipped).
// Scanned PDFs (pages that are only images) yield no text: the caller reports that instead of guessing (no OCR).
//
// The input is untrusted: decompression is capped per stream and in total, the object and page counts are capped,
// and every malformed construct is skipped rather than thrown. Encrypted PDFs are refused.
import zlib from 'node:zlib';

const LIMITS = { streamBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, objects: 200000, pages: 2000 };
const WIN1252 = (() => { try { return new TextDecoder('windows-1252'); } catch { return null; } })();

export class PdfError extends Error {}

// ---- A minimal PDF object parser ----
function parseValue(s, i = 0) {
  const ws = () => { while (i < s.length) { const c = s[i]; if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; } else if (/\s/.test(c)) i++; else break; } };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '<' && s[i + 1] === '<') {
      i += 2; const d = {};
      for (;;) {
        ws(); if (s[i] === '>' && s[i + 1] === '>') { i += 2; return d; }
        if (s[i] !== '/') { i++; if (i >= s.length) return d; continue; }
        const key = name(); d[key] = value();
      }
    }
    if (c === '[') { i++; const a = []; for (;;) { ws(); if (s[i] === ']') { i++; return a; } if (i >= s.length) return a; a.push(value()); } }
    if (c === '/') return { name: name() };
    if (c === '(') return { str: literal() };
    if (c === '<') { const j = s.indexOf('>', i); const hex = s.slice(i + 1, j).replace(/\s/g, ''); i = j + 1; return { str: hexBytes(hex) }; }
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:\s+(\d+)\s+R\b)?/.exec(s.slice(i, i + 40));
    if (m) { i += m[0].length; return m[2] !== undefined ? { ref: Number(m[1]) } : Number(m[1]); }
    const w = /^[A-Za-z]+/.exec(s.slice(i, i + 10)); if (w) { i += w[0].length; return w[0] === 'true' ? true : w[0] === 'false' ? false : null; }
    i++; return null;
  };
  const name = () => { i++; const st = i; while (i < s.length && !/[\s/<>[\]()%{}]/.test(s[i])) i++; return s.slice(st, i).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); };
  const literal = () => {
    i++; let depth = 1; let out = '';
    while (i < s.length) {
      const c = s[i++];
      if (c === '\\') {
        const n = s[i++];
        const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (esc[n] !== undefined) out += esc[n];
        else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(s[i])) o += s[i++]; out += String.fromCharCode(parseInt(o, 8) & 255); }
        else if (n === '\r') { if (s[i] === '\n') i++; } else if (n !== '\n') out += n;
      } else if (c === '(') { depth++; out += c; } else if (c === ')') { if (--depth === 0) break; out += c; } else out += c;
    }
    return out;
  };
  const v = value();
  return { v, end: i };
}
const hexBytes = (hex) => { let out = ''; const h = hex.length % 2 ? `${hex}0` : hex; for (let k = 0; k < h.length; k += 2) out += String.fromCharCode(parseInt(h.slice(k, k + 2), 16)); return out; };

function inflate(bytes, budget) {
  const out = zlib.inflateSync(bytes, { maxOutputLength: Math.min(LIMITS.streamBytes, budget.left) });
  budget.left -= out.length;
  if (budget.left <= 0) throw new PdfError('The PDF expands to more data than allowed');
  return out;
}

// ---- Document model ----
function loadObjects(buf) {
  const src = buf.toString('latin1');
  if (!src.startsWith('%PDF-')) throw new PdfError('Not a PDF file');
  if (/\/Encrypt\s/.test(src.slice(-4096)) || /\/Encrypt\s*\d+\s+\d+\s+R/.test(src)) throw new PdfError('Encrypted PDFs are not supported; upload an unprotected copy');
  const objs = new Map();
  const budget = { left: LIMITS.totalBytes };
  const rx = /(\d+)\s+(\d+)\s+obj\b/g;
  let m; let count = 0;
  while ((m = rx.exec(src))) {
    if (++count > LIMITS.objects) throw new PdfError('The PDF has too many objects');
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end < 0) break;
    const body = src.slice(start, end);
    const sAt = body.search(/\bstream\r?\n/);
    const dictText = sAt >= 0 ? body.slice(0, sAt) : body;
    const { v } = parseValue(dictText);
    let stream = null;
    if (sAt >= 0) {
      const dataStart = start + sAt + body.slice(sAt).match(/^stream\r?\n/)[0].length;
      let dataEnd = src.lastIndexOf('endstream', end);
      if (typeof v?.Length === 'number' && dataStart + v.Length <= end) dataEnd = dataStart + v.Length;
      stream = buf.subarray(dataStart, dataEnd);
    }
    objs.set(Number(m[1]), { v, stream });
    rx.lastIndex = end;
  }
  const doc = { objs, budget, decoded: new Map() };
  // Objects stored inside object streams.
  for (const [, o] of [...objs]) {
    if (o.v && o.v.Type?.name === 'ObjStm' && o.stream) {
      let data;
      try { data = streamData(doc, o).toString('latin1'); } catch { continue; }
      const n = Number(o.v.N) || 0; const first = Number(o.v.First) || 0;
      const head = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k < n; k++) {
        const num = head[2 * k]; const off = head[2 * k + 1];
        const nextOff = k + 1 < n ? head[2 * k + 3] : data.length - first;
        if (!objs.has(num)) objs.set(num, { v: parseValue(data.slice(first + off, first + nextOff)).v, stream: null });
      }
    }
  }
  return doc;
}
const deref = (doc, x) => { let seen = 0; while (x && typeof x === 'object' && 'ref' in x && seen++ < 32) x = doc.objs.get(x.ref)?.v ?? null; return x; };
function streamData(doc, o) {
  if (doc.decoded.has(o)) return doc.decoded.get(o);
  const f = deref(doc, o.v?.Filter);
  const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => deref(doc, x)?.name);
  let data = o.stream;
  for (const name of filters) {
    if (name === 'FlateDecode') data = inflate(data, doc.budget);
    else throw new PdfError(`unsupported filter ${name}`);
  }
  doc.decoded.set(o, data);
  return data;
}

// ---- Fonts ----
function parseCMap(text) {
  const map = new Map(); let bytes = 1;
  const u16 = (h) => { let out = ''; for (let k = 0; k + 4 <= h.length; k += 4) out += String.fromCharCode(parseInt(h.slice(k, k + 4), 16)); return out; };
  for (const b of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) { const h = /<([0-9a-fA-F]+)>/.exec(b[1]); if (h) bytes = h[1].length / 2; }
  for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(p[1], 16), u16(p[2]));
  for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const lo = parseInt(p[1], 16); const hi = Math.min(parseInt(p[2], 16), lo + 65535);
      if (p[3].startsWith('[')) [...p[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, k) => map.set(lo + k, u16(d[1])));
      else { const baseHex = p[3].slice(1, -1); const head = baseHex.slice(0, -4); const last = parseInt(baseHex.slice(-4), 16);
        for (let c = lo; c <= hi; c++) map.set(c, u16(head + (last + c - lo).toString(16).padStart(4, '0'))); }
    }
  }
  return { map, bytes };
}
function fontDecoder(doc, fontObj) {
  const font = deref(doc, fontObj) || {};
  const composite = font.Subtype?.name === 'Type0';
  let cmap = null;
  const tu = font.ToUnicode && doc.objs.get(font.ToUnicode.ref);
  if (tu?.stream) { try { cmap = parseCMap(streamData(doc, tu).toString('latin1')); } catch { cmap = null; } }
  const width = composite ? 2 : 1;
  return (raw) => {
    let out = '';
    const step = cmap?.bytes || width;
    for (let k = 0; k + step <= raw.length; k += step) {
      let code = 0; for (let b = 0; b < step; b++) code = code * 256 + raw.charCodeAt(k + b);
      if (cmap?.map.has(code)) out += cmap.map.get(code);
      else if (!composite) out += WIN1252 ? WIN1252.decode(Uint8Array.of(code)) : String.fromCharCode(code);
    }
    return out;
  };
}

// ---- Content streams ----
function tokens(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '(' || c === '[' || c === '/' || (c === '<' && s[i + 1] !== '<') || /[0-9+\-.]/.test(c)) {
      const { v, end } = parseValue(s, i); out.push({ operand: v }); i = end; continue;
    }
    if (c === '<' && s[i + 1] === '<') { const { v, end } = parseValue(s, i); out.push({ operand: v }); i = end; continue; }
    const m = /^[A-Za-z'"*]+/.exec(s.slice(i, i + 4)) || /^\S/.exec(s.slice(i, i + 1));
    const op = m[0]; i += op.length;
    if (op === 'ID') { const e = s.indexOf('EI', i); i = e < 0 ? s.length : e + 2; continue; } // inline image data
    out.push({ op });
  }
  return out;
}

function pageText(doc, page, resources) {
  const fontsDict = deref(doc, deref(doc, resources)?.Font) || {};
  const decoders = {};
  const decoderFor = (n) => (decoders[n] ||= fontDecoder(doc, fontsDict[n]));
  const contents = deref(doc, page.Contents);
  const parts = (Array.isArray(contents) ? contents : [page.Contents]).map((c) => c && doc.objs.get(c.ref)).filter((o) => o?.stream);
  let data = '';
  for (const o of parts) { try { data += `${streamData(doc, o).toString('latin1')}\n`; } catch { /* unreadable stream: skipped */ } }
  const lines = []; let line = ''; let decode = (x) => x; let lastY = null; let y = 0; let leading = 0;
  const flush = () => { const t = line.replace(/\s+$/, ''); if (t.trim()) lines.push(t.replace(/\s+/g, ' ').trim()); line = ''; };
  const moveTo = (ny) => { if (lastY !== null && Math.abs(ny - lastY) > 0.5) flush(); lastY = ny; y = ny; };
  let stack = [];
  for (const t of tokens(data)) {
    if (!t.op) { stack.push(t.operand); continue; }
    const a = stack; stack = [];
    switch (t.op) {
      case 'BT': y = 0; break;
      case 'Tf': decode = decoderFor(a[0]?.name); break;
      case 'TL': leading = Number(a[0]) || 0; break;
      case 'Td': moveTo(y + (Number(a[1]) || 0)); break;
      case 'TD': leading = -(Number(a[1]) || 0); moveTo(y + (Number(a[1]) || 0)); break;
      case 'Tm': moveTo(Number(a[5]) || 0); break;
      case 'T*': moveTo(y - leading); break;
      case 'Tj': if (a[0]?.str !== undefined) line += decode(a[0].str); break;
      case "'": moveTo(y - leading); if (a[0]?.str !== undefined) line += decode(a[0].str); break;
      case '"': moveTo(y - leading); if (a[2]?.str !== undefined) line += decode(a[2].str); break;
      case 'TJ':
        for (const e of Array.isArray(a[0]) ? a[0] : []) {
          if (e?.str !== undefined) line += decode(e.str);
          else if (typeof e === 'number' && e < -180 && !/\s$/.test(line)) line += ' '; // a wide gap is a word space
        }
        break;
      default: break;
    }
  }
  flush();
  return lines.join('\n');
}

function pages(doc) {
  const trailerRoot = [...doc.objs.values()].find((o) => o.v?.Type?.name === 'Catalog');
  const root = trailerRoot?.v;
  if (!root) throw new PdfError('The PDF has no document catalog');
  const out = [];
  const walk = (nodeRef, inherited, depth) => {
    if (depth > 64 || out.length > LIMITS.pages) return;
    const node = deref(doc, nodeRef);
    if (!node) return;
    const resources = node.Resources ?? inherited;
    if (node.Type?.name === 'Pages' || Array.isArray(deref(doc, node.Kids))) {
      for (const kid of deref(doc, node.Kids) || []) walk(kid, resources, depth + 1);
    } else out.push({ page: node, resources });
  };
  walk(root.Pages, null, 0);
  if (out.length > LIMITS.pages) throw new PdfError(`The PDF has more than ${LIMITS.pages} pages`);
  return out;
}

// Returns { text, pages, pagesWithText }.
export function extractPdfText(buf) {
  const doc = loadObjects(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const list = pages(doc);
  const texts = list.map(({ page, resources }) => { try { return pageText(doc, page, resources); } catch (e) { if (e instanceof PdfError) throw e; return ''; } });
  return { text: texts.join('\n\f'), pages: list.length, pagesWithText: texts.filter((t) => t.trim()).length };
}
