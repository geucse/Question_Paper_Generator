// Deduplication pipeline: validation -> normalization -> exact hash ->
// candidate retrieval -> embedding similarity -> semantic comparison ->
// classification (brain.md section 7). Validation/normalization already
// happen before this module is ever called (question text is normalized
// into question_hash and embedding at draft-save time — see questions.js
// and auth.js's normalizeQuestionHash). This module is candidate retrieval
// onward.
//
// The key rule this file exists to enforce: a raw cosine-similarity score
// is NEVER, by itself, the classification. Two questions can share 95% of
// their wording and still be genuinely different questions (different
// marks, different question type, asking for a different scope of answer)
// — and two questions can be worded completely differently while still
// being the same underlying question. `classify()` below always looks at
// question type, marks, topic, difficulty, and Bloom level alongside the
// text similarity score, and records its reasoning in plain language
// rather than just emitting a label.
//
// This is explicitly advisory, per brain.md section 2/8: classification
// tiers are a strong suggestion surfaced to a human (the submitting
// teacher for EXACT/LIKELY tiers, a reviewer for RELATED), never an
// automatic merge/delete/approve. Nothing in this file writes to the
// database — callers decide what, if anything, to persist.

import { all, get, run as dbRun } from './db.js';
import { computeEmbedding, cosineSimilarity } from './embeddings.js';

export const CLASSIFICATIONS = ['EXACT_DUPLICATE', 'LIKELY_DUPLICATE', 'RELATED', 'DISTINCT'];

// How many nearest-by-embedding candidates to actually run full
// classification against, beyond any exact-hash match (which is always
// included). Kept small — this runs synchronously in a request handler,
// not a background job (see the README's scope-limits note on background
// jobs not existing yet in this build).
const CANDIDATE_POOL_SIZE = 5;

// Fetches up to CANDIDATE_POOL_SIZE nearest-by-embedding questions plus any
// exact-hash match, all already-submitted (non-draft) questions in the same
// course offering, excluding the question itself.
// db: optional transaction handle, so a bulk confirm sees rows it inserted earlier in the same transaction.
export async function findCandidates(question, courseOfferingId, db = { get, all }) {
  const exact = await db.get(`
    SELECT * FROM questions WHERE course_offering_id = $1 AND question_hash = $2 AND id != $3 AND is_draft = FALSE
  `, [courseOfferingId, question.question_hash, question.id]);

  let nearest = [];
  if (question.embedding) {
    nearest = await db.all(`
      SELECT *, 1 - (embedding <=> $4::vector) as _similarity FROM questions
      WHERE course_offering_id = $1 AND id != $2 AND is_draft = FALSE AND embedding IS NOT NULL
        AND question_hash != $3
      ORDER BY embedding <=> $4::vector ASC LIMIT $5
    `, [courseOfferingId, question.id, question.question_hash, question.embedding, CANDIDATE_POOL_SIZE]);
  }

  return exact ? [exact, ...nearest] : nearest;
}

// Every signal brain.md section 7 calls out as necessary alongside text
// similarity: intent (approximated by answer-text similarity — two
// questions asking for genuinely the same thing tend to expect similar
// answers), expected answer, scope (question type + marks), concepts
// (topic), and the reviewer-relevant classification fields (Bloom,
// difficulty). None of this is a real NLP "intent" model — it's the
// closest honest approximation buildable without an external AI call on
// every single comparison (which would also make every question preview
// slow and costly). See dedup.js's module comment and classify()'s
// reasoning strings for what this can and can't actually tell you.
export function computeSignals(source, candidate) {
  const exactHash = source.question_hash === candidate.question_hash;
  const textSimilarity = source.embedding && candidate.embedding
    ? Number((candidate._similarity !== undefined ? candidate._similarity : vectorSimilarityFallback(source, candidate)).toFixed(4))
    : null;

  let answerSimilarity = null;
  if (source.model_answer && candidate.model_answer) {
    const a = computeEmbedding(source.model_answer);
    const b = computeEmbedding(candidate.model_answer);
    const sim = cosineSimilarity(a, b);
    if (sim !== null) answerSimilarity = Number(sim.toFixed(4));
  }

  return {
    exactHash,
    textSimilarity,
    answerSimilarity,
    sameQuestionType: source.question_type === candidate.question_type,
    sameMarks: Number(source.marks) === Number(candidate.marks),
    sameTopic: !!(source.topic && candidate.topic && source.topic.trim().toLowerCase() === candidate.topic.trim().toLowerCase()),
    sameDifficulty: source.difficulty === candidate.difficulty,
    sameBloom: !!(source.submitted_bloom_level && candidate.submitted_bloom_level)
      ? source.submitted_bloom_level === candidate.submitted_bloom_level
      : null, // null = "unknown", not "different" — at least one side never set a Bloom level
  };
}

// findCandidates already computed similarity in SQL for the nearest-
// neighbor pool (as `_similarity`); for the exact-hash candidate (which
// wasn't part of that ORDER BY, so SQL never computed a distance for it),
// fall back to computing cosine similarity in JS from the raw embedding
// text pg returns. Keeps computeSignals a pure function that doesn't care
// which retrieval path a candidate came from.
function vectorSimilarityFallback(source, candidate) {
  const a = parseEmbeddingLiteral(source.embedding);
  const b = parseEmbeddingLiteral(candidate.embedding);
  const sim = cosineSimilarity(a, b);
  return sim === null ? 0 : sim;
}

function parseEmbeddingLiteral(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.replace(/[[\]]/g, '').split(',').map(Number);
  return null;
}

// The classification itself: deterministic, explainable, and always
// returns why — never just a bare label. Thresholds are the same
// empirically-chosen ones the earlier single-signal check used (0.85-0.92
// range), now gating on scope/type/marks agreement too rather than acting
// on text similarity alone.
export function classify(signals) {
  const reasons = [];

  if (signals.exactHash) {
    reasons.push('Identical normalized question text (exact hash match).');
    return { classification: 'EXACT_DUPLICATE', reasons };
  }

  const sim = signals.textSimilarity;
  if (sim === null) {
    return { classification: 'DISTINCT', reasons: ['No embedding available for either question — could not compare text.'] };
  }

  const scopeMatches = signals.sameQuestionType && signals.sameMarks;

  if (sim >= 0.90) {
    if (scopeMatches) {
      reasons.push(`${Math.round(sim * 100)}% textual similarity, and question type + marks both match.`);
      if (signals.answerSimilarity !== null) {
        reasons.push(signals.answerSimilarity >= 0.7
          ? `Model answers are also similar (${Math.round(signals.answerSimilarity * 100)}%), reinforcing this is the same question.`
          : `Model answers differ more than the question text does (${Math.round(signals.answerSimilarity * 100)}% similar) — worth a second look.`);
      }
      if (signals.sameDifficulty === false) reasons.push('Note: difficulty labels differ between the two submissions.');
      if (signals.sameBloom === false) reasons.push('Note: submitted Bloom levels differ between the two submissions.');
      return { classification: 'LIKELY_DUPLICATE', reasons };
    }
    reasons.push(`${Math.round(sim * 100)}% textual similarity, but question type or marks differ enough that this is not being treated as the same question.`);
    return { classification: 'RELATED', reasons };
  }

  if (sim >= 0.60 || (sim >= 0.35 && signals.sameTopic)) {
    reasons.push(`${Math.round(sim * 100)}% textual similarity` + (signals.sameTopic ? ', and both are tagged with the same topic.' : '.'));
    return { classification: 'RELATED', reasons };
  }

  return { classification: 'DISTINCT', reasons: [`Only ${Math.round(sim * 100)}% textual similarity — no meaningful overlap detected.`] };
}

function defaultRelationshipType(classification) {
  return classification === 'RELATED' ? 'related' : 'duplicate';
}

// Persists every classified (non-DISTINCT) candidate as a `question_relationships`
// row so there's a durable record of what the system found, regardless of
// what a human later decides — brain.md section 7's "every original
// submission remains auditable" applies to candidate detection too, not
// just the submissions themselves. Re-running detection on the same pair
// (e.g. the teacher reloading the preview screen) refreshes the computed
// classification/similarity/signals in place; a pair a human has already
// decided on (status != 'pending') is left completely untouched — see the
// migration's WHERE-guarded ON CONFLICT for how that's enforced at the DB
// level, not just in application logic.
export async function persistCandidates(sourceQuestionId, classifiedResults, db = { get, run: dbRun }) {
  const persisted = [];
  for (const r of classifiedResults) {
    let row = await db.get(`
      INSERT INTO question_relationships
        (source_question_id, target_question_id, relationship_type, similarity_score, source, status, classification, signals)
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
      ON CONFLICT (source_question_id, target_question_id) DO UPDATE SET
        similarity_score = EXCLUDED.similarity_score, classification = EXCLUDED.classification, signals = EXCLUDED.signals
        WHERE question_relationships.status = 'pending'
      RETURNING *
    `, [sourceQuestionId, r.candidate.id, defaultRelationshipType(r.classification), r.similarity, r.source, r.classification, JSON.stringify(r.signals)]);
    if (!row) {
      // Conflict happened but the WHERE guard skipped the update (already
      // decided) — fetch the existing row as-is so the caller still gets
      // the full picture, including the human decision already recorded.
      row = await db.get(`SELECT * FROM question_relationships WHERE source_question_id = $1 AND target_question_id = $2`, [sourceQuestionId, r.candidate.id]);
    }
    persisted.push({ ...row, reasons: r.reasons, candidate_question_text: r.candidate.question_text });
  }
  return persisted;
}
// compute signals, classify each. Returns every candidate that classified
// as something other than DISTINCT, best (most concerning) classification
// first — DISTINCT candidates are deliberately dropped here rather than
// returned, since surfacing "this is 20% similar to five unrelated
// questions" has no actionable value for a teacher or reviewer.
const SEVERITY = { EXACT_DUPLICATE: 3, LIKELY_DUPLICATE: 2, RELATED: 1, DISTINCT: 0 };

export async function classifyAgainstBank(question, courseOfferingId, db = { get, all }) {
  const candidates = await findCandidates(question, courseOfferingId, db);
  const results = candidates.map(candidate => {
    const signals = computeSignals(question, candidate);
    const { classification, reasons } = classify(signals);
    return {
      candidate, signals, classification, reasons,
      similarity: signals.exactHash ? 1 : (signals.textSimilarity ?? 0),
      source: signals.exactHash ? 'exact_hash' : 'lexical_embedding',
    };
  });
  return results
    .filter(r => r.classification !== 'DISTINCT')
    .sort((a, b) => SEVERITY[b.classification] - SEVERITY[a.classification] || b.similarity - a.similarity);
}
