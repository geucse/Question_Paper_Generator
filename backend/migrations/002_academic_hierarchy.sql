-- Core academic hierarchy. Subjects are stable identities that live
-- independently of any one year/program/teacher — they get *offered* in a
-- given program+session+semester via course_offerings (migration 004).
-- This is what lets question banks, syllabus versions, and papers all key
-- off something more precise than "the subject" when precision matters,
-- while still rolling up to "the subject" for anything that doesn't care.

CREATE TABLE departments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  code          TEXT UNIQUE NOT NULL,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE programs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL REFERENCES departments(id),
  name          TEXT NOT NULL,
  code          TEXT NOT NULL,
  degree_type   TEXT,          -- e.g. UG, PG, Diploma
  duration_years NUMERIC(3,1),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (department_id, code)
);

CREATE TABLE subjects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_code    TEXT UNIQUE NOT NULL,
  course_title    TEXT NOT NULL,
  description     TEXT,
  credits         NUMERIC(4,2),
  theory_hours    INTEGER DEFAULT 0,
  tutorial_hours  INTEGER DEFAULT 0,
  practical_hours INTEGER DEFAULT 0,
  category        TEXT,          -- core / elective / open-elective / lab
  prerequisites   TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which programs a subject belongs to, and since when. A subject can be
-- shared across programs (e.g. a math elective taken by two departments)
-- without duplicating its identity or question bank.
CREATE TABLE program_subjects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id      UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  subject_id      UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  curriculum_role TEXT NOT NULL DEFAULT 'core' CHECK (curriculum_role IN ('core','elective','open_elective','lab','audit')),
  effective_from  DATE,
  effective_to    DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, subject_id, effective_from)
);

CREATE TABLE academic_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label       TEXT UNIQUE NOT NULL,  -- e.g. "2026-2027"
  start_date  DATE,
  end_date    DATE,
  status      TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','active','closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_programs_department ON programs(department_id);
CREATE INDEX idx_program_subjects_subject ON program_subjects(subject_id);
CREATE INDEX idx_program_subjects_program ON program_subjects(program_id);
