-- Units and Topics were named in the original architecture (syllabus
-- version -> COs / Units / Topics) but never actually built — only Course
-- Outcomes existed. This is the other half: a syllabus version breaks down
-- into ordered units, each with topics underneath. Like course_outcomes,
-- these belong to ONE specific syllabus version and are never rewritten by
-- a later version — a new version gets its own unit/topic rows.
CREATE TABLE syllabus_units (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  syllabus_version_id  UUID NOT NULL REFERENCES syllabus_versions(id) ON DELETE CASCADE,
  code                 TEXT NOT NULL,   -- e.g. "Unit 1"
  title                TEXT NOT NULL,
  sequence             INTEGER NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (syllabus_version_id, code)
);
CREATE INDEX idx_syllabus_units_version ON syllabus_units(syllabus_version_id, is_active);

CREATE TABLE syllabus_topics (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  syllabus_unit_id UUID NOT NULL REFERENCES syllabus_units(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  sequence         INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (syllabus_unit_id, title)
);
CREATE INDEX idx_syllabus_topics_unit ON syllabus_topics(syllabus_unit_id, is_active);

-- Reviewer-verified unit/topic mapping lives on canonical_questions,
-- alongside verified_difficulty/verified_bloom_level — same authority
-- model (reviewer-confirmed value beats the teacher's free-text `topic`
-- field on the submission, which stays exactly as typed). NULL until a
-- reviewer sets them; enforced by the route layer to only ever be set to a
-- unit/topic pair that actually belongs to the question's own course
-- offering's syllabus version (see review-batches.js) — "Unit/Topic must
-- come from valid syllabus relationships" is a backend rule, not just a
-- frontend dropdown constraint.
ALTER TABLE canonical_questions ADD COLUMN verified_syllabus_unit_id UUID REFERENCES syllabus_units(id);
ALTER TABLE canonical_questions ADD COLUMN verified_syllabus_topic_id UUID REFERENCES syllabus_topics(id);

-- Per-reviewer verdict and the final explicit resolution both need their
-- own unit/topic columns, exactly mirroring how verified_bloom_level /
-- verified_course_outcome_id already work — independent reviewers can
-- disagree on unit/topic just as easily as on Bloom or difficulty.
ALTER TABLE question_reviews ADD COLUMN verified_syllabus_unit_id UUID REFERENCES syllabus_units(id);
ALTER TABLE question_reviews ADD COLUMN verified_syllabus_topic_id UUID REFERENCES syllabus_topics(id);
ALTER TABLE review_resolutions ADD COLUMN final_syllabus_unit_id UUID REFERENCES syllabus_units(id);
ALTER TABLE review_resolutions ADD COLUMN final_syllabus_topic_id UUID REFERENCES syllabus_topics(id);
