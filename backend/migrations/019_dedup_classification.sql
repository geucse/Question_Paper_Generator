-- Deduplication used to be a single yes/no threshold on one embedding
-- score — "similarity > 0.85 => flag it". brain.md section 7 is explicit
-- that a similarity score alone is insufficient and calls for real
-- classification tiers (EXACT_DUPLICATE / LIKELY_DUPLICATE / RELATED /
-- DISTINCT) driven by comparing intent, scope, marks, concepts, type,
-- Bloom and difficulty — not text similarity in isolation. `classification`
-- is the system's computed tier (always set, independent of any human
-- decision); `signals` is the full breakdown of what was compared, kept
-- for transparency (a reviewer can see WHY something was classified a
-- given way, not just trust a black-box label) — see backend/src/dedup.js.
--
-- classification vs relationship_type: classification is what the system
-- computed at detection time and never changes after that. relationship_type
-- is the (possibly different) type once a human has actually decided —
-- e.g. a LIKELY_DUPLICATE the teacher confirms becomes relationship_type
-- 'duplicate'; one they reject stays classified LIKELY_DUPLICATE forever
-- (that's the historical record) while status moves to 'dismissed'.
ALTER TABLE question_relationships ADD COLUMN classification TEXT
  CHECK (classification IN ('EXACT_DUPLICATE', 'LIKELY_DUPLICATE', 'RELATED', 'DISTINCT'));
ALTER TABLE question_relationships ADD COLUMN signals JSONB;

-- One relationship row per (source, target) pair — repeated detection runs
-- (e.g. the teacher reloading the preview screen) refresh the computed
-- classification/signals in place rather than piling up duplicate pending
-- rows for the same pair. See dedup.js's upsert for how a pair that has
-- already been decided (status != 'pending') is left untouched by a later
-- detection run.
ALTER TABLE question_relationships ADD CONSTRAINT uq_question_relationship_pair UNIQUE (source_question_id, target_question_id);
