-- Closes a real gap: near-duplicate detection (Phase 2) only ever produced
-- a warning nobody could act on — a flagged question just sat in the bank
-- forever, still eligible for paper generation, with no record of anyone
-- having looked at the match. This table gives the interactive decision
-- loop the spec describes: show the teacher the match, let them either
-- withdraw in favor of the existing question or explicitly say "this is
-- different" (recorded, not just silently dismissed).
CREATE TABLE question_relationships (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_question_id   UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  target_question_id   UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  relationship_type    TEXT NOT NULL CHECK (relationship_type IN ('duplicate','related','alternative','conceptually_similar','prerequisite')),
  similarity_score     NUMERIC(5,4),
  source               TEXT NOT NULL CHECK (source IN ('exact_hash','lexical_embedding','manual')),
  reviewed_by          UUID REFERENCES users(id),
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','dismissed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_question_relationships_source ON question_relationships(source_question_id);
CREATE INDEX idx_question_relationships_target ON question_relationships(target_question_id);

-- A teacher choosing "Use Existing Question" withdraws their own draft
-- rather than it sitting in the bank as a live duplicate — distinct from
-- 'rejected' (an HOD/admin quality decision) so the two cases stay
-- distinguishable in reporting.
ALTER TABLE questions DROP CONSTRAINT questions_status_check;
ALTER TABLE questions ADD CONSTRAINT questions_status_check
  CHECK (status IN ('pending','ai_cleared','needs_teacher_fix','approved','rejected','flagged','withdrawn_duplicate'));
