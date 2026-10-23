-- ---------------------------------------------------------------------
-- Canonical question architecture (spec section 11-18).
--
-- Up to this migration, `questions` was a single flat row that mixed
-- together "what a teacher typed in" with "the institution's one true
-- version of this question". That's wrong the moment two teachers submit
-- the same question worded slightly differently: the old model would
-- either store it twice (redundant, no shared history) or overwrite one
-- teacher's wording (destroys authorship).
--
-- From this migration on, `questions` becomes the SUBMISSION layer only
-- (kept as the same physical table — renaming it would be a much bigger,
-- riskier change touching every route/attachment/paper reference for no
-- functional benefit) — it is what a specific teacher actually typed, and
-- it is never rewritten to match a merged canonical wording. On top of it:
--
--   canonical_questions   — the institution's one true question record
--   question_versions     — edit history of the canonical wording/marks
--   canonical_answers     — the one true model answer, versioned
--   question_canonicalization_events — audit trail of merges/links/splits
--   question_course_outcomes — CO mapping (next migration)
--
-- Every existing `questions` row is backfilled into a 1:1 canonical
-- question in the next migration (014) — nothing is destroyed, the split
-- is purely additive.
-- ---------------------------------------------------------------------

CREATE TABLE canonical_questions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id            UUID NOT NULL REFERENCES subjects(id),
  canonical_text        TEXT NOT NULL,
  normalized_text       TEXT NOT NULL,
  question_type         TEXT NOT NULL CHECK (question_type IN ('objective','subjective')),
  question_hash         TEXT NOT NULL,
  current_version_id    UUID, -- FK added below, after question_versions exists
  -- Reviewer-verified academic classification. A teacher's own submission
  -- carries its OWN suggested difficulty/bloom (questions.difficulty /
  -- questions.submitted_bloom_level) — these verified_* columns are the
  -- authoritative values a subject-specialist reviewer has confirmed, and
  -- are what paper generation actually reads (spec section 22: teacher
  -- suggestion -> AI suggestion -> reviewer verified value -> HOD
  -- intervention if necessary). NULL until a reviewer (or HOD override)
  -- has explicitly set them — never silently defaulted or averaged.
  verified_difficulty    TEXT CHECK (verified_difficulty IN ('easy','medium','hard')),
  verified_bloom_level   TEXT CHECK (verified_bloom_level IN ('remember','understand','apply','analyze','evaluate','create')),
  verified_by            UUID REFERENCES users(id),
  verified_at            TIMESTAMPTZ,
  quality_status         TEXT NOT NULL DEFAULT 'pending' CHECK (quality_status IN ('pending','ai_cleared','flagged','human_verified')),
  workflow_status        TEXT NOT NULL DEFAULT 'submitted' CHECK (workflow_status IN
    ('draft','submitted','ai_review','needs_teacher_revision','reviewer_review','needs_revision','hod_review','approved','rejected','retired')),
  applicability_status   TEXT NOT NULL DEFAULT 'active' CHECK (applicability_status IN ('active','legacy','review_required','retired')),
  embedding              vector(256),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_canonical_questions_subject ON canonical_questions(subject_id);
CREATE INDEX idx_canonical_questions_hash ON canonical_questions(subject_id, question_hash);
CREATE INDEX idx_canonical_questions_applicability ON canonical_questions(applicability_status);
CREATE INDEX idx_canonical_questions_embedding ON canonical_questions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

CREATE TABLE question_versions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_question_id  UUID NOT NULL REFERENCES canonical_questions(id) ON DELETE CASCADE,
  version_number         INTEGER NOT NULL,
  question_text          TEXT NOT NULL,
  question_type          TEXT NOT NULL,
  marks                  INTEGER NOT NULL,
  option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT, correct_answer TEXT,
  created_by             UUID REFERENCES users(id),
  change_reason          TEXT,
  is_current             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_question_id, version_number)
);
CREATE INDEX idx_question_versions_canonical ON question_versions(canonical_question_id, is_current);

ALTER TABLE canonical_questions
  ADD CONSTRAINT fk_canonical_current_version FOREIGN KEY (current_version_id) REFERENCES question_versions(id);

-- The one true model answer for a canonical question, versioned the same
-- way question text is. Each teacher's own answer text remains untouched
-- on their `questions` submission row — this is the reviewed/approved
-- reference answer used for grading, not a replacement for what any one
-- teacher wrote.
CREATE TABLE canonical_answers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_question_id  UUID NOT NULL REFERENCES canonical_questions(id) ON DELETE CASCADE,
  version_number         INTEGER NOT NULL,
  answer_text            TEXT NOT NULL,
  key_concepts_json       TEXT,
  marking_scheme_json     TEXT,
  created_by              UUID REFERENCES users(id),
  approved_by              UUID REFERENCES users(id),
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  is_current               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_question_id, version_number)
);
CREATE INDEX idx_canonical_answers_canonical ON canonical_answers(canonical_question_id, is_current);

-- Full audit trail of how a canonical question came to be, and every time
-- a submission was linked/unlinked/merged/split against one. This is what
-- lets an incorrectly-merged question be split apart later without losing
-- history (spec section 14).
CREATE TABLE question_canonicalization_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_question_id  UUID NOT NULL REFERENCES canonical_questions(id) ON DELETE CASCADE,
  submission_id          UUID REFERENCES questions(id) ON DELETE SET NULL,
  action                 TEXT NOT NULL CHECK (action IN ('created_canonical','linked_to_canonical','merged_after_review','unlinked','split')),
  similarity_score       NUMERIC(5,4),
  reason                 TEXT,
  performed_by           UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_canonicalization_events_canonical ON question_canonicalization_events(canonical_question_id);
CREATE INDEX idx_canonicalization_events_submission ON question_canonicalization_events(submission_id);

-- Link every submission to the one canonical question it represents, and
-- record what the TEACHER suggested for Bloom level at submission time
-- (kept separate from canonical_questions.verified_bloom_level, which is
-- the reviewer-confirmed value). difficulty was already on `questions`.
ALTER TABLE questions ADD COLUMN canonical_question_id UUID REFERENCES canonical_questions(id);
ALTER TABLE questions ADD COLUMN submitted_bloom_level TEXT CHECK (submitted_bloom_level IN ('remember','understand','apply','analyze','evaluate','create'));
CREATE INDEX idx_questions_canonical ON questions(canonical_question_id);
