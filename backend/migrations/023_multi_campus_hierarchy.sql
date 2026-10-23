-- Multi-campus academic hierarchy
-- docs/development/PIVOT_SPEC_V2.md section 3: Institution → Campus → College → Department → Program
-- This migration adds the missing top-level hierarchy for multi-campus support.
-- Existing departments, programs, subjects remain intact.

CREATE TABLE institutions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  code        TEXT UNIQUE NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campuses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  code           TEXT NOT NULL,
  location       TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, code)
);

CREATE TABLE colleges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campus_id  UUID NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campus_id, code)
);

-- Add campus and college references to existing departments
-- Nullable initially for backward compatibility during migration
ALTER TABLE departments ADD COLUMN college_id UUID REFERENCES colleges(id);
ALTER TABLE departments ADD COLUMN campus_id UUID REFERENCES campuses(id);
ALTER TABLE departments ADD COLUMN institution_id UUID REFERENCES institutions(id);

-- Add indexes for hierarchy traversal
CREATE INDEX idx_campuses_institution ON campuses(institution_id);
CREATE INDEX idx_colleges_campus ON colleges(campus_id);
CREATE INDEX idx_departments_college ON departments(college_id);
CREATE INDEX idx_departments_campus ON departments(campus_id);
CREATE INDEX idx_departments_institution ON departments(institution_id);

-- Backfill: Create a default institution, campus, and college for existing data
-- This ensures existing departments don't break. Admins should update these to real values.
INSERT INTO institutions (id, name, code, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Default Institution (Update Required)',
  'DEFAULT_INST',
  true
);

INSERT INTO campuses (id, institution_id, name, code, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'Default Campus (Update Required)',
  'DEFAULT_CAMPUS',
  true
);

INSERT INTO colleges (id, campus_id, name, code, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000002',
  'Default College (Update Required)',
  'DEFAULT_COLLEGE',
  true
);

-- Backfill existing departments with default values
UPDATE departments
SET
  institution_id = '00000000-0000-0000-0000-000000000001',
  campus_id = '00000000-0000-0000-0000-000000000002',
  college_id = '00000000-0000-0000-0000-000000000003'
WHERE institution_id IS NULL;

-- Now make the foreign keys NOT NULL (all existing rows have values)
ALTER TABLE departments ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE departments ALTER COLUMN campus_id SET NOT NULL;
ALTER TABLE departments ALTER COLUMN college_id SET NOT NULL;

-- Add denormalized campus/institution references to programs for query performance
-- These must match the department's hierarchy (enforced by application/triggers if needed)
ALTER TABLE programs ADD COLUMN college_id UUID REFERENCES colleges(id);
ALTER TABLE programs ADD COLUMN campus_id UUID REFERENCES campuses(id);
ALTER TABLE programs ADD COLUMN institution_id UUID REFERENCES institutions(id);

-- Backfill programs with their department's hierarchy
UPDATE programs p
SET
  institution_id = d.institution_id,
  campus_id = d.campus_id,
  college_id = d.college_id
FROM departments d
WHERE p.department_id = d.id;

ALTER TABLE programs ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE programs ALTER COLUMN campus_id SET NOT NULL;
ALTER TABLE programs ALTER COLUMN college_id SET NOT NULL;

CREATE INDEX idx_programs_campus ON programs(campus_id);
CREATE INDEX idx_programs_institution ON programs(institution_id);
