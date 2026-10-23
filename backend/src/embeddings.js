// A deliberately simple, fully local "embedding" for catching near-duplicate
// questions that exact-hash matching misses (reworded, reordered, or
// lightly-edited versions of the same question) — WITHOUT depending on any
// external embedding API or a downloaded ML model, since this environment
// (and possibly the deployment environment) may not have reliable access to
// either.
//
// Honest limits of this approach: this is a character-trigram hashed
// bag-of-words vector, not a real semantic embedding. It will NOT catch two
// questions that mean the same thing but use completely different words
// (true paraphrase/semantic duplicates) — for that, a real embedding model
// (e.g. via an external API) would need to be substituted in here. What it
// DOES reliably catch: near-identical wording with minor edits, reordering,
// typo differences, or partial copy-paste — which covers the overwhelming
// majority of real "teacher submitted this twice" and "teacher lightly
// reworded last year's question" cases.
//
// Swapping in a real embedding model later is a one-function change: replace
// the body of `computeEmbedding` and re-run a backfill; nothing else
// (the pgvector column, the cosine-similarity query, the API contract)
// needs to change.

const DIMENSIONS = 256;

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simple, fast string hash (djb2) — good enough to spread trigrams across
// buckets, not intended to be cryptographically meaningful.
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function computeEmbedding(text) {
  const normalized = normalize(text);
  const vec = new Array(DIMENSIONS).fill(0);
  if (normalized.length < 3) return vec;

  for (let i = 0; i <= normalized.length - 3; i++) {
    const trigram = normalized.slice(i, i + 3);
    const bucket = djb2(trigram) % DIMENSIONS;
    vec[bucket] += 1;
  }

  const magnitude = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map(v => v / magnitude);
}

// pgvector wants a literal like '[0.1,0.2,...]'
export function embeddingToSqlLiteral(vec) {
  return `[${vec.join(',')}]`;
}

// Plain JS cosine similarity between two already-computed vectors — used
// when comparing two pieces of text that aren't both stored as pgvector
// columns (e.g. two free-text model answers), so the comparison can happen
// without a database round-trip.
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return null;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
