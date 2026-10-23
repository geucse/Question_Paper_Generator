-- A course_offering is "this subject, in this program, this academic
-- session, this semester" — the actual unit that questions, syllabi, and
-- papers attach to. This is what makes "never repeat last year's paper"
-- and "syllabus changed, question bank needs re-review" precise instead of
-- fuzzy at the bare-subject level.
--
-- syllabus_version_id is nullable and its FK is added after syllabus_versions
-- exists below (the two tables reference each other by design: an offering
-- points at its currently-active syllabus version, and a syllabus version
-- points at the offering it belongs to).
CREATE TABLE course_offerings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id           UUID NOT NULL REFERENCES subjects(id),
  program_id           UUID NOT NULL REFERENCES programs(id),
  academic_session_id  UUID NOT NULL REFERENCES academic_sessions(id),
  semester             INTEGER NOT NULL CHECK (semester BETWEEN 1 AND 12),
  offering_code        TEXT,
  syllabus_version_id  UUID,
  status               TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, subject_id, academic_session_id, semester)
);

-- Full column set defined now (even though the AI-extraction/verification
-- pipeline itself is a later phase) so course_offerings never needs a
-- follow-up migration just to grow this table.
CREATE TABLE syllabus_versions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_offering_id    UUID NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  version_number        INTEGER NOT NULL DEFAULT 1,
  source_file_path      TEXT,
  source_file_hash      TEXT,
  extraction_status     TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','ai_extracted','extraction_failed')),
  verification_status   TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','teacher_verified','needs_correction')),
  approval_status       TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','hod_approved','rejected')),
  extracted_units        JSONB,     -- structured AI-extracted unit/topic breakdown
  effective_from        DATE,
  effective_to          DATE,
  uploaded_by           UUID REFERENCES users(id),
  verified_by           UUID REFERENCES users(id),
  approved_by           UUID REFERENCES users(id),
  approved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_offering_id, version_number)
);

ALTER TABLE course_offerings
  ADD CONSTRAINT fk_course_offerings_syllabus
  FOREIGN KEY (syllabus_version_id) REFERENCES syllabus_versions(id);

CREATE TABLE sections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_offering_id  UUID NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,   -- e.g. "A", "B", "CSE-3A"
  code                TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_offering_id, name)
);

-- A teacher's actual right to submit questions for a given offering (and
-- optionally a specific section of it). This replaces the old
-- users.subject_id single-column model: a teacher can hold several active
-- assignments across offerings/sessions at once, each with its own window.
CREATE TABLE teacher_course_assignments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_offering_id  UUID NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  section_id          UUID REFERENCES sections(id),
  assignment_role     TEXT NOT NULL DEFAULT 'instructor' CHECK (assignment_role IN ('instructor','co_instructor','lab_instructor')),
  starts_at           TIMESTAMPTZ,
  ends_at             TIMESTAMPTZ,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_course_offerings_subject ON course_offerings(subject_id);
CREATE INDEX idx_course_offerings_program_session ON course_offerings(program_id, academic_session_id);
CREATE INDEX idx_sections_offering ON sections(course_offering_id);
CREATE INDEX idx_tca_teacher_active ON teacher_course_assignments(teacher_id, is_active);
CREATE INDEX idx_tca_offering ON teacher_course_assignments(course_offering_id);
