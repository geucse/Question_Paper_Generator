-- Course Outcomes (COs) live under a specific syllabus version — per spec
-- section 8, CO text must never be silently rewritten when a later syllabus
-- version changes it; a new syllabus version gets its own CO rows instead
-- of mutating the old ones. This is what question_course_outcomes (next
-- migration) maps questions against.
CREATE TABLE course_outcomes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  syllabus_version_id   UUID NOT NULL REFERENCES syllabus_versions(id) ON DELETE CASCADE,
  code                  TEXT NOT NULL,   -- e.g. "CO1"
  description           TEXT NOT NULL,
  sequence              INTEGER NOT NULL DEFAULT 0,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (syllabus_version_id, code)
);
CREATE INDEX idx_course_outcomes_syllabus ON course_outcomes(syllabus_version_id, is_active);
