-- 031_pivot_completion.sql
-- Additive only. Closes gaps found auditing the repo against docs/development/PIVOT_SPEC_V2.md.
-- Never edits or renumbers earlier migrations.

-- ---------------------------------------------------------------------------
-- 1. Denormalised campus_id (spec §34). Several routes already join
--    course_offerings.campus_id, but no earlier migration created it.
--    Triggers keep it consistent with the parent so it can never drift.
-- ---------------------------------------------------------------------------
ALTER TABLE course_offerings ADD COLUMN IF NOT EXISTS campus_id UUID REFERENCES campuses(id);

UPDATE course_offerings co
SET campus_id = p.campus_id
FROM programs p
WHERE p.id = co.program_id AND co.campus_id IS DISTINCT FROM p.campus_id;

CREATE OR REPLACE FUNCTION sync_offering_campus()
RETURNS TRIGGER AS $$
BEGIN
  SELECT campus_id INTO NEW.campus_id FROM programs WHERE id = NEW.program_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_offering_campus ON course_offerings;
CREATE TRIGGER trg_sync_offering_campus
  BEFORE INSERT OR UPDATE OF program_id ON course_offerings
  FOR EACH ROW EXECUTE FUNCTION sync_offering_campus();

CREATE INDEX IF NOT EXISTS idx_course_offerings_campus ON course_offerings(campus_id);

ALTER TABLE questions ADD COLUMN IF NOT EXISTS campus_id UUID REFERENCES campuses(id);

UPDATE questions q
SET campus_id = co.campus_id
FROM course_offerings co
WHERE co.id = q.course_offering_id AND q.campus_id IS DISTINCT FROM co.campus_id;

CREATE OR REPLACE FUNCTION sync_question_campus()
RETURNS TRIGGER AS $$
BEGIN
  SELECT campus_id INTO NEW.campus_id FROM course_offerings WHERE id = NEW.course_offering_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_question_campus ON questions;
CREATE TRIGGER trg_sync_question_campus
  BEFORE INSERT OR UPDATE OF course_offering_id ON questions
  FOR EACH ROW EXECUTE FUNCTION sync_question_campus();

CREATE INDEX IF NOT EXISTS idx_questions_campus_status ON questions(campus_id, question_status);

-- ---------------------------------------------------------------------------
-- 2. Migration 030 seeded COE/validator accounts with a placeholder password
--    hash that can never verify. Test accounts do not belong in a production
--    migration, so disable them; seed.js creates working dev accounts.
-- ---------------------------------------------------------------------------
UPDATE users
SET is_active = FALSE, status = 'INACTIVE'
WHERE password_hash LIKE '%$salt$hash';

-- ---------------------------------------------------------------------------
-- 3. Question usage tracking (spec §16)
-- ---------------------------------------------------------------------------
ALTER TABLE questions ADD COLUMN IF NOT EXISTS times_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS question_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id  UUID NOT NULL REFERENCES questions(id),
  version_id   UUID,
  exam_id      UUID REFERENCES examinations(id),
  paper_id     UUID NOT NULL REFERENCES exam_papers(id),
  used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, paper_id)
);
CREATE INDEX IF NOT EXISTS idx_question_usage_question ON question_usage(question_id, used_at DESC);

-- Usage is recorded by the database the moment a paper becomes PRINT_READY,
-- so it cannot be skipped by any code path.
CREATE OR REPLACE FUNCTION record_question_usage()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO question_usage (question_id, version_id, exam_id, paper_id)
  SELECT pq.question_id, pq.question_version_id, NEW.examination_id, NEW.id
  FROM paper_questions pq
  WHERE pq.paper_id = NEW.id
  ON CONFLICT (question_id, paper_id) DO NOTHING;

  UPDATE questions
  SET times_used = times_used + 1, last_used_at = now()
  WHERE id IN (SELECT question_id FROM paper_questions WHERE paper_id = NEW.id);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_record_question_usage ON exam_papers;
CREATE TRIGGER trg_record_question_usage
  AFTER UPDATE OF paper_status ON exam_papers
  FOR EACH ROW
  WHEN (NEW.paper_status = 'PRINT_READY' AND OLD.paper_status IS DISTINCT FROM 'PRINT_READY')
  EXECUTE FUNCTION record_question_usage();

-- ---------------------------------------------------------------------------
-- 4. Versioned blueprints (spec §21)
-- ---------------------------------------------------------------------------
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS examination_id UUID REFERENCES examinations(id);
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS course_offering_id UUID REFERENCES course_offerings(id);
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS supersedes_id UUID REFERENCES paper_blueprints(id);
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS total_marks INTEGER;
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS co_distribution JSONB;
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS reuse_lookback_exams INTEGER NOT NULL DEFAULT 2;

-- A blueprint that a paper was generated from can never change its content.
-- Changing requirements = a new version (new row, supersedes_id set).
CREATE OR REPLACE FUNCTION protect_used_blueprint()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM exam_papers WHERE blueprint_version_id = OLD.id)
     AND ROW(NEW.easy_count, NEW.medium_count, NEW.hard_count, NEW.bloom_distribution,
             NEW.overall_difficulty_target, NEW.total_marks, NEW.co_distribution,
             NEW.reuse_lookback_exams)
         IS DISTINCT FROM
         ROW(OLD.easy_count, OLD.medium_count, OLD.hard_count, OLD.bloom_distribution,
             OLD.overall_difficulty_target, OLD.total_marks, OLD.co_distribution,
             OLD.reuse_lookback_exams)
  THEN
    RAISE EXCEPTION 'Blueprint is used by a generated paper and cannot be modified; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_used_blueprint ON paper_blueprints;
CREATE TRIGGER trg_protect_used_blueprint
  BEFORE UPDATE ON paper_blueprints
  FOR EACH ROW EXECUTE FUNCTION protect_used_blueprint();

-- ---------------------------------------------------------------------------
-- 5. Paper numbering / selection reason / revisions (spec §24, §28)
-- ---------------------------------------------------------------------------
ALTER TABLE paper_questions ADD COLUMN IF NOT EXISTS slot_number INTEGER;
ALTER TABLE paper_questions ADD COLUMN IF NOT EXISTS selection_reason TEXT;

ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS paper_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS parent_paper_id UUID REFERENCES exam_papers(id);

-- ---------------------------------------------------------------------------
-- 6. Technical emergency override log (spec §36)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_overrides (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID NOT NULL REFERENCES users(id),
  entity_type  TEXT NOT NULL,
  entity_id    UUID NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
  old_value    JSONB,
  new_value    JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 7. Inactive reviewer => pending reviews released for HOD reassignment (§12)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_inactive_reviewer_assignments()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE reviewer_assignments SET is_active = FALSE
  WHERE reviewer_id = NEW.id AND is_active = TRUE;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_release_inactive_reviewer ON users;
CREATE TRIGGER trg_release_inactive_reviewer
  AFTER UPDATE OF is_active ON users
  FOR EACH ROW
  WHEN (OLD.is_active = TRUE AND NEW.is_active = FALSE AND NEW.role = 'reviewer')
  EXECUTE FUNCTION release_inactive_reviewer_assignments();

-- ---------------------------------------------------------------------------
-- 8. Legacy `status` <-> `question_status` bridge.
--    Existing routes insert/update the legacy `status`/`is_draft` columns only,
--    while `question_status` is NOT NULL with no default, so those inserts
--    would fail. This derives question_status when legacy code does not set it.
--    It never produces ACTIVE or RETIRED (those only come from the lifecycle
--    route, which runs the quality gate) and never moves a question OUT of
--    ACTIVE / RETIRED / REJECTED.
--    Named trg_a_* so it runs before trg_sync_question_status on INSERT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legacy_status_to_question_status()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.question_status IS NULL THEN
      NEW.question_status := CASE
        WHEN NEW.is_draft THEN 'DRAFT'
        WHEN NEW.status IN ('ai_cleared', 'flagged') THEN 'UNDER_REVIEW'
        WHEN NEW.status = 'needs_teacher_fix' THEN 'CHANGES_REQUESTED'
        WHEN NEW.status = 'approved' THEN 'APPROVED'
        WHEN NEW.status IN ('rejected', 'withdrawn_duplicate') THEN 'REJECTED'
        ELSE 'SUBMITTED' END;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.question_status IS NOT DISTINCT FROM OLD.question_status
     AND OLD.question_status NOT IN ('ACTIVE', 'RETIRED', 'REJECTED') THEN
    NEW.question_status := CASE
      WHEN NEW.is_draft THEN 'DRAFT'
      WHEN NEW.status = 'approved' THEN 'APPROVED'
      WHEN NEW.status IN ('rejected', 'withdrawn_duplicate') THEN 'REJECTED'
      WHEN NEW.status = 'needs_teacher_fix' THEN 'CHANGES_REQUESTED'
      WHEN NEW.status IN ('ai_cleared', 'flagged') THEN 'UNDER_REVIEW'
      WHEN NEW.status = 'pending' THEN
        CASE OLD.question_status WHEN 'DRAFT' THEN 'SUBMITTED' WHEN 'CHANGES_REQUESTED' THEN 'RESUBMITTED'
          WHEN 'APPROVED' THEN 'UNDER_REVIEW'  -- legacy "re-confirm after syllabus change"
          ELSE OLD.question_status END
      ELSE OLD.question_status END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_a_legacy_status_to_qs ON questions;
CREATE TRIGGER trg_a_legacy_status_to_qs
  BEFORE INSERT OR UPDATE OF status, is_draft ON questions
  FOR EACH ROW EXECUTE FUNCTION legacy_status_to_question_status();

-- ---------------------------------------------------------------------------
-- 9. The quality gate needs questions.syllabus_version_id and questions.bloom_level,
--    but nothing populated them.
--    - New questions default to the offering's CURRENT syllabus version.
--      (Legacy rows are deliberately NOT backfilled: their syllabus is unknown,
--      so they stay out of ACTIVE until a human maps them - spec §11, §38.)
--    - bloom_level mirrors the REVIEWER-VERIFIED Bloom level on the canonical question.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION default_question_context()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.syllabus_version_id IS NULL THEN
    SELECT syllabus_version_id INTO NEW.syllabus_version_id FROM course_offerings WHERE id = NEW.course_offering_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_default_question_context ON questions;
CREATE TRIGGER trg_default_question_context
  BEFORE INSERT ON questions
  FOR EACH ROW EXECUTE FUNCTION default_question_context();

CREATE OR REPLACE FUNCTION mirror_verified_bloom_to_questions()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.verified_bloom_level IS NOT NULL THEN
    UPDATE questions SET bloom_level = NEW.verified_bloom_level
    WHERE canonical_question_id = NEW.id AND bloom_level IS DISTINCT FROM NEW.verified_bloom_level;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mirror_verified_bloom ON canonical_questions;
CREATE TRIGGER trg_mirror_verified_bloom
  AFTER INSERT OR UPDATE OF verified_bloom_level ON canonical_questions
  FOR EACH ROW EXECUTE FUNCTION mirror_verified_bloom_to_questions();

CREATE OR REPLACE FUNCTION bloom_on_canonical_link()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.canonical_question_id IS NOT NULL THEN
    SELECT COALESCE(verified_bloom_level, NEW.bloom_level) INTO NEW.bloom_level
    FROM canonical_questions WHERE id = NEW.canonical_question_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bloom_on_canonical_link ON questions;
CREATE TRIGGER trg_bloom_on_canonical_link
  BEFORE INSERT OR UPDATE OF canonical_question_id ON questions
  FOR EACH ROW EXECUTE FUNCTION bloom_on_canonical_link();

-- Reviewer-verified values only (not a guess): copy existing verified Bloom levels.
UPDATE questions q SET bloom_level = cq.verified_bloom_level
FROM canonical_questions cq
WHERE q.canonical_question_id = cq.id AND cq.verified_bloom_level IS NOT NULL
  AND q.bloom_level IS DISTINCT FROM cq.verified_bloom_level;

-- ---------------------------------------------------------------------------
-- 10. Quality gate, corrected. Same rules as migration 027, plus:
--     - the question's OWN syllabus version must exist, belong to the offering and be approved
--       (027 selected two columns both named syllabus_version_id into one record)
--     - unresolved duplicate conflicts are read from question_relationships
--       (027 looked at a table that does not exist, so it never blocked anything)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_question_for_active(p_question_id UUID)
RETURNS TABLE(valid BOOLEAN, errors TEXT[]) AS $$
DECLARE
  q RECORD;
  error_list TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT qs.*, sv.approval_status AS sv_status, sv.course_offering_id AS sv_offering_id
  INTO q
  FROM questions qs
  LEFT JOIN syllabus_versions sv ON sv.id = qs.syllabus_version_id
  WHERE qs.id = p_question_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, ARRAY['Question not found']::TEXT[];
    RETURN;
  END IF;

  IF q.question_status != 'APPROVED' THEN error_list := array_append(error_list, 'Question must be APPROVED before ACTIVE'); END IF;
  IF q.course_offering_id IS NULL THEN error_list := array_append(error_list, 'Missing course offering'); END IF;
  IF q.subject_id IS NULL THEN error_list := array_append(error_list, 'Missing subject'); END IF;
  IF q.syllabus_version_id IS NULL THEN
    error_list := array_append(error_list, 'Missing syllabus version mapping');
  ELSE
    IF q.sv_offering_id IS DISTINCT FROM q.course_offering_id THEN error_list := array_append(error_list, 'Syllabus version does not belong to this course offering'); END IF;
    IF q.sv_status IS DISTINCT FROM 'hod_approved' THEN error_list := array_append(error_list, 'Syllabus version is not approved'); END IF;
  END IF;
  IF q.topic IS NULL OR q.topic = '' THEN error_list := array_append(error_list, 'Missing topic mapping'); END IF;

  IF q.canonical_question_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM question_course_outcomes WHERE canonical_question_id = q.canonical_question_id) THEN
      error_list := array_append(error_list, 'Missing course outcome mapping');
    END IF;
  ELSE
    error_list := array_append(error_list, 'Missing canonical question mapping');
  END IF;

  IF q.bloom_level IS NULL THEN error_list := array_append(error_list, 'Missing Bloom level'); END IF;
  IF q.difficulty IS NULL THEN error_list := array_append(error_list, 'Missing difficulty level'); END IF;
  IF q.marks IS NULL OR q.marks <= 0 THEN error_list := array_append(error_list, 'Invalid marks (must be > 0)'); END IF;
  IF q.question_type IS NULL THEN error_list := array_append(error_list, 'Missing question type'); END IF;
  IF q.question_text IS NULL OR length(trim(q.question_text)) < 10 THEN error_list := array_append(error_list, 'Question text too short or missing'); END IF;

  IF q.question_type = 'objective' THEN
    IF q.option_a IS NULL OR q.option_b IS NULL OR q.option_c IS NULL OR q.option_d IS NULL THEN error_list := array_append(error_list, 'MCQ missing options'); END IF;
    IF q.correct_answer IS NULL THEN error_list := array_append(error_list, 'MCQ missing correct answer'); END IF;
  END IF;

  IF q.model_answer IS NULL OR length(trim(q.model_answer)) < 5 THEN error_list := array_append(error_list, 'Missing or insufficient model answer'); END IF;
  IF q.approved_by IS NULL THEN error_list := array_append(error_list, 'Missing reviewer approval'); END IF;

  IF EXISTS (
    SELECT 1 FROM question_relationships r
    WHERE r.status = 'pending' AND r.relationship_type = 'duplicate'
      AND (r.source_question_id = p_question_id OR r.target_question_id = p_question_id)
  ) THEN
    error_list := array_append(error_list, 'Unresolved duplicate conflict');
  END IF;

  RETURN QUERY SELECT (array_length(error_list, 1) IS NULL), error_list;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- 11. Bulk upload staging (spec §32): rows are validated and held until the
--     teacher confirms; only then do they become SUBMITTED questions.
-- ---------------------------------------------------------------------------
ALTER TABLE bulk_upload_batches ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS submitted_cos TEXT[];
