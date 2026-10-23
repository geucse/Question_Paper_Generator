// COE paper generator (PIVOT_SPEC_V2 sections 22-25).
// Hard constraints are enforced in SQL (eligibility) and in code (counts, marks,
// duplicates, sections, CO and Bloom targets); soft constraints only influence scoring.
// If a hard constraint cannot be met the generator fails with reasons and creates nothing.
// CO/Bloom targets are never relaxed silently: only by a recorded COE override that is
// necessary (strict generation failed) and minimal (planSelection).
import crypto from 'crypto';
import { all, withTransaction } from './db.js';
import { QUESTION_TYPE_CODES, normalizeQuestionType, typeLabel, validateQuestionByType } from './question-types.js';
import { LIVE_PAPER_STATUSES } from './paper-policy.js';
import { BLOOM_LEVELS } from './taxonomy.js';

// 2.1: partial Bloom percentages use largest-remainder counts (bloomTargetCounts), internal choices.
export const GENERATOR_VERSION = 'coe-gen-2.1';

// code: CONFIG | LEGACY_BLUEPRINT | INVENTORY | INFEASIBLE | SEARCH_LIMIT | OVERRIDE_INVALID |
// OVERRIDE_NOT_NEEDED | OVERRIDE_NOT_MINIMAL | VALIDATION_FAILED. Always a 422: the blueprint or the bank must change.
export class GenerationError extends Error {
  constructor(reasons, code = 'GENERATION_FAILED') {
    super('Paper cannot be generated');
    this.reasons = Array.isArray(reasons) ? reasons : [reasons];
    this.code = code;
  }
}

// A transient conflict with another operation (409): the same request can succeed once it is retried or reloaded.
export class GenerationConflict extends Error {
  constructor(message, { reasons = [], details = {} } = {}) {
    super(message);
    this.reasons = reasons;
    this.details = details;
  }
}

// Deterministic PRNG from a string seed => reproducible generation (spec 24).
export function rngFromSeed(seed) {
  let a = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIFFS = ['easy', 'medium', 'hard'];
const lc = (v) => (v == null ? null : String(v).toLowerCase());
const num = (v) => (v == null ? 0 : Number(v));

export function requiredCounts(bp) {
  return { easy: num(bp.easy_count), medium: num(bp.medium_count), hard: num(bp.hard_count) };
}

// ---------- Blueprint rules ----------
// Sections (persisted on the blueprint): [{ name, question_count, marks_per_question?, total_marks?,
// question_types?: [...], easy?, medium?, hard?, instructions?, attempt_count? }]. A blueprint without
// sections is one implicit unnamed section holding every question (previous behaviour).
// attempt_count k = internal choice "attempt any k of the section's questions"; it needs marks_per_question,
// and the section's total_marks (like the blueprint's) then means marks COUNTED, i.e. what a candidate can score.
export function normalizeSections(bp) {
  const need = requiredCounts(bp);
  const raw = Array.isArray(bp.sections) ? bp.sections : (typeof bp.sections === 'string' ? JSON.parse(bp.sections || '[]') : []);
  if (!raw.length) return [{ name: null, index: 0, question_count: need.easy + need.medium + need.hard, types: null, mpq: null, total: null, diff: null }];
  return raw.map((x, i) => {
    const hasDiff = ['easy', 'medium', 'hard'].some((d) => x[d] != null && x[d] !== '');
    return {
      name: String(x.name || `Section ${String.fromCharCode(65 + i)}`), index: i,
      instructions: x.instructions ? String(x.instructions).trim() || null : null,
      question_count: num(x.question_count),
      types: Array.isArray(x.question_types) && x.question_types.length ? x.question_types.map(normalizeQuestionType) : null,
      mpq: x.marks_per_question == null || x.marks_per_question === '' ? null : num(x.marks_per_question),
      total: x.total_marks == null || x.total_marks === '' ? null : num(x.total_marks),
      diff: hasDiff ? { easy: num(x.easy), medium: num(x.medium), hard: num(x.hard) } : null,
      attempt: x.attempt_count == null || x.attempt_count === '' ? null : num(x.attempt_count),
    };
  });
}

const SECTION_KEYS = ['name', 'question_count', 'marks_per_question', 'total_marks', 'question_types', 'easy', 'medium', 'hard', 'instructions', 'attempt_count'];
// What a blueprint stores: known keys only, blanks dropped (this is what format_config later freezes).
export function sanitizeSections(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.map((x) => Object.fromEntries(SECTION_KEYS.filter((k) => x?.[k] != null && x[k] !== '')
    .map((k) => [k, k === 'name' || k === 'instructions' ? String(x[k]).trim() : x[k]])));
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;

// Configuration errors that make a blueprint impossible regardless of the question bank.
export function blueprintConfigErrors(bp) {
  const errors = [];
  const need = requiredCounts(bp);
  const n = need.easy + need.medium + need.hard;
  let sections;
  try { sections = normalizeSections(bp); } catch { return ['sections must be a JSON array']; }
  const names = new Set();
  // Marks a section counts towards the total (an internal choice counts attempt_count questions).
  const countedOf = (s) => (s.total != null ? s.total : (s.attempt ?? s.question_count) * s.mpq);
  for (const s of sections) {
    const label = s.name || 'Paper';
    if (s.name != null) { if (names.has(s.name.toLowerCase())) errors.push(`Duplicate section name "${s.name}"`); names.add(s.name.toLowerCase()); }
    if (s.name && s.name.length > 60) errors.push(`${label}: name must be at most 60 characters`);
    if (s.instructions && s.instructions.length > 500) errors.push(`${label}: instructions must be at most 500 characters`);
    if (!Number.isInteger(s.question_count) || s.question_count <= 0) errors.push(`${label}: question_count must be a positive whole number`);
    if (s.types && s.types.some((t) => !t)) errors.push(`${label}: question_types must be from: ${QUESTION_TYPE_CODES.join(', ')}`);
    if (s.mpq != null && !isPosInt(s.mpq)) errors.push(`${label}: marks_per_question must be a positive whole number`);
    if (s.total != null && !isPosInt(s.total)) errors.push(`${label}: total_marks must be a positive whole number`);
    if (s.diff && DIFFS.some((d) => !Number.isInteger(s.diff[d]) || s.diff[d] < 0)) errors.push(`${label}: easy/medium/hard must be non-negative whole numbers`);
    if (s.diff && s.diff.easy + s.diff.medium + s.diff.hard !== s.question_count) errors.push(`${label}: easy+medium+hard (${s.diff.easy + s.diff.medium + s.diff.hard}) must equal question_count (${s.question_count})`);
    if (s.attempt != null) {
      if (!isPosInt(s.attempt)) errors.push(`${label}: attempt_count must be a positive whole number`);
      else if (s.attempt >= s.question_count) errors.push(`${label}: "attempt any ${s.attempt}" must be fewer than the section's ${s.question_count} question(s); leave it blank when every question must be answered`);
      if (s.mpq == null) errors.push(`${label}: an internal choice needs marks_per_question, so the marks counted are the same whichever questions a candidate answers`);
    }
    const counted = s.attempt ?? s.question_count;
    if (s.mpq != null && s.total != null && counted * s.mpq !== s.total) {
      errors.push(s.attempt != null ? `${label}: attempt any ${s.attempt} × ${s.mpq} marks ≠ section total ${s.total}` : `${label}: ${s.question_count} × ${s.mpq} marks ≠ section total ${s.total}`);
    }
    if (s.total != null && s.mpq == null && s.total < s.question_count) errors.push(`${label}: ${s.total} marks cannot hold ${s.question_count} questions (each needs at least 1 mark)`);
  }
  const slots = sections.reduce((a, s) => a + s.question_count, 0);
  if (slots !== n) errors.push(`Sections hold ${slots} question(s) but easy+medium+hard is ${n}`);
  if (sections.every((s) => s.diff)) {
    for (const d of DIFFS) {
      const sum = sections.reduce((a, s) => a + s.diff[d], 0);
      if (sum !== need[d]) errors.push(`Section ${d} counts add up to ${sum} but the blueprint asks for ${need[d]} ${d}`);
    }
  } else if (sections.some((s) => s.diff)) {
    for (const d of DIFFS) {
      const sum = sections.reduce((a, s) => a + (s.diff ? s.diff[d] : 0), 0);
      if (sum > need[d]) errors.push(`Sections fix ${sum} ${d} question(s) but the blueprint asks for only ${need[d]} ${d}`);
    }
  }
  const T = bp.total_marks != null && bp.total_marks !== '' ? num(bp.total_marks) : null;
  if (T != null && !isPosInt(T)) errors.push('total_marks must be a positive whole number');
  if (T != null && sections.every((s) => s.total != null || s.mpq != null)) {
    const fixed = sections.reduce((a, s) => a + countedOf(s), 0);
    if (fixed !== T) errors.push(`Section marks add up to ${fixed} but total_marks is ${T}`);
  } else if (T != null && sections.some((s) => s.total != null || s.mpq != null)) {
    // Questions of the other sections need at least 1 mark each.
    const fixed = sections.filter((s) => s.total != null || s.mpq != null).reduce((a, s) => a + countedOf(s), 0);
    const rest = sections.filter((s) => s.total == null && s.mpq == null).reduce((a, s) => a + s.question_count, 0);
    if (fixed + rest > T) errors.push(`Section marks fix ${fixed} mark(s) and the other ${rest} question(s) need at least 1 mark each, more than total_marks ${T}`);
  }
  const co = bp.co_distribution || {};
  for (const [c, v] of Object.entries(co)) {
    if (!Number.isInteger(Number(v)) || Number(v) < 0) errors.push(`CO target ${c} must be a non-negative whole number`);
    else if (Number(v) > n) errors.push(`CO target ${c}=${v} exceeds the ${n} questions in the paper`);
  }
  const bl = bp.bloom_distribution || {};
  let pct = 0; const levels = new Set();
  for (const [lvl, v] of Object.entries(bl)) {
    if (!BLOOMS.includes(lc(lvl))) errors.push(`Unknown Bloom level "${lvl}"`);
    if (levels.has(lc(lvl))) errors.push(`Bloom level "${lvl}" is listed twice`);
    levels.add(lc(lvl));
    if (!(Number(v) >= 0 && Number(v) <= 100)) errors.push(`Bloom target ${lvl} must be a percentage from 0 to 100`);
    pct += Number(v) || 0;
  }
  if (pct > 100.0001) errors.push(`Bloom percentages add up to ${pct}%, more than 100%`);
  else if (!errors.length && n > 0) {
    const counts = Object.values(bloomTargetCounts(bl, n).targets).reduce((a, b) => a + b, 0);
    if (counts > n) errors.push(`Bloom targets resolve to ${counts} question(s) but the paper has ${n}`); // bloomTargetCounts guarantees <= n
  }
  return errors;
}

// Non-blocking notes on how targets resolve (shown at save, in feasibility and in the blueprint view).
export function blueprintTargetNotes(bp) {
  const need = requiredCounts(bp); const n = need.easy + need.medium + need.hard;
  const { targets } = bloomTargetCounts(bp.bloom_distribution, n);
  return Object.entries(bp.bloom_distribution || {}).filter(([k, v]) => Number(v) > 0 && targets[lc(k)] === 0)
    .map(([k, v]) => `Bloom ${lc(k)} ${v}% of ${n} question(s) resolves to 0 questions`);
}

export const hasTargets = (bp, dim) => Object.keys((dim === 'co' ? bp?.co_distribution : bp?.bloom_distribution) || {}).length > 0;

// A pre-037 (hard_targets = FALSE) version with CO/Bloom targets is refused, never softened: its targets were saved
// as advisory, and enforcing or relaxing them silently would both reinterpret what the COE saved.
export function legacyTargetError(bp) {
  if (!bp || bp.hard_targets || !(hasTargets(bp, 'co') || hasTargets(bp, 'bloom'))) return null;
  return `Blueprint v${bp.version_number} was saved before targets became exact (legacy soft targets). Its CO/Bloom targets would only be advisory, which is no longer allowed. Use "Copy into editor" and save it as a new version: the targets will then be enforced exactly, or relaxed only by a recorded override.`;
}

// CO keys must be active course outcomes of the examination's syllabus version. Matched case-insensitively and
// stored as the canonical code. Returns { value, errors }.
export function normalizeCoDistribution(raw, codes) {
  const entries = Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  if (!entries.length) return { value: null, errors: [] };
  const byLc = new Map(codes.map((c) => [String(c).toLowerCase(), c]));
  const value = {}; const from = {}; const errors = [];
  for (const [k, v] of entries) {
    const key = String(k).trim();
    const canon = byLc.get(key.toLowerCase());
    if (!canon) { errors.push(`${key} is not an active course outcome of this examination's syllabus version (active: ${codes.join(', ') || 'none'})`); continue; }
    if (canon in value) { errors.push(`CO targets "${from[canon]}" and "${key}" name the same course outcome ${canon}`); continue; }
    value[canon] = v; from[canon] = key;
  }
  return { value, errors };
}

// Re-checked at generate/regenerate/feasibility: a CO deactivated after the blueprint was saved.
export function blueprintContextErrors(bp, codes) {
  return Object.keys(bp?.co_distribution || {}).filter((k) => !codes.includes(k))
    .map((k) => `${k} is not an active course outcome of this examination's syllabus version (active: ${codes.join(', ') || 'none'}); save a new blueprint version`);
}

// The targets a paper was generated against (snapshotted in candidate_metrics.targets, frozen by 039).
export function resolvedTargets(bp) {
  const need = requiredCounts(bp); const n = need.easy + need.medium + need.hard;
  const bl = hasTargets(bp, 'bloom') ? bloomTargetCounts(bp.bloom_distribution, n) : null;
  return {
    mode: bp.hard_targets ? 'hard' : 'legacy_soft',
    co: hasTargets(bp, 'co') ? Object.fromEntries(Object.entries(bp.co_distribution).map(([k, v]) => [k, Number(v)])) : null,
    bloom: bl ? bl.targets : null, bloom_percentages: bl ? bp.bloom_distribution : null, bloom_complete: bl ? bl.complete : null,
  };
}

const BLOOMS = BLOOM_LEVELS;

// Bloom % -> exact counts by largest remainder. When the percentages add up to 100 the counts add up to n
// exactly and every unlisted level gets 0. Below 100 the listed levels get round(sum% × n) questions in total
// (never more than n) and the unlisted levels are free.
export function bloomTargetCounts(bloomDistribution, n) {
  const entries = Object.entries(bloomDistribution || {}).map(([k, v]) => [lc(k), Number(v) || 0]);
  if (!entries.length) return { targets: {}, complete: false };
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const complete = Math.abs(total - 100) < 1e-6;
  const raw = entries.map(([k, v]) => ({ k, exact: (v / 100) * n }));
  const want = complete ? n : Math.min(n, Math.round((total / 100) * n + 1e-9));
  const targets = {};
  raw.forEach((r) => { targets[r.k] = Math.floor(r.exact + 1e-9); });
  let left = want - Object.values(targets).reduce((a, b) => a + b, 0);
  raw.slice().sort((a, b) => (b.exact - Math.floor(b.exact + 1e-9)) - (a.exact - Math.floor(a.exact + 1e-9)) || a.k.localeCompare(b.k))
    .forEach((r) => { if (left > 0) { targets[r.k] += 1; left -= 1; } });
  if (complete) BLOOMS.forEach((b) => { if (targets[b] == null) targets[b] = 0; });
  return { targets, complete };
}

// Soft penalty: lower is better.
export function scoreSelection(selected, bp, recentIds) {
  let pen = 0;
  const co = {}; const bloom = {}; const topics = {};
  for (const q of selected) {
    (q.cos || []).forEach((c) => { co[c] = (co[c] || 0) + 1; });
    if (q.bloom) bloom[lc(q.bloom)] = (bloom[lc(q.bloom)] || 0) + 1;
    const t = q.topic || '';
    topics[t] = (topics[t] || 0) + 1;
    pen += num(q.times_used) * 0.5;
    if (recentIds.has(q.id)) pen += 5;
  }
  const n = selected.length || 1;
  const coTarget = bp.co_distribution || {};
  for (const [c, want] of Object.entries(coTarget)) pen += Math.abs((co[c] || 0) - Number(want)) * 3;
  if (!Object.keys(coTarget).length) pen -= Object.keys(co).length; // reward spread
  const { targets } = bloomTargetCounts(bp.bloom_distribution, n);
  for (const [lvl, want] of Object.entries(targets)) pen += Math.abs((bloom[lvl] || 0) - want) * 2;
  for (const k of Object.values(topics)) if (k > 1) pen += (k - 1) * 1.5; // topic diversity
  return pen;
}

function reasonFor(q, bp, recentIds, section) {
  const parts = [section?.name || null, typeLabel(normalizeQuestionType(q.question_type)), `${lc(q.difficulty)}`, q.bloom ? lc(q.bloom) : null];
  const coT = bp.co_distribution || {};
  const hit = (q.cos || []).filter((c) => coT[c]);
  if (hit.length) parts.push(`${hit.join('/')} required`);
  else if ((q.cos || []).length) parts.push((q.cos || []).join('/'));
  if (q.topic) parts.push(q.topic);
  parts.push(num(q.times_used) === 0 ? 'never used' : recentIds.has(q.id) ? 'used recently (soft penalty)' : 'not used recently');
  return parts.filter(Boolean).join(' | ');
}

// Which targets are hard for this generation: CO/Bloom targets are enforced exactly unless the COE recorded an
// override for that dimension. Legacy (hard_targets = FALSE) versions with targets are refused before this
// (legacyTargetError), never softened; a legacy version without targets has nothing to enforce.
export function hardTargetModes(bp, override) {
  const relax = new Set((override?.relax || []).map(lc));
  return { co: !relax.has('co'), bloom: !relax.has('bloom') };
}

const popcount = (m) => { let c = 0; for (; m; m &= m - 1) c++; return c; };

const NODE_LIMIT = 60000;   // per depth-first restart; small or tight banks are decided (solved or proven impossible) here
const RESTARTS = 4;
const LS_RESTARTS = 12;    // local search, for large banks where depth-first search runs out of budget
const LS_STEPS = 3000;
const LS_SAMPLE = 80;      // candidates examined per step

// Pure selection. pool: eligible questions (already ACTIVE, right context, not reserved elsewhere).
// Every hard rule is a constraint of an exact search: sections (count, types, marks), difficulty counts,
// total marks, distinct canonical questions and, when hard, CO counts and Bloom counts. Soft rules
// (usage, recency, topic spread, soft CO/Bloom) only rank the solutions found.
export function selectQuestions(pool, bp, seed, recentIds = new Set(), { override = null } = {}) {
  const need = requiredCounts(bp);
  const total = need.easy + need.medium + need.hard;
  if (total <= 0) throw new GenerationError('Blueprint defines no questions (easy/medium/hard counts are all 0)', 'CONFIG');
  const config = blueprintConfigErrors(bp);
  if (config.length) throw new GenerationError(config, 'CONFIG');
  const legacy = legacyTargetError(bp);
  if (legacy) throw new GenerationError(legacy, 'LEGACY_BLUEPRINT');

  const sections = normalizeSections(bp);
  const hard = hardTargetModes(bp, override);
  const coT = hard.co ? Object.fromEntries(Object.entries(bp.co_distribution || {}).map(([k, v]) => [k, Number(v)])) : {};
  const { targets: bloomAll, complete: bloomComplete } = bloomTargetCounts(bp.bloom_distribution, total);
  const blT = hard.bloom ? bloomAll : {};
  // The search works on PRINTED marks: an internal choice prints (n - k) questions more than it counts.
  const surplus = sections.reduce((a, s) => a + (s.attempt != null ? (s.question_count - s.attempt) * s.mpq : 0), 0);
  const T = bp.total_marks != null ? Number(bp.total_marks) + surplus : null;

  const fits = (q, s) => (!s.types || s.types.includes(normalizeQuestionType(q.question_type))) && (s.mpq == null || num(q.marks) === s.mpq);

  // ---- Feasibility checks that name the missing inventory, before any search ----
  const reasons = [];
  const byDiff = {};
  for (const d of DIFFS) {
    byDiff[d] = pool.filter((q) => lc(q.difficulty) === d);
    if (byDiff[d].length < need[d]) {
      reasons.push(`Need ${need[d]} ${d.toUpperCase()} question(s) but only ${byDiff[d].length} eligible ACTIVE question(s) exist for this exam's campus, program, subject and syllabus version`);
    }
  }
  for (const s of sections) {
    if (!s.name) continue;
    const cand = pool.filter((q) => fits(q, s));
    const what = [s.types ? `type ${s.types.join('/')}` : null, s.mpq != null ? `${s.mpq} marks` : null].filter(Boolean).join(', ') || 'any type';
    if (cand.length < s.question_count) reasons.push(`${s.name}: needs ${s.question_count} question(s) (${what}) but only ${cand.length} eligible`);
    if (s.diff) for (const d of DIFFS) {
      const k = cand.filter((q) => lc(q.difficulty) === d).length;
      if (k < s.diff[d]) reasons.push(`${s.name}: needs ${s.diff[d]} ${d} question(s) (${what}) but only ${k} eligible`);
    }
    // A section total without marks each: some question_count distinct questions must add up to it exactly.
    if (cand.length >= s.question_count && s.total != null && s.mpq == null && s.attempt == null) {
      const reach = Array.from({ length: s.question_count + 1 }, () => new Set()); reach[0].add(0); const seen = new Set();
      for (const q of cand) {
        const k = q.canonical_question_id || q.id; if (seen.has(k)) continue; seen.add(k); const m = num(q.marks);
        for (let c = Math.min(s.question_count, seen.size); c >= 1; c--) for (const v of reach[c - 1]) if (v + m <= s.total) reach[c].add(v + m);
      }
      if (!reach[s.question_count].has(s.total)) reasons.push(`${s.name}: no ${s.question_count} eligible question(s) (${what}) add up to the section total of ${s.total} marks`);
    }
  }
  // Sections compete for the same questions: every group of sections needs enough DIFFERENT questions that fit
  // one of them (per difficulty when each fixes a split). Only checked when each section passes on its own;
  // only the smallest failing groups are reported.
  const named = sections.filter((s) => s.name);
  if (!reasons.length && named.length >= 2 && named.length <= 8) {
    const keyOf = (q) => q.canonical_question_id || q.id; const failed = [];
    const masks = [...Array(1 << named.length).keys()].filter((m) => m & (m - 1)).sort((a, b) => popcount(a) - popcount(b) || a - b);
    for (const mask of masks) {
      if (failed.some((f) => (mask & f) === f)) continue;
      const g = named.filter((_, i) => mask & (1 << i)); const label = g.map((s) => s.name).join(' + ');
      const want = g.reduce((a, s) => a + s.question_count, 0);
      const have = new Set(pool.filter((q) => g.some((s) => fits(q, s))).map(keyOf)).size;
      if (have < want) { reasons.push(`${label}: need ${want} different question(s) together but only ${have} eligible question(s) fit these sections`); failed.push(mask); continue; }
      if (g.every((s) => s.diff)) for (const d of DIFFS) {
        const w = g.reduce((a, s) => a + s.diff[d], 0); if (!w) continue;
        const h = new Set(pool.filter((q) => lc(q.difficulty) === d && g.some((s) => s.diff[d] > 0 && fits(q, s))).map(keyOf)).size;
        if (h < w) { reasons.push(`${label}: need ${w} ${d} question(s) together but only ${h} eligible ${d} question(s) fit these sections`); failed.push(mask); break; }
      }
    }
  }
  for (const [c, want] of Object.entries(coT)) {
    const k = pool.filter((q) => (q.cos || []).includes(c)).length;
    if (k < want) reasons.push(`CO target ${c}=${want} but only ${k} eligible question(s) map to ${c}`);
  }
  for (const [lvl, want] of Object.entries(blT)) {
    const k = pool.filter((q) => lc(q.bloom) === lvl).length;
    if (k < want) reasons.push(`Bloom target ${lvl}=${want} but only ${k} eligible question(s) are ${lvl}`);
  }
  if (reasons.length) throw new GenerationError(reasons, 'INVENTORY');

  // ---- Exact search ----
  const slots = [];
  sections.forEach((s) => { for (let i = 0; i < s.question_count; i++) slots.push(s); });
  const rngBase = rngFromSeed(seed);
  const solutions = [];
  let range = null; let exhausted = true;

  for (let r = 0; r < RESTARTS; r++) {
    const rng = rngFromSeed(`${seed}:${r}:${rngBase()}`);
    // Seeded order, biased towards rarely/never used questions (soft).
    const order = pool.map((q) => ({ q, k: rng() * 3 + num(q.times_used) * 0.3 + (recentIds.has(q.id) ? 2 : 0) }))
      .sort((x, y) => x.k - y.k).map((x) => x.q);
    const cand = sections.map((s) => order.filter((q) => fits(q, s)));
    // Marks bounds per remaining slot, for pruning towards the exact total.
    const mm = sections.map((s, i) => {
      const m = cand[i].map((q) => num(q.marks));
      return { min: m.length ? Math.min(...m) : 0, max: m.length ? Math.max(...m) : 0 };
    });
    const remMin = new Array(slots.length + 1).fill(0); const remMax = new Array(slots.length + 1).fill(0);
    for (let i = slots.length - 1; i >= 0; i--) { remMin[i] = remMin[i + 1] + mm[slots[i].index].min; remMax[i] = remMax[i + 1] + mm[slots[i].index].max; }
    if (!range) range = [remMin[0], remMax[0]];

    const picked = []; const usedCanon = new Set();
    const diffLeft = { ...need };
    const secDiffLeft = sections.map((s) => (s.diff ? { ...s.diff } : null));
    const secMarks = sections.map(() => 0);
    const secLeft = sections.map((s) => s.question_count);
    const coCount = {}; const blCount = {};
    let marks = 0; let nodes = 0; let found = null;

    const dfs = (i, lastIdx) => {
      if (found || nodes > NODE_LIMIT) return;
      if (i === slots.length) {
        if (T != null && marks !== T) return;
        found = picked.slice(); return;
      }
      const s = slots[i]; const si = s.index;
      const start = i > 0 && slots[i - 1].index === si ? lastIdx + 1 : 0; // combinations, not permutations, within a section
      const remainingSlots = slots.length - i - 1;
      for (let c = start; c < cand[si].length; c++) {
        nodes++;
        if (nodes > NODE_LIMIT) { exhausted = false; return; }
        const q = cand[si][c];
        const key = q.canonical_question_id || q.id;
        const d = lc(q.difficulty);
        if (usedCanon.has(key) || !(diffLeft[d] > 0)) continue;
        if (secDiffLeft[si] && !(secDiffLeft[si][d] > 0)) continue;
        const m = num(q.marks);
        if (T != null) {
          const after = marks + m;
          if (after + remMin[i + 1] > T || after + remMax[i + 1] < T) continue;
        }
        // A choice section's marks are fixed by marks_per_question; its total is marks counted, not printed.
        if (s.total != null && s.attempt == null) {
          const left = secLeft[si] - 1; const after = secMarks[si] + m;
          if (left === 0 ? after !== s.total : (after + left * mm[si].min > s.total || after + left * mm[si].max < s.total)) continue;
        }
        const qcos = (q.cos || []).filter((x) => coT[x] != null);
        if (qcos.some((x) => (coCount[x] || 0) + 1 > coT[x])) continue;
        const b = lc(q.bloom);
        if (Object.keys(blT).length) {
          if (blT[b] != null) { if ((blCount[b] || 0) + 1 > blT[b]) continue; } else if (bloomComplete) continue;
        }
        // apply
        picked.push({ q, s }); usedCanon.add(key); diffLeft[d]--; if (secDiffLeft[si]) secDiffLeft[si][d]--;
        marks += m; secMarks[si] += m; secLeft[si]--;
        qcos.forEach((x) => { coCount[x] = (coCount[x] || 0) + 1; }); if (blT[b] != null) blCount[b] = (blCount[b] || 0) + 1;
        // prune: what is still required must fit in the slots that are left
        let ok = true;
        for (const [x, want] of Object.entries(coT)) if (want - (coCount[x] || 0) > remainingSlots) { ok = false; break; }
        if (ok && Object.keys(blT).length) {
          const left = Object.entries(blT).reduce((a, [x, want]) => a + (want - (blCount[x] || 0)), 0);
          if (left > remainingSlots || (bloomComplete && left !== remainingSlots)) ok = false;
        }
        if (ok) dfs(i + 1, c);
        // undo
        picked.pop(); usedCanon.delete(key); diffLeft[d]++; if (secDiffLeft[si]) secDiffLeft[si][d]++;
        marks -= m; secMarks[si] -= m; secLeft[si]++;
        qcos.forEach((x) => { coCount[x] -= 1; }); if (blT[b] != null) blCount[b] -= 1;
        if (found || nodes > NODE_LIMIT) return;
      }
    };
    dfs(0, -1);
    if (found) solutions.push(found);
    else if (exhausted) break; // the full search space was explored: no solution exists, restarts can't help
  }

  // ---- Local search (min-conflicts with seeded noise) when depth-first search ran out of budget ----
  if (!solutions.length && !exhausted) {
    const found = localSearch({ pool, sections, need, T, coT, blT, fits, seed, recentIds });
    if (found) solutions.push(found);
  }

  if (!solutions.length) {
    const what = [T != null ? `exactly ${T - surplus} marks${surplus ? ` (${T} printed, with internal choices)` : ''}` : null, sections.some((x) => x.name) ? 'the section rules' : null,
      Object.keys(coT).length ? 'the CO targets' : null, Object.keys(blT).length ? 'the Bloom targets' : null].filter(Boolean);
    const msg = T != null && !Object.keys(coT).length && !Object.keys(blT).length && !sections.some((x) => x.name)
      ? `No combination of eligible ACTIVE questions adds up to ${T} marks (these questions can only reach ${range ? `${range[0]}-${range[1]}` : 'none'} in total, and not every value in between). Add questions with suitable marks or revise the blueprint.`
      : `No combination of eligible ACTIVE questions satisfies all hard constraints together (difficulty counts${what.length ? ', ' + what.join(', ') : ''})`
        + (exhausted ? '. Every combination was checked.' : '. The search limit was reached before a combination was found.')
        + ' Add questions that fit, revise the blueprint, or (for CO/Bloom targets only) record an override with a reason.';
    throw new GenerationError(msg, exhausted ? 'INFEASIBLE' : 'SEARCH_LIMIT');
  }

  const scored = solutions.map((sol) => ({ sol, score: scoreSelection(sol.map((x) => x.q), bp, recentIds) }));
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];
  // Order: by section, then easy -> medium -> hard; numbering 1..n across the paper.
  const rank = { easy: 0, medium: 1, hard: 2 };
  const ordered = best.sol.slice().sort((a, b) => a.s.index - b.s.index || rank[lc(a.q.difficulty)] - rank[lc(b.q.difficulty)]);
  return {
    score: best.score,
    questions: ordered.map(({ q, s }, i) => ({
      ...q, slot_number: i + 1, section_name: s.name, section_index: s.name ? s.index : null,
      selection_reason: reasonFor(q, bp, recentIds, s),
    })),
  };
}

// Local search over complete selections. Cost = total violation of the hard rules (0 = valid), kept
// incrementally so each candidate swap is evaluated in O(#COs). Fully deterministic for a seed: the
// budget is a fixed number of steps and sampled candidates, never wall-clock time.
function localSearch({ pool, sections, need, T, coT, blT, fits, seed, recentIds }) {
  const cands = sections.map((s) => pool.filter((q) => fits(q, s)));
  const keyOf = (q) => q.canonical_question_id || q.id;
  const tco = (q) => (q.cos || []).filter((c) => coT[c] != null);
  const absd = (x) => (x < 0 ? -x : x);
  const hasBl = Object.keys(blT).length > 0;

  for (let r = 0; r < LS_RESTARTS; r++) {
    const rng = rngFromSeed(`${seed}:ls:${r}`);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const used = new Set(); const sel = sections.map(() => []);
    let ok = true;
    sections.forEach((s, si) => {
      const wants = s.diff ? DIFFS.flatMap((d) => Array(s.diff[d]).fill(d)) : Array(s.question_count).fill(null);
      for (const d of wants) {
        const opts = cands[si].filter((q) => !used.has(keyOf(q)) && (!d || lc(q.difficulty) === d));
        if (!opts.length) { ok = false; return; }
        const q = pick(opts); sel[si].push(q); used.add(keyOf(q));
      }
    });
    if (!ok) return null;

    // counters
    const diff = { easy: 0, medium: 0, hard: 0 }; const co = {}; const bl = {}; let marks = 0;
    const secMarks = sections.map(() => 0);
    sel.forEach((qs, si) => qs.forEach((q) => {
      diff[lc(q.difficulty)]++; marks += num(q.marks); secMarks[si] += num(q.marks);
      tco(q).forEach((c) => { co[c] = (co[c] || 0) + 1; }); const b = lc(q.bloom); bl[b] = (bl[b] || 0) + 1;
    }));
    const costOf = () => {
      let v = 0;
      for (const d of DIFFS) v += absd(diff[d] - need[d]);
      if (T != null) v += absd(marks - T);
      sections.forEach((s, si) => { if (s.total != null && s.attempt == null) v += absd(secMarks[si] - s.total); });
      for (const [c, want] of Object.entries(coT)) v += absd((co[c] || 0) - want);
      if (hasBl) for (const [b, want] of Object.entries(blT)) v += absd((bl[b] || 0) - want);
      return v;
    };
    // cost change if `out` is replaced by `inn` in section si (section difficulty counts are kept by construction)
    const delta = (si, out, inn) => {
      let dlt = 0;
      const dO = lc(out.difficulty); const dI = lc(inn.difficulty);
      if (dO !== dI) {
        dlt += absd(diff[dO] - 1 - need[dO]) - absd(diff[dO] - need[dO]);
        dlt += absd(diff[dI] + 1 - need[dI]) - absd(diff[dI] - need[dI]);
      }
      const dm = num(inn.marks) - num(out.marks);
      if (dm) {
        if (T != null) dlt += absd(marks + dm - T) - absd(marks - T);
        const s = sections[si]; if (s.total != null && s.attempt == null) dlt += absd(secMarks[si] + dm - s.total) - absd(secMarks[si] - s.total);
      }
      const cO = tco(out); const cI = tco(inn);
      const touched = new Set([...cO, ...cI]);
      for (const c of touched) {
        const after = (co[c] || 0) - (cO.includes(c) ? 1 : 0) + (cI.includes(c) ? 1 : 0);
        dlt += absd(after - coT[c]) - absd((co[c] || 0) - coT[c]);
      }
      if (hasBl) {
        const bO = lc(out.bloom); const bI = lc(inn.bloom);
        if (bO !== bI) {
          if (blT[bO] != null) dlt += absd((bl[bO] || 0) - 1 - blT[bO]) - absd((bl[bO] || 0) - blT[bO]);
          if (blT[bI] != null) dlt += absd((bl[bI] || 0) + 1 - blT[bI]) - absd((bl[bI] || 0) - blT[bI]);
        }
      }
      return dlt;
    };
    const apply = (si, k, inn) => {
      const out = sel[si][k];
      diff[lc(out.difficulty)]--; diff[lc(inn.difficulty)]++;
      const dm = num(inn.marks) - num(out.marks); marks += dm; secMarks[si] += dm;
      tco(out).forEach((c) => { co[c] -= 1; }); tco(inn).forEach((c) => { co[c] = (co[c] || 0) + 1; });
      bl[lc(out.bloom)] -= 1; bl[lc(inn.bloom)] = (bl[lc(inn.bloom)] || 0) + 1;
      used.delete(keyOf(out)); used.add(keyOf(inn)); sel[si][k] = inn;
    };

    let cost = costOf();
    for (let step = 0; step < LS_STEPS && cost > 0; step++) {
      const si = Math.floor(rng() * sections.length); if (!sel[si].length) continue;
      const k = Math.floor(rng() * sel[si].length); const out = sel[si][k];
      const keepDiff = sections[si].diff ? lc(out.difficulty) : null;
      const list = cands[si];
      let best = null; let bestD = Infinity;
      const tries = Math.min(list.length, LS_SAMPLE);
      for (let t = 0; t < tries; t++) {
        const q = list.length <= LS_SAMPLE ? list[t] : list[Math.floor(rng() * list.length)];
        if (q === out || used.has(keyOf(q)) || (keepDiff && lc(q.difficulty) !== keepDiff)) continue;
        const dl = delta(si, out, q) + (recentIds.has(q.id) ? 0.01 : 0);
        if (dl < bestD || (dl === bestD && rng() < 0.5)) { bestD = dl; best = q; }
      }
      if (!best) continue;
      if (bestD <= 0 || rng() < 0.08) { apply(si, k, best); cost = costOf(); }
    }
    if (cost === 0) return sel.flatMap((qs, si) => qs.map((q) => ({ q, s: sections[si] })));
  }
  return null;
}

// Per-section part of the automated check (spec §25 'Sections', 'Internal choices'). Pure: run at generation
// (validateSelection) and again on the frozen paper snapshot (paper-sections.js). sections: normalizeSections()
// output (or format_config.sections); questions need section_name, slot_number, question_type, marks, difficulty.
export function checkSections(sections, questions) {
  return sections.filter((s) => s.name).map((s) => {
    const errors = []; const qs = questions.filter((q) => q.section_name === s.name);
    if (qs.length !== s.question_count) errors.push(`${s.name}: expected ${s.question_count} question(s), got ${qs.length}`);
    for (const q of qs) {
      if (s.types && !s.types.includes(normalizeQuestionType(q.question_type))) errors.push(`${s.name}: slot ${q.slot_number} type ${q.question_type} not allowed`);
      if (s.mpq != null && num(q.marks) !== s.mpq) errors.push(`${s.name}: slot ${q.slot_number} has ${q.marks} marks, section requires ${s.mpq}`);
    }
    if (s.diff) for (const d of DIFFS) {
      const got = qs.filter((q) => lc(q.difficulty) === d).length;
      if (got !== s.diff[d]) errors.push(`${s.name}: ${d} expected ${s.diff[d]}, got ${got}`);
    }
    const printed = qs.reduce((a, q) => a + num(q.marks), 0);
    const attempt = s.attempt ?? null;
    if (attempt != null) {
      if (s.mpq == null) errors.push(`${s.name}: internal choice needs fixed marks per question`);
      if (!(attempt >= 1 && attempt < qs.length)) errors.push(`${s.name}: "attempt any ${attempt}" needs more than ${attempt} question(s) in the section, got ${qs.length}`);
    }
    const counted = attempt != null && s.mpq != null ? attempt * s.mpq : printed;
    if (s.total != null && counted !== s.total) errors.push(`${s.name}: marks ${counted} do not equal section total ${s.total}`);
    return { name: s.name, index: s.index, questions: qs.length, printed_marks: printed, counted_marks: counted, attempt_count: attempt, passed: !errors.length, errors };
  });
}

// Pure automated validation (spec 25). errors block the paper; warnings inform validators.
export function validateSelection(questions, bp, exam, { override = null } = {}) {
  const errors = []; const warnings = [];
  const n = questions.length;
  const need = requiredCounts(bp);
  const marks = questions.reduce((s, q) => s + num(q.marks), 0);
  const hard = hardTargetModes(bp, override);
  const sections = normalizeSections(bp).filter((s) => s.name);
  const secChecks = checkSections(sections, questions);
  const inSec = new Set(sections.map((s) => s.name));
  // Marks a candidate can score: internal choices count attempt_count questions once.
  const counted = secChecks.reduce((a, c) => a + c.counted_marks, 0) + questions.filter((q) => !inSec.has(q.section_name)).reduce((a, q) => a + num(q.marks), 0);

  const wantTotal = bp.total_marks != null ? Number(bp.total_marks) : (exam.maximum_marks != null ? Number(exam.maximum_marks) : null);
  if (wantTotal != null && counted !== wantTotal) errors.push(`Total marks ${counted} does not equal required ${wantTotal}`);
  const wantCount = need.easy + need.medium + need.hard;
  if (wantCount && n !== wantCount) errors.push(`Question count ${n} does not equal blueprint ${wantCount}`);

  const slots = questions.map((q) => q.slot_number).sort((a, b) => a - b);
  if (!slots.every((s, i) => s === i + 1)) errors.push('Question numbering is not contiguous 1..n');

  const seenCanon = new Set(); const seenText = new Set();
  for (const q of questions) {
    const ck = q.canonical_question_id || q.id;
    const tk = String(q.question_text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenCanon.has(ck) || seenText.has(tk)) errors.push(`Duplicate question in paper (slot ${q.slot_number})`);
    seenCanon.add(ck); seenText.add(tk);

    if (q.question_status !== 'ACTIVE') errors.push(`Slot ${q.slot_number}: question is ${q.question_status}, only ACTIVE allowed`);
    if (q.campus_id !== exam.campus_id) errors.push(`Slot ${q.slot_number}: wrong campus`);
    if (q.program_id !== exam.program_id) errors.push(`Slot ${q.slot_number}: wrong program`);
    if (q.subject_id !== exam.subject_id) errors.push(`Slot ${q.slot_number}: wrong subject`);
    if (q.course_offering_id !== exam.course_offering_id) errors.push(`Slot ${q.slot_number}: wrong course offering`);
    if (q.syllabus_version_id !== exam.syllabus_version_id) errors.push(`Slot ${q.slot_number}: wrong syllabus version`);
    for (const e of validateQuestionByType(q)) errors.push(`Slot ${q.slot_number}: ${e}`);
    if (normalizeQuestionType(q.question_type) !== 'mcq' && !q.model_answer) errors.push(`Slot ${q.slot_number}: missing model answer`);
  }

  for (const d of DIFFS) {
    const got = questions.filter((q) => lc(q.difficulty) === d).length;
    if (got !== need[d]) errors.push(`Difficulty ${d}: expected ${need[d]}, got ${got}`);
  }

  // Sections (and internal choices)
  secChecks.forEach((c) => errors.push(...c.errors));

  const coGot = {};
  questions.forEach((q) => (q.cos || []).forEach((c) => { coGot[c] = (coGot[c] || 0) + 1; }));
  for (const [c, want] of Object.entries(bp.co_distribution || {})) {
    if ((coGot[c] || 0) !== Number(want)) (hard.co ? errors : warnings).push(`${c}: target ${want}, got ${coGot[c] || 0}`);
  }
  const bloomGot = {};
  questions.forEach((q) => { if (q.bloom) bloomGot[lc(q.bloom)] = (bloomGot[lc(q.bloom)] || 0) + 1; });
  const { targets } = bloomTargetCounts(bp.bloom_distribution, n);
  for (const [lvl, want] of Object.entries(targets)) {
    if ((bloomGot[lvl] || 0) !== want) (hard.bloom ? errors : warnings).push(`Bloom ${lvl}: target ${want}, got ${bloomGot[lvl] || 0}`);
  }
  if (override?.relax?.length) {
    warnings.push(`COE override: ${override.relax.join('/')} targets relaxed — ${override.reason}${override.strict_failure?.proven === false ? ' (the exact search was not exhaustive)' : ''}`);
  }
  const units = new Set(questions.map((q) => q.unit_id).filter(Boolean));
  const difficulty = Object.fromEntries(DIFFS.map((d) => [d, questions.filter((q) => lc(q.difficulty) === d).length]));

  return {
    passed: errors.length === 0, errors, warnings,
    summary: {
      total_marks: counted, printed_marks: marks, question_count: n, co: coGot, bloom: bloomGot, difficulty, units_covered: units.size,
      sections: secChecks,
      internal_choices: secChecks.filter((c) => c.attempt_count != null).map((c) => ({ section: c.name, attempt_count: c.attempt_count, of: c.questions, marks_counted: c.counted_marks, passed: c.passed })),
      hard_targets: hard, target_mode: bp.hard_targets ? 'hard' : 'legacy_soft', targets: resolvedTargets(bp),
    },
  };
}

// Eligibility: hard constraints in SQL. A question reserved by an in-flight paper of ANOTHER examination
// is not eligible (spec §15); the same examination's earlier revision may be reused by its regeneration.
// Syllabus (spec §14, §39.5; migration 042): the question is on the examination's syllabus version, or was re-mapped
// from it automatically because every item it maps to is unchanged in the newer version (question_syllabus_remaps
// 'auto_unchanged'), so an examination created before a syllabus change keeps its pool. Such a row reports the
// examination's version as syllabus_version_id (the version it qualifies for) and its own as mapped_syllabus_version_id.
// Only reviewer-verified mappings count (question_has_verified_mapping: topic, CO with a recorded verifier and Bloom
// of the question's own version), and the CO codes and Bloom level used for hard targets are the verified ones.
const ELIGIBLE_SQL = `
  SELECT q.id, q.question_text, q.question_type, q.difficulty, q.marks, q.topic, q.subtopic, q.answer_data,
         q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.model_answer,
         q.submitted_by, q.canonical_question_id, q.course_offering_id, $2::uuid AS syllabus_version_id,
         q.syllabus_version_id AS mapped_syllabus_version_id,
         q.subject_id, q.question_status, q.times_used, q.last_used_at,
         co.campus_id, co.program_id,
         cq.verified_bloom_level AS bloom,
         cq.verified_syllabus_unit_id AS unit_id,
         COALESCE((SELECT array_agg(DISTINCT oc.code) FROM question_course_outcomes qco
                   JOIN course_outcomes oc ON oc.id = qco.course_outcome_id
                   WHERE qco.canonical_question_id = q.canonical_question_id AND qco.verified_by IS NOT NULL
                     AND oc.syllabus_version_id = q.syllabus_version_id AND oc.is_active), '{}') AS cos
  FROM questions q
  JOIN course_offerings co ON co.id = q.course_offering_id
  JOIN canonical_questions cq ON cq.id = q.canonical_question_id
  WHERE q.question_status = 'ACTIVE'
    AND q.is_draft = FALSE
    AND q.course_offering_id = $1
    AND (q.syllabus_version_id = $2
         OR EXISTS (SELECT 1 FROM question_syllabus_remaps r
                     WHERE r.question_id = q.id AND r.from_version_id = $2 AND r.kind = 'auto_unchanged'))
    AND question_has_verified_mapping(q.id)
    AND q.subject_id = $3
    AND co.campus_id = $4
    AND co.program_id = $5
    AND NOT EXISTS (SELECT 1 FROM previous_year_papers p
                    WHERE p.course_offering_id = q.course_offering_id AND p.question_hash = q.question_hash)
    AND NOT EXISTS (SELECT 1 FROM question_reservations r
                    WHERE r.question_id = q.id AND r.released_at IS NULL AND r.examination_id <> $6)
    -- A question whose file is not (or no longer) virus-scan clean never reaches a paper (phase 3).
    AND NOT EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = q.id AND a.scan_status <> 'clean')`;

// The reviewer-verified CO codes of each selected question, frozen with the paper (exam_papers.candidate_metrics is
// immutable after generation, migration 039) so the printed paper's CO column never reads the live question bank.
export const questionCos = (questions) => Object.fromEntries(questions.map((q) => [q.id, [...new Set(q.cos || [])].sort()]));

export async function loadEligiblePool(exam, db = { all }) {
  return db.all(ELIGIBLE_SQL, [exam.course_offering_id, exam.syllabus_version_id, exam.subject_id, exam.campus_id, exam.program_id, exam.id]);
}

// The questions of the offering's last `lookback` PRINTED papers. A printed paper stays printed after it is
// archived (end of its exam cycle, or replaced by its printed revision): locked_at is set exactly when a paper
// becomes PRINT_READY (migration 036) and never cleared, so archived printed papers count too.
export async function loadRecentlyUsed(exam, lookback, db = { all }) {
  const rows = await db.all(`
    SELECT DISTINCT qu.question_id
    FROM question_usage qu
    WHERE qu.paper_id IN (
      SELECT id FROM exam_papers
      WHERE course_offering_id = $1 AND locked_at IS NOT NULL AND paper_status IN ('PRINT_READY', 'ARCHIVED')
      ORDER BY locked_at DESC LIMIT $2)`, [exam.course_offering_id, Math.max(0, Number(lookback) || 0)]);
  return new Set(rows.map((r) => r.question_id));
}

// Override of hard CO/Bloom targets for ONE generation (spec: never silently relax). Only the generating COE
// may record one (authorize 'override_generation_targets'); a reason is mandatory, and planSelection accepts it
// only when it is necessary and minimal. Idempotent on its own output.
export function normalizeOverride(o) {
  if (!o) return null;
  const relax = [...new Set((Array.isArray(o.relax) ? o.relax : []).map(lc))].filter((x) => ['co', 'bloom'].includes(x));
  if (!relax.length) return null;
  const reason = String(o.reason || '').trim();
  if (reason.length < 10) throw new GenerationError('An override of CO/Bloom targets needs a reason of at least 10 characters', 'OVERRIDE_INVALID');
  if (reason.length > 1000) throw new GenerationError('An override reason must be at most 1000 characters', 'OVERRIDE_INVALID');
  return { relax, reason };
}

const DIM_LABEL = { co: 'CO', bloom: 'Bloom' };
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? null]));
const STRICT_UNMET = ['INVENTORY', 'INFEASIBLE', 'SEARCH_LIMIT'];

// Strict first; an override is used only when it is needed (strict failed), valid (the dimension has targets)
// and minimal (relaxing one dimension is not already enough). Pure; at most 4 bounded, deterministic searches.
// Returns selectQuestions' result plus `override` (null, or the override with the strict failure it answers).
export function planSelection(pool, bp, seed, recentIds = new Set(), override = null) {
  const attempt = (ov) => {
    try { return { ok: true, ...selectQuestions(pool, bp, seed, recentIds, { override: ov }) }; } catch (e) {
      if (!(e instanceof GenerationError)) throw e;
      return { ok: false, error: e };
    }
  };
  if (!override) {
    const strict = attempt(null);
    if (strict.ok) return { ...strict, override: null };
    throw strict.error;
  }
  const config = blueprintConfigErrors(bp);
  if (config.length) throw new GenerationError(config, 'CONFIG');
  const legacy = legacyTargetError(bp);
  if (legacy) throw new GenerationError(legacy, 'LEGACY_BLUEPRINT');
  for (const d of override.relax) {
    if (!hasTargets(bp, d)) throw new GenerationError(`This blueprint version has no ${DIM_LABEL[d]} targets to relax`, 'OVERRIDE_INVALID');
  }
  const strict = attempt(null);
  if (strict.ok) {
    throw new GenerationError(`The ${override.relax.map((d) => DIM_LABEL[d]).join(' and ')} targets can be met exactly with the current question bank. Generate without an override.`, 'OVERRIDE_NOT_NEEDED');
  }
  if (!STRICT_UNMET.includes(strict.error.code)) throw strict.error;
  if (override.relax.length === 2) {
    for (const d of ['co', 'bloom']) {
      if (attempt({ ...override, relax: [d] }).ok) {
        const other = d === 'co' ? 'bloom' : 'co';
        throw new GenerationError(`Relaxing only the ${DIM_LABEL[d]} targets is enough; the ${DIM_LABEL[other]} targets can still be met exactly. Relax ${DIM_LABEL[d]} only.`, 'OVERRIDE_NOT_MINIMAL');
      }
    }
  }
  const relaxed = attempt(override);
  if (!relaxed.ok) throw relaxed.error;
  return { ...relaxed, override: { ...override, strict_failure: { code: strict.error.code, reasons: strict.error.reasons, proven: strict.error.code !== 'SEARCH_LIMIT' } } };
}

// Read-only dry run for the COE (POST /examinations/:id/feasibility). Never writes, never locks.
export function explainFeasibility(pool, bp, seed, recentIds, exam, override = null) {
  const achievedOf = (questions, ov) => {
    const v = validateSelection(questions, bp, exam, { override: ov });
    return { passed: v.passed, errors: v.errors, warnings: v.warnings,
      achieved: { co: v.summary.co, bloom: v.summary.bloom, difficulty: v.summary.difficulty, total_marks: v.summary.total_marks, printed_marks: v.summary.printed_marks,
        sections: v.summary.sections.map((c) => ({ name: c.name, questions: c.questions, marks: c.counted_marks, printed_marks: c.printed_marks, passed: c.passed })) } };
  };
  const out = { feasible: false, code: null, reasons: [], strict: null, override_options: [], override: null, targets: resolvedTargets(bp), achieved: null, warnings: [] };
  let strict;
  try { strict = selectQuestions(pool, bp, seed, recentIds); } catch (e) {
    if (!(e instanceof GenerationError)) throw e;
    out.strict = { feasible: false, code: e.code, reasons: e.reasons };
  }
  if (strict) {
    const a = achievedOf(strict.questions, null);
    out.strict = { feasible: a.passed, code: a.passed ? null : 'VALIDATION_FAILED', reasons: a.errors };
    Object.assign(out, { feasible: a.passed, code: out.strict.code, reasons: a.errors, achieved: a.achieved, warnings: a.warnings });
  } else {
    Object.assign(out, { code: out.strict.code, reasons: out.strict.reasons });
    if (STRICT_UNMET.includes(out.strict.code)) {
      const dims = ['co', 'bloom'].filter((d) => hasTargets(bp, d));
      const options = [...dims.map((d) => [d]), ...(dims.length === 2 ? [['co', 'bloom']] : [])];
      for (const relax of options) {
        try { selectQuestions(pool, bp, seed, recentIds, { override: { relax, reason: 'feasibility check' } }); out.override_options.push({ relax, feasible: true }); } catch (e) {
          if (!(e instanceof GenerationError)) throw e;
          out.override_options.push({ relax, feasible: false, code: e.code, reasons: e.reasons });
        }
      }
      // Only the minimal options are offered: both dimensions only when neither alone is enough.
      if (out.override_options.some((o) => o.relax.length === 1 && o.feasible)) out.override_options = out.override_options.filter((o) => o.relax.length === 1);
    }
  }
  if (override) {
    try {
      const plan = planSelection(pool, bp, seed, recentIds, override);
      const a = achievedOf(plan.questions, plan.override);
      out.override = { accepted: a.passed, relax: override.relax, strict_failure: plan.override.strict_failure };
      if (a.passed) Object.assign(out, { feasible: true, code: null, reasons: [], achieved: a.achieved, warnings: a.warnings });
    } catch (e) {
      if (!(e instanceof GenerationError)) throw e;
      out.override = { accepted: false, relax: override.relax, code: e.code, reasons: e.reasons };
    }
  }
  return out;
}

const RETRYABLE_CODES = new Set(['40001', '40P01']);
const RETRYABLE_CONSTRAINTS = ['uq_question_reservation_active', 'uq_exam_papers_examination_version'];
const LIVE_CONSTRAINT = 'uq_one_live_paper_per_examination';
const MAX_ATTEMPTS = 3;
const LOCK_WAIT = '20s';
const constraintOf = (err) => String(err?.constraint || err?.message || '');
const isRetryable = (err) => RETRYABLE_CODES.has(err?.code)
  || ((err?.code === '23505' || !err?.code) && RETRYABLE_CONSTRAINTS.some((c) => constraintOf(err).includes(c)));

// exam: examinations row. blueprint: paper_blueprints row.
// The whole generation runs in ONE transaction holding pg_advisory_xact_lock('generate:' + course offering), so
// every generation for the offering (and so for each of its examinations) is serialised; the unique reservation
// index is the database-level backstop. Nothing is written unless the paper is complete and valid.
// Under that lock: the examination may have no other live paper (one in progress or printed, paper-policy.js
// LIVE_PAPER_STATUSES; migration 039 re-checks at COMMIT), and paper_version = MAX + 1 (UNIQUE per examination).
// The CPU-bound search stays inside the transaction on purpose: it measured 2-3 s at worst on a 3000-question bank,
// only same-offering generations wait for it, and moving it out would still block the event loop for that time
// (only a worker thread fixes that) while forcing a re-read and re-validation of the pool under the lock.
// lock_timeout bounds how long waiters hold pool connections (55P03 -> 409).
// A fresh generation (no parent) is also refused while the examination has a printed paper: a change after
// PRINT_READY is a revision of that paper (spec §28, /revise), so the lineage is recorded.
// Regeneration passes two hooks that run in that same transaction: prepare(txn) right after the lock (it
// locks and re-checks the parent paper, and may return { excludeQuestionIds } read under that lock, so the
// exclusion matches the parent's open issues at commit) and finalize(txn, out) once the new paper is GENERATED (it carries
// the parent's open issues, supersedes the parent and writes the revision rows). So the parent's supersede
// and the issue carry commit or roll back together with the new revision. finalize must END with its audit
// rows (logAudit(entry, txn)): the audit chain lock is then held until COMMIT.
// excludeQuestionIds (plus those prepare returns): questions left out of the eligible pool (regeneration leaves
// out questions with open validator issues). The eligible-set hash describes the pool after the exclusion.
// Retries: at most 3 attempts (same seed) on serialization failures, deadlocks and unique-index races; each
// attempt is a fresh transaction, so the hooks run again and a failed attempt leaves nothing behind.
export async function generatePaper({ exam, blueprint, userId, seed, parentPaperId = null, override = null,
  excludeQuestionIds = [], prepare = null, finalize = null }) {
  const ov = normalizeOverride(override);
  const useSeed = seed || crypto.randomBytes(8).toString('hex');

  const attempt = (n) => withTransaction(async (txn) => {
    await txn.run("SELECT set_config('lock_timeout', $1, true)", [LOCK_WAIT]);
    await txn.run('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`generate:${exam.course_offering_id}`]);
    const prep = prepare ? await prepare(txn) : null;
    const excluded = new Set([...excludeQuestionIds, ...(prep?.excludeQuestionIds || [])]);
    const live = await txn.all(`SELECT id, paper_version, paper_status FROM exam_papers
      WHERE examination_id = $1 AND paper_status = ANY($2::text[]) AND id IS DISTINCT FROM $3::uuid ORDER BY paper_version`,
    [exam.id, LIVE_PAPER_STATUSES, parentPaperId]);
    if (live.length) {
      throw new GenerationConflict('This examination already has a paper in progress. Regenerate that paper as a new revision, or archive it, instead of generating another.',
        { reasons: live.map((p) => `Paper v${p.paper_version} is ${p.paper_status}`), details: { live_papers: live } });
    }
    if (!parentPaperId) {
      const printed = await txn.all(`SELECT id, paper_version, paper_status FROM exam_papers WHERE examination_id = $1 AND paper_status = 'PRINT_READY' ORDER BY paper_version`, [exam.id]);
      if (printed.length) {
        throw new GenerationConflict('This examination has a printed paper. A later change is a new revision of it: use Revise on the printed paper (or archive it at the end of its exam cycle).',
          { reasons: printed.map((p) => `Paper v${p.paper_version} is PRINT_READY`), details: { live_papers: printed } });
      }
    }
    const { v: paperVersion } = await txn.get('SELECT COALESCE(MAX(paper_version), 0)::int + 1 AS v FROM exam_papers WHERE examination_id = $1', [exam.id]);
    const pool = (await loadEligiblePool(exam, txn)).filter((q) => !excluded.has(q.id));
    const recent = await loadRecentlyUsed(exam, blueprint.reuse_lookback_exams, txn);

    const leftOut = () => (excluded.size ? [`${excluded.size} question(s) with open validator issues were left out; close those issues as wont_fix or regenerate with exclude_flagged_questions=false to allow them`] : []);
    let plan;
    try {
      plan = planSelection(pool, blueprint, useSeed, recent, ov);
    } catch (err) {
      if (err instanceof GenerationError) throw new GenerationError([...err.reasons, ...leftOut()], err.code);
      throw err;
    }
    const { questions, score } = plan;
    const report = validateSelection(questions, blueprint, exam, { override: plan.override });
    if (!report.passed) throw new GenerationError([...report.errors, ...leftOut()], 'VALIDATION_FAILED');

    const setHash = crypto.createHash('sha256').update(pool.map((q) => q.id).sort().join(',')).digest('hex');
    const need = requiredCounts(blueprint);
    const targets = resolvedTargets(blueprint);
    // The generating COE is the approver of its own override (spec §29; recorded, shown to every validator).
    const overrides = plan.override ? {
      relax: plan.override.relax, reason: plan.override.reason, by: userId, approved_by: userId, approval_basis: 'generating_coe',
      at: new Date().toISOString(), strict_failure: plan.override.strict_failure,
      original_targets: pick(targets, plan.override.relax), achieved: pick({ co: report.summary.co, bloom: report.summary.bloom }, plan.override.relax),
    } : null;

    const paper = await txn.get(`
      INSERT INTO exam_papers (subject_id, course_offering_id, title, format_config, generated_by, status,
        paper_status, examination_id, generation_seed, generator_version, blueprint_version_id, generated_at,
        eligible_question_set_hash, duration_minutes, bloom_realized, candidate_metrics, paper_version, parent_paper_id,
        constraint_overrides)
      VALUES ($1,$2,$3,$4,$5,'draft','GENERATING',$6,$7,$8,$9,now(),$10,$11,$12,$13,$14,$15,$16)
      RETURNING id`,
      [exam.subject_id, exam.course_offering_id, `${exam.exam_type} paper v${paperVersion}`, JSON.stringify({ ...need, sections: normalizeSections(blueprint).filter((x) => x.name) }), userId,
       exam.id, useSeed, GENERATOR_VERSION, blueprint.id, setHash, exam.duration_minutes,
       JSON.stringify(report.summary.bloom), JSON.stringify({ validation: report, score, targets, question_cos: questionCos(questions) }), paperVersion, parentPaperId,
       overrides ? JSON.stringify(overrides) : null]);
    for (const q of questions) {
      await txn.run('INSERT INTO paper_questions (paper_id, question_id, slot_number, selection_reason, section_name, section_index) VALUES ($1,$2,$3,$4,$5,$6)',
        [paper.id, q.id, q.slot_number, q.selection_reason, q.section_name, q.section_index]);
      // A newer paper of the same examination takes over that examination's reservation of the question.
      await txn.run(`UPDATE question_reservations SET released_at = now(), release_reason = 'moved to a newer paper of the same examination'
                     WHERE question_id = $1 AND released_at IS NULL AND examination_id = $2`, [q.id, exam.id]);
      await txn.run('INSERT INTO question_reservations (question_id, paper_id, examination_id) VALUES ($1,$2,$3)', [q.id, paper.id, exam.id]);
    }
    // One permanent record per relaxed dimension, written while the paper is GENERATING (migration 039).
    for (const d of overrides?.relax || []) {
      await txn.run(`INSERT INTO paper_constraint_overrides (paper_id, constraint_type, original_value, override_value, reason, overridden_by,
                       approved_by, approved_at, approval_basis) VALUES ($1,$2,$3,$4,$5,$6,$6,now(),'generating_coe')`,
        [paper.id, d === 'co' ? 'co_distribution' : 'bloom_distribution', JSON.stringify(overrides.original_targets[d]),
         JSON.stringify({ mode: 'relaxed', achieved: overrides.achieved[d], strict_failure: overrides.strict_failure }), overrides.reason, userId]);
    }
    // GENERATING -> GENERATED in the same transaction: the question list is only
    // writable while GENERATING (migration 036), and nobody ever sees a half-built paper.
    await txn.run(`UPDATE exam_papers SET paper_status = 'GENERATED' WHERE id = $1`, [paper.id]);
    const out = { paperId: paper.id, validation: report, eligible_count: pool.length, overrides, targets,
      questionIds: questions.map((q) => q.id), excluded_question_ids: [...excluded], paperVersion, seed: useSeed, attempt: n };
    // A retry runs the hooks again in its own transaction; the failed attempt rolled back everything.
    if (finalize) out.finalized = await finalize(txn, out);
    return out;
  });

  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (err instanceof GenerationError || err instanceof GenerationConflict) throw err;
      if (err?.code === '55P03') throw new GenerationConflict('The paper or its course offering is locked by another operation that is still running. Try again in a moment.');
      if (constraintOf(err).includes(LIVE_CONSTRAINT)) throw new GenerationConflict('This examination already has a paper in progress; regenerate or archive it first.');
      if (!isRetryable(err)) throw err;
      if (n >= MAX_ATTEMPTS) {
        throw new GenerationConflict(constraintOf(err).includes('uq_question_reservation_active')
          ? 'Another paper reserved some of these questions at the same moment. Try again.' : 'The database was busy with a conflicting change. Try again.');
      }
      await new Promise((r) => setTimeout(r, 25 * n + Math.floor(Math.random() * 25)));
    }
  }
}
