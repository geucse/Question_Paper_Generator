-- Paper validation and revalidation tracking
CREATE TABLE IF NOT EXISTS paper_validation_log (
  id BIGSERIAL PRIMARY KEY,
  paper_id UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  validation_type TEXT NOT NULL, -- 'initial', 'after_edit', 'after_replace', 'after_regenerate'
  triggered_by UUID REFERENCES users(id),
  validation_result TEXT NOT NULL, -- 'passed', 'failed'
  constraints_checked JSONB NOT NULL, -- what was validated
  violations JSONB, -- what failed
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correlation_id UUID DEFAULT gen_random_uuid()
);

CREATE INDEX idx_paper_validation_paper ON paper_validation_log(paper_id, timestamp DESC);
CREATE INDEX idx_paper_validation_result ON paper_validation_log(validation_result);

-- Constraint override tracking (when HOD explicitly relaxes a constraint)
CREATE TABLE IF NOT EXISTS paper_constraint_overrides (
  id BIGSERIAL PRIMARY KEY,
  paper_id UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  constraint_type TEXT NOT NULL, -- 'bloom_distribution', 'co_coverage', 'difficulty_target', 'reuse_policy'
  original_value JSONB NOT NULL,
  override_value JSONB NOT NULL,
  reason TEXT NOT NULL,
  overridden_by UUID NOT NULL REFERENCES users(id),
  overridden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by UUID REFERENCES users(id), -- HOD approval required
  approved_at TIMESTAMPTZ
);

CREATE INDEX idx_paper_constraint_overrides_paper ON paper_constraint_overrides(paper_id);
CREATE INDEX idx_paper_constraint_overrides_user ON paper_constraint_overrides(overridden_by);

-- Paper semantic conflict detection (questions that are too similar within same paper)
CREATE TABLE IF NOT EXISTS paper_semantic_conflicts (
  id BIGSERIAL PRIMARY KEY,
  paper_id UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  question1_id UUID NOT NULL REFERENCES canonical_questions(id),
  question2_id UUID NOT NULL REFERENCES canonical_questions(id),
  similarity_score DECIMAL(3,2) NOT NULL,
  conflict_type TEXT NOT NULL, -- 'redundant_content', 'overlapping_concepts', 'similar_wording'
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved BOOLEAN DEFAULT FALSE,
  resolution_action TEXT, -- 'replaced_question', 'accepted_overlap', 'regenerated'
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_paper_semantic_conflicts_paper ON paper_semantic_conflicts(paper_id, resolved);
CREATE INDEX idx_paper_semantic_conflicts_questions ON paper_semantic_conflicts(question1_id, question2_id);
