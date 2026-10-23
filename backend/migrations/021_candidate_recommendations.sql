-- Every generated candidate needs real, computed comparison metrics (CO
-- coverage, unit coverage, difficulty match, Bloom match, semantic
-- conflicts, reuse conflicts, a quality score) so the comparison screen
-- shows actual numbers, not a static mockup. Computed once at generation
-- time in papers.js and stored here — never recomputed differently for
-- display vs for the recommendation, so what a reviewer compares is
-- exactly what gets stored on their recommendation.
ALTER TABLE exam_papers ADD COLUMN candidate_metrics JSONB;

-- One reviewer's recommendation among the candidates from a single
-- generation batch. Advisory only (spec section 16) — this table is never
-- read by the HOD-selection endpoint to auto-pick anything; it's purely
-- informational context surfaced alongside the candidates themselves. Kept
-- one-per-reviewer-per-batch (not one-per-batch) so multiple assigned
-- reviewers can each recommend independently without overwriting each
-- other, the same non-averaging principle as question-level review.
CREATE TABLE candidate_recommendations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_request_id  UUID NOT NULL REFERENCES paper_generation_requests(id) ON DELETE CASCADE,
  recommended_paper_id   UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  reviewer_id            UUID NOT NULL REFERENCES users(id),
  score                  NUMERIC(5,2),
  reason                 TEXT,
  strengths              JSONB,
  weaknesses             JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (generation_request_id, reviewer_id)
);
CREATE INDEX idx_candidate_recommendations_request ON candidate_recommendations(generation_request_id);

-- When a HOD picks a candidate OTHER than the (a) recommended one, spec
-- section 17 requires a reason — recorded directly on the generation
-- request rather than a separate table, since there's exactly one such
-- override decision per batch.
ALTER TABLE paper_generation_requests ADD COLUMN hod_override_reason TEXT;
