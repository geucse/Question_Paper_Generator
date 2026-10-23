-- CO mapping is a property of the canonical question (the institutional
-- concept), not any one teacher's wording of it — so this maps against
-- canonical_questions, not questions. Recommended default from spec
-- section 16: exactly one PRIMARY CO for blueprint accounting, zero or
-- more SECONDARY COs. Not enforced as a hard DB constraint (a reviewer may
-- briefly have zero while still deciding), but routes should guide toward it.
CREATE TABLE question_course_outcomes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_question_id  UUID NOT NULL REFERENCES canonical_questions(id) ON DELETE CASCADE,
  course_outcome_id      UUID NOT NULL REFERENCES course_outcomes(id) ON DELETE CASCADE,
  relationship_type      TEXT NOT NULL DEFAULT 'primary' CHECK (relationship_type IN ('primary','secondary')),
  confidence             NUMERIC(5,4),
  source                 TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('ai','manual','reviewer')),
  verified_by            UUID REFERENCES users(id),
  verified_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_question_id, course_outcome_id)
);
CREATE INDEX idx_question_cos_canonical ON question_course_outcomes(canonical_question_id);
CREATE INDEX idx_question_cos_co ON question_course_outcomes(course_outcome_id);

-- A canonical question can only be mapped to a course_outcome that belongs
-- to a syllabus version applicable to its own subject's course offerings —
-- this can't be a DB constraint across those joins cheaply, so it is
-- enforced in the route layer (see academic.js's CO-mapping endpoint);
-- documented here so the intent isn't lost.
