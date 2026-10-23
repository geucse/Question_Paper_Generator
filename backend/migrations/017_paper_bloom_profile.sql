-- Spec sections 26-28: paper difficulty must be more than a bare
-- easy/medium/hard question count — it also needs a Bloom distribution,
-- and the "overall paper difficulty" is a distinct, explained judgment,
-- never just an average of the individual question difficulties.
--
-- bloom_distribution is stored as percentages (JSON: {remember, understand,
-- apply, analyze, evaluate, create}, summing to ~100) on the reusable
-- blueprint; paper_generation_requests stores the actual per-candidate
-- Bloom question COUNTS derived from those percentages for the requested
-- total question count, so what was actually asked for is preserved even
-- if the blueprint is edited later. exam_papers stores what was ACTUALLY
-- achieved plus a plain-language, explicitly-labeled estimate — never
-- presented as mathematically exact (spec section 28).
ALTER TABLE paper_blueprints ADD COLUMN bloom_distribution JSONB;
ALTER TABLE paper_blueprints ADD COLUMN overall_difficulty_target TEXT
  CHECK (overall_difficulty_target IN ('easy','medium','medium_hard','hard'));

ALTER TABLE paper_generation_requests ADD COLUMN bloom_targets JSONB;

ALTER TABLE exam_papers ADD COLUMN bloom_realized JSONB;
ALTER TABLE exam_papers ADD COLUMN overall_difficulty_target TEXT
  CHECK (overall_difficulty_target IN ('easy','medium','medium_hard','hard'));
ALTER TABLE exam_papers ADD COLUMN overall_difficulty_estimate TEXT
  CHECK (overall_difficulty_estimate IN ('easy','medium','medium_hard','hard'));
ALTER TABLE exam_papers ADD COLUMN difficulty_estimate_confidence NUMERIC(5,2);
ALTER TABLE exam_papers ADD COLUMN difficulty_estimate_factors JSONB;
