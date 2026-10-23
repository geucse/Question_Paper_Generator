-- 042: phase 4b, syllabus versioning, change detection and question re-mapping (brain.md §6, PIVOT_SPEC_V2 §9,
-- §11, §14, §39.5; implementation prompt "syllabus" gaps).
--
-- Forward-only and idempotent. No question changes state here and no existing row is rewritten except the one-time
-- backfill of the new syllabus_versions.status column; a NOTICE reports what needs a human.
--
--   A. Syllabus version lifecycle: DRAFT -> TEACHER_VERIFIED -> HOD_REVIEW -> ACTIVE -> SUPERSEDED, REJECTED from any
--      state before ACTIVE, and a reasoned return to DRAFT from TEACHER_VERIFIED / HOD_REVIEW. trg_guard_syllabus_version
--      checks every transition and its preconditions; approval_status / verification_status become mirrors of it.
--      One ACTIVE version per offering, and the offering's current pointer can only name its ACTIVE version.
--   B. Content of a version that is not DRAFT (units, topics, subtopics, COs) is immutable (spec: syllabus versions
--      are immutable after approval; verified content is what is approved). Changes go through a new version.
--   C. Change detection records: syllabus_changes / affected_questions (021, unused until now) get the columns the
--      activation writes; question_syllabus_remaps keeps every re-mapping of a question to another version.
--   D. Subtopic integrity: questions.subtopic_id (the text column stays for legacy rows), reviewer-verified subtopic,
--      the verifying reviewer ids of consensus results, and qco sources for re-mapping.
--   E. Question content lock: a narrow hatch for re-mapping (syllabus_version_id / subtopic_id only, and only onto the
--      offering's ACTIVE version), used by the activation and the HOD mapping routes.
--   F. Verified mapping: question_has_verified_mapping() (generation eligibility, analytics, reports) and the quality
--      gate require a reviewer-verified topic, CO and Bloom level in the question's own syllabus version.

-- ---------------------------------------------------------------------------------------------------------------
-- A. Syllabus version lifecycle
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS based_on_version_id UUID REFERENCES syllabus_versions(id);
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS submitted_for_review_by UUID REFERENCES users(id);
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS submitted_for_review_at TIMESTAMPTZ;
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS returned_reason TEXT;
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id);
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS superseded_by_version_id UUID REFERENCES syllabus_versions(id);
ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- Backfill (rows without a status only, so a re-run changes nothing): the version the offering points at and that the
-- HOD approved is ACTIVE; other approved versions are SUPERSEDED; a verified pending one waits for the HOD.
UPDATE syllabus_versions sv SET status = CASE
    WHEN sv.approval_status = 'rejected' THEN 'REJECTED'
    WHEN sv.approval_status = 'hod_approved'
         AND EXISTS (SELECT 1 FROM course_offerings co WHERE co.id = sv.course_offering_id AND co.syllabus_version_id = sv.id) THEN 'ACTIVE'
    WHEN sv.approval_status = 'hod_approved' THEN 'SUPERSEDED'
    WHEN sv.verification_status = 'teacher_verified' THEN 'HOD_REVIEW'
    ELSE 'DRAFT' END
WHERE sv.status IS NULL;

ALTER TABLE syllabus_versions ALTER COLUMN status SET DEFAULT 'DRAFT';
ALTER TABLE syllabus_versions ALTER COLUMN status SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'syllabus_versions_status_check') THEN
    ALTER TABLE syllabus_versions ADD CONSTRAINT syllabus_versions_status_check
      CHECK (status IN ('DRAFT', 'TEACHER_VERIFIED', 'HOD_REVIEW', 'ACTIVE', 'SUPERSEDED', 'REJECTED'));
  END IF;
END $$;
-- The backfill makes ACTIVE only the version an offering points at, so there is at most one per offering.
CREATE UNIQUE INDEX IF NOT EXISTS uq_syllabus_versions_one_active ON syllabus_versions (course_offering_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_syllabus_versions_offering_status ON syllabus_versions (course_offering_id, status);

-- What a version needs before it can be verified or approved (empty array = complete). Shared by the guard below and
-- the routes (academic.js), so both report the same reasons.
CREATE OR REPLACE FUNCTION syllabus_version_content_problems(p_version_id UUID)
RETURNS TEXT[] AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM syllabus_units u JOIN syllabus_topics t ON t.syllabus_unit_id = u.id AND t.is_active
       WHERE u.syllabus_version_id = p_version_id AND u.is_active)
      THEN 'at least one active unit with at least one active topic' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM course_outcomes c WHERE c.syllabus_version_id = p_version_id AND c.is_active)
      THEN 'at least one active course outcome' END], NULL)
$$ LANGUAGE sql STABLE;

-- Transition guard. Transitions (anything else is refused):
--   DRAFT            -> TEACHER_VERIFIED (verified_by, complete content), REJECTED
--   TEACHER_VERIFIED -> HOD_REVIEW (submitted_for_review_by), DRAFT (returned_reason), REJECTED
--   HOD_REVIEW       -> ACTIVE (approved_by = an active HOD, verified, complete content, no other ACTIVE), DRAFT, REJECTED
--   ACTIVE           -> SUPERSEDED (superseded_by_version_id = a version of the same offering awaiting activation)
--   SUPERSEDED, REJECTED: terminal.
-- REJECTED needs rejected_by and a rejection_reason. approval_status / verification_status are derived here and cannot
-- be written on their own. A version that is ACTIVE, SUPERSEDED or REJECTED keeps its identity, content reference and
-- decision fields; an ACTIVE or SUPERSEDED version is never deleted. No runtime override (a data-repair migration
-- disables the trigger in its own transaction).
CREATE OR REPLACE FUNCTION guard_syllabus_version()
RETURNS TRIGGER AS $$
DECLARE
  v_allowed TEXT[];
  v_locked TEXT[];
  v_changed TEXT[];
  v_problems TEXT[];
  v_old JSONB;
  v_new JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('ACTIVE', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'Syllabus version % is % and cannot be deleted (approved syllabus versions are immutable)', OLD.version_number, OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'DRAFT' OR NEW.approval_status IS DISTINCT FROM 'pending' OR NEW.verification_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'A syllabus version starts as DRAFT (got status %, approval %, verification %); it is verified and approved through the syllabus workflow',
        NEW.status, NEW.approval_status, NEW.verification_status;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND (NEW.approval_status IS DISTINCT FROM OLD.approval_status OR NEW.verification_status IS DISTINCT FROM OLD.verification_status) THEN
    RAISE EXCEPTION 'approval_status and verification_status follow the syllabus version status (%); change the status through the syllabus workflow', OLD.status;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_allowed := CASE OLD.status
      WHEN 'DRAFT'            THEN ARRAY['TEACHER_VERIFIED', 'REJECTED']
      WHEN 'TEACHER_VERIFIED' THEN ARRAY['HOD_REVIEW', 'DRAFT', 'REJECTED']
      WHEN 'HOD_REVIEW'       THEN ARRAY['ACTIVE', 'DRAFT', 'REJECTED']
      WHEN 'ACTIVE'           THEN ARRAY['SUPERSEDED']
      ELSE ARRAY[]::TEXT[] END;
    IF NOT (NEW.status = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'Invalid syllabus version transition: % -> %', OLD.status, NEW.status;
    END IF;

    IF NEW.status IN ('TEACHER_VERIFIED', 'ACTIVE') THEN
      v_problems := syllabus_version_content_problems(NEW.id);
      IF array_length(v_problems, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'Syllabus version % is incomplete: it needs %', NEW.version_number, array_to_string(v_problems, ' and ');
      END IF;
    END IF;

    CASE NEW.status
      WHEN 'TEACHER_VERIFIED' THEN
        IF NEW.verified_by IS NULL THEN RAISE EXCEPTION 'Verification must record who verified the syllabus version'; END IF;
        NEW.verification_status := 'teacher_verified';
        NEW.verified_at := now();
        NEW.returned_reason := NULL;
      WHEN 'HOD_REVIEW' THEN
        IF NEW.submitted_for_review_by IS NULL THEN RAISE EXCEPTION 'Submitting for HOD review must record who submitted it'; END IF;
        NEW.submitted_for_review_at := now();
      WHEN 'DRAFT' THEN
        IF coalesce(trim(NEW.returned_reason), '') = '' THEN
          RAISE EXCEPTION 'Returning a syllabus version to DRAFT needs a reason';
        END IF;
        NEW.verification_status := 'needs_correction';
        NEW.verified_by := NULL; NEW.verified_at := NULL;
        NEW.submitted_for_review_by := NULL; NEW.submitted_for_review_at := NULL;
      WHEN 'ACTIVE' THEN
        IF NEW.verified_by IS NULL THEN RAISE EXCEPTION 'Only a verified syllabus version can be approved'; END IF;
        IF NEW.approved_by IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.approved_by AND u.role = 'hod' AND u.is_active) THEN
          RAISE EXCEPTION 'A syllabus version is approved by an active HOD (version %)', NEW.version_number;
        END IF;
        IF EXISTS (SELECT 1 FROM syllabus_versions o WHERE o.course_offering_id = NEW.course_offering_id AND o.status = 'ACTIVE' AND o.id <> NEW.id) THEN
          RAISE EXCEPTION 'The offering already has an ACTIVE syllabus version: supersede it in the same transaction';
        END IF;
        NEW.approval_status := 'hod_approved';
        NEW.approved_at := now();
        NEW.effective_from := COALESCE(NEW.effective_from, now()::date);
        NEW.effective_to := NULL;
      WHEN 'SUPERSEDED' THEN
        IF NEW.superseded_by_version_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM syllabus_versions s WHERE s.id = NEW.superseded_by_version_id AND s.id <> NEW.id
             AND s.course_offering_id = NEW.course_offering_id AND s.status = 'HOD_REVIEW') THEN
          RAISE EXCEPTION 'An ACTIVE syllabus version is superseded only by the activation of another version of the same offering';
        END IF;
        NEW.superseded_at := now();
        NEW.effective_to := COALESCE(NEW.effective_to, now()::date);
      WHEN 'REJECTED' THEN
        IF NEW.rejected_by IS NULL OR coalesce(trim(NEW.rejection_reason), '') = '' THEN
          RAISE EXCEPTION 'Rejecting a syllabus version needs who rejected it and a reason';
        END IF;
        NEW.approval_status := 'rejected';
        NEW.rejected_at := now();
      ELSE NULL;
    END CASE;
  END IF;

  IF OLD.status IN ('ACTIVE', 'SUPERSEDED', 'REJECTED') THEN
    v_locked := ARRAY['course_offering_id', 'version_number', 'extracted_units', 'source_file_path', 'source_file_hash',
                      'uploaded_by', 'verified_by', 'verified_at', 'approved_by', 'approved_at', 'effective_from',
                      'based_on_version_id', 'rejected_by', 'rejected_at', 'rejection_reason'];
    IF OLD.status <> 'ACTIVE' THEN
      v_locked := v_locked || ARRAY['status', 'superseded_by_version_id', 'superseded_at', 'effective_to', 'approval_status', 'verification_status'];
    END IF;
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW);
    SELECT array_agg(c ORDER BY c) INTO v_changed FROM unnest(v_locked) AS c WHERE v_old -> c IS DISTINCT FROM v_new -> c;
    IF v_changed IS NOT NULL THEN
      RAISE EXCEPTION 'Syllabus version % is % and cannot change (changed: %); create a new version instead',
        OLD.version_number, OLD.status, array_to_string(v_changed, ', ');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_syllabus_version ON syllabus_versions;
CREATE TRIGGER trg_guard_syllabus_version
  BEFORE INSERT OR UPDATE OR DELETE ON syllabus_versions
  FOR EACH ROW EXECUTE FUNCTION guard_syllabus_version();

-- The offering's current syllabus version is its ACTIVE one (examinations and the question form read the pointer).
CREATE OR REPLACE FUNCTION guard_offering_syllabus_pointer()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.syllabus_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM syllabus_versions sv WHERE sv.id = NEW.syllabus_version_id AND sv.course_offering_id = NEW.id AND sv.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'A course offering''s current syllabus version must be its ACTIVE version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_offering_syllabus_pointer ON course_offerings;
CREATE TRIGGER trg_guard_offering_syllabus_pointer
  BEFORE INSERT OR UPDATE OF syllabus_version_id ON course_offerings
  FOR EACH ROW WHEN (NEW.syllabus_version_id IS NOT NULL)
  EXECUTE FUNCTION guard_offering_syllabus_pointer();

-- ---------------------------------------------------------------------------------------------------------------
-- B. Syllabus content is immutable outside DRAFT (units, topics, subtopics, COs). Content rows whose version is gone
--    (a DRAFT version deleted with ON DELETE CASCADE) pass.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION syllabus_content_version(p_table TEXT, p_row JSONB)
RETURNS UUID AS $$
  SELECT CASE p_table
    WHEN 'syllabus_units' THEN (p_row ->> 'syllabus_version_id')::uuid
    WHEN 'course_outcomes' THEN (p_row ->> 'syllabus_version_id')::uuid
    WHEN 'syllabus_topics' THEN (SELECT u.syllabus_version_id FROM syllabus_units u WHERE u.id = (p_row ->> 'syllabus_unit_id')::uuid)
    WHEN 'syllabus_subtopics' THEN (SELECT u.syllabus_version_id FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
                                     WHERE t.id = (p_row ->> 'syllabus_topic_id')::uuid)
  END
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION guard_syllabus_content()
RETURNS TRIGGER AS $$
DECLARE
  v_ids UUID[] := ARRAY[]::UUID[];
  v_status TEXT;
  v_number INT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_ids := array_append(v_ids, syllabus_content_version(TG_TABLE_NAME, to_jsonb(OLD))); END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN v_ids := array_append(v_ids, syllabus_content_version(TG_TABLE_NAME, to_jsonb(NEW))); END IF;
  SELECT sv.status, sv.version_number INTO v_status, v_number
    FROM syllabus_versions sv WHERE sv.id = ANY (v_ids) AND sv.status <> 'DRAFT' LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Syllabus content is locked: version % is % (only a DRAFT version can change; create a new version from it)', v_number, v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_syllabus_units ON syllabus_units;
CREATE TRIGGER trg_guard_syllabus_units BEFORE INSERT OR UPDATE OR DELETE ON syllabus_units
  FOR EACH ROW EXECUTE FUNCTION guard_syllabus_content();
DROP TRIGGER IF EXISTS trg_guard_syllabus_topics ON syllabus_topics;
CREATE TRIGGER trg_guard_syllabus_topics BEFORE INSERT OR UPDATE OR DELETE ON syllabus_topics
  FOR EACH ROW EXECUTE FUNCTION guard_syllabus_content();
DROP TRIGGER IF EXISTS trg_guard_syllabus_subtopics ON syllabus_subtopics;
CREATE TRIGGER trg_guard_syllabus_subtopics BEFORE INSERT OR UPDATE OR DELETE ON syllabus_subtopics
  FOR EACH ROW EXECUTE FUNCTION guard_syllabus_content();
DROP TRIGGER IF EXISTS trg_guard_course_outcomes ON course_outcomes;
CREATE TRIGGER trg_guard_course_outcomes BEFORE INSERT OR UPDATE OR DELETE ON course_outcomes
  FOR EACH ROW EXECUTE FUNCTION guard_syllabus_content();

-- ---------------------------------------------------------------------------------------------------------------
-- C. Change detection records (written by src/syllabus-versioning.js at activation)
-- ---------------------------------------------------------------------------------------------------------------
-- syllabus_changes: one row per ADDED / REMOVED / MODIFIED / RENAMED unit, topic, subtopic or CO between the previous
-- ACTIVE version (old_version_id) and the activated one. entity_id is the human key (code or title); the ids and the
-- rule that matched the pair are recorded too.
ALTER TABLE syllabus_changes ADD COLUMN IF NOT EXISTS old_entity_id UUID;
ALTER TABLE syllabus_changes ADD COLUMN IF NOT EXISTS new_entity_id UUID;
ALTER TABLE syllabus_changes ADD COLUMN IF NOT EXISTS match_rule TEXT;
ALTER TABLE syllabus_changes ADD COLUMN IF NOT EXISTS detected_by UUID REFERENCES users(id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'syllabus_changes_change_type_check') THEN
    ALTER TABLE syllabus_changes ADD CONSTRAINT syllabus_changes_change_type_check
      CHECK (change_type IN ('ADDED', 'REMOVED', 'MODIFIED', 'RENAMED', 'POTENTIAL_MAPPING')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'syllabus_changes_entity_type_check') THEN
    ALTER TABLE syllabus_changes ADD CONSTRAINT syllabus_changes_entity_type_check
      CHECK (entity_type IN ('unit', 'topic', 'subtopic', 'course_outcome')) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_syllabus_changes_new_version ON syllabus_changes (new_version_id);

-- affected_questions: one row per (change, question) the change makes review-required. The question (not only its
-- canonical record: legacy questions may have none) is recorded, with the action taken at detection:
--   action_taken 'changes_requested' (APPROVED -> CHANGES_REQUESTED, audited) or 'flagged' (status unchanged).
-- reviewed / review_outcome / reviewed_by / reviewed_at record the HOD's resolution ('remapped').
ALTER TABLE affected_questions ADD COLUMN IF NOT EXISTS question_id UUID REFERENCES questions(id) ON DELETE CASCADE;
ALTER TABLE affected_questions ALTER COLUMN canonical_question_id DROP NOT NULL;
ALTER TABLE affected_questions ADD COLUMN IF NOT EXISTS action_taken TEXT;
ALTER TABLE affected_questions ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE affected_questions ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affected_questions_action_taken_check') THEN
    ALTER TABLE affected_questions ADD CONSTRAINT affected_questions_action_taken_check
      CHECK (action_taken IS NULL OR action_taken IN ('changes_requested', 'flagged'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_affected_questions_change_question ON affected_questions (syllabus_change_id, question_id) WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_affected_questions_question_id ON affected_questions (question_id);

-- Every move of a question to another syllabus version (append-only history):
--   auto_unchanged  activation re-mapped it because every item it maps to is unchanged in the new version; such a
--                   question also stays eligible for examinations created on the version it came from;
--   hod_mapping     the HOD mapped a legacy / superseded question, with a reason;
--   author_edit     the author's edit of a DRAFT / CHANGES_REQUESTED question moved it to the current version.
CREATE TABLE IF NOT EXISTS question_syllabus_remaps (
  id               BIGSERIAL PRIMARY KEY,
  question_id      UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  from_version_id  UUID REFERENCES syllabus_versions(id),
  to_version_id    UUID NOT NULL REFERENCES syllabus_versions(id),
  kind             TEXT NOT NULL CHECK (kind IN ('auto_unchanged', 'hod_mapping', 'author_edit')),
  old_mapping      JSONB,
  new_mapping      JSONB,
  reason           TEXT,
  performed_by     UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'hod_mapping' OR length(trim(coalesce(reason, ''))) >= 10)
);
CREATE INDEX IF NOT EXISTS idx_question_syllabus_remaps_question ON question_syllabus_remaps (question_id);
CREATE INDEX IF NOT EXISTS idx_question_syllabus_remaps_from ON question_syllabus_remaps (from_version_id, kind);

CREATE OR REPLACE FUNCTION protect_question_syllabus_remaps()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM questions WHERE id = OLD.question_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'question_syllabus_remaps is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_protect_question_syllabus_remaps ON question_syllabus_remaps;
CREATE TRIGGER trg_protect_question_syllabus_remaps BEFORE UPDATE OR DELETE ON question_syllabus_remaps
  FOR EACH ROW EXECUTE FUNCTION protect_question_syllabus_remaps();

-- ---------------------------------------------------------------------------------------------------------------
-- D. Subtopic integrity and verifier ids
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE questions ADD COLUMN IF NOT EXISTS subtopic_id UUID REFERENCES syllabus_subtopics(id);
CREATE INDEX IF NOT EXISTS idx_questions_subtopic_id ON questions (subtopic_id) WHERE subtopic_id IS NOT NULL;
COMMENT ON COLUMN questions.subtopic IS 'Subtopic title as stored (legacy rows have only this); subtopic_id is authoritative when set';
ALTER TABLE canonical_questions ADD COLUMN IF NOT EXISTS verified_syllabus_subtopic_id UUID REFERENCES syllabus_subtopics(id);
ALTER TABLE canonical_questions ADD COLUMN IF NOT EXISTS verified_by_reviewer_ids UUID[];
ALTER TABLE question_reviews ADD COLUMN IF NOT EXISTS verified_syllabus_subtopic_id UUID REFERENCES syllabus_subtopics(id);
ALTER TABLE review_resolutions ADD COLUMN IF NOT EXISTS final_syllabus_subtopic_id UUID REFERENCES syllabus_subtopics(id);
ALTER TABLE review_resolutions ADD COLUMN IF NOT EXISTS verified_by_reviewer_ids UUID[];
ALTER TABLE question_course_outcomes ADD COLUMN IF NOT EXISTS verified_by_reviewer_ids UUID[];
COMMENT ON COLUMN review_resolutions.verified_by_reviewer_ids IS 'Every reviewer whose verdicts formed a consensus result (decided_by is NULL when several agreed)';

DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'question_course_outcomes'::regclass AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%source%'
  LOOP EXECUTE format('ALTER TABLE question_course_outcomes DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE question_course_outcomes ADD CONSTRAINT question_course_outcomes_source_check
  CHECK (source IN ('ai', 'manual', 'reviewer', 'bulk', 'syllabus_remap', 'hod_mapping'));

-- A question's subtopic_id is an active-or-historical subtopic of its own syllabus version.
CREATE OR REPLACE FUNCTION check_question_subtopic_version()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.subtopic_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM syllabus_subtopics st JOIN syllabus_topics t ON t.id = st.syllabus_topic_id JOIN syllabus_units u ON u.id = t.syllabus_unit_id
     WHERE st.id = NEW.subtopic_id AND u.syllabus_version_id IS NOT DISTINCT FROM NEW.syllabus_version_id) THEN
    RAISE EXCEPTION 'The question''s subtopic is not part of its syllabus version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_check_question_subtopic_version ON questions;
CREATE TRIGGER trg_check_question_subtopic_version
  AFTER INSERT OR UPDATE OF subtopic_id, syllabus_version_id ON questions
  FOR EACH ROW WHEN (NEW.subtopic_id IS NOT NULL)
  EXECUTE FUNCTION check_question_subtopic_version();

-- ---------------------------------------------------------------------------------------------------------------
-- E. Content lock (038 section 12) with the re-mapping hatch. Inside a transaction that ran
--      SELECT set_config('app.syllabus_remap', 'on', true)
--    a locked question may change syllabus_version_id and subtopic_id only, and only onto its offering's ACTIVE
--    version. Used by the activation (unchanged items) and the HOD mapping route; both audit every move.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION protect_locked_question_content()
RETURNS TRIGGER AS $$
DECLARE
  v_cols TEXT[] := ARRAY['question_type', 'question_text', 'option_a', 'option_b', 'option_c', 'option_d',
                         'correct_answer', 'model_answer', 'answer_data', 'marks', 'difficulty', 'topic', 'subtopic',
                         'submitted_bloom_level', 'submitted_cos', 'question_hash', 'course_offering_id', 'subject_id',
                         'section_id', 'campus_id', 'syllabus_version_id', 'subtopic_id', 'submitted_by', 'approved_by', 'approved_at'];
  v_old JSONB := to_jsonb(OLD);
  v_new JSONB := to_jsonb(NEW);
  v_changed TEXT[];
BEGIN
  IF COALESCE(current_setting('app.question_content_override', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF OLD.question_status <> 'APPROVED' THEN
    v_cols := array_append(v_cols, 'bloom_level');
  END IF;
  IF OLD.question_status <> 'REJECTED' THEN
    v_cols := array_append(v_cols, 'canonical_question_id');
  END IF;
  IF COALESCE(current_setting('app.syllabus_remap', true), '') = 'on' THEN
    v_cols := array_remove(array_remove(v_cols, 'syllabus_version_id'), 'subtopic_id');
    IF NEW.syllabus_version_id IS DISTINCT FROM OLD.syllabus_version_id AND NOT EXISTS (
      SELECT 1 FROM syllabus_versions sv WHERE sv.id = NEW.syllabus_version_id AND sv.course_offering_id = NEW.course_offering_id AND sv.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'A syllabus re-mapping moves a question only onto its offering''s ACTIVE syllabus version (question %)', NEW.id;
    END IF;
  END IF;

  SELECT array_agg(c ORDER BY c) INTO v_changed
    FROM unnest(v_cols) AS c
   WHERE v_old -> c IS DISTINCT FROM v_new -> c;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'Question content is locked while the question is % (changed: %); request changes to revise it',
      OLD.question_status, array_to_string(v_changed, ', ');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- (trigger trg_question_content_lock from 038 is kept as is; the function is replaced in place)

-- ---------------------------------------------------------------------------------------------------------------
-- F. Verified mapping and the quality gate
-- ---------------------------------------------------------------------------------------------------------------
-- TRUE when the question's canonical record carries a reviewer-verified Bloom level, a reviewer-verified topic (and
-- unit / subtopic when set) of the question's OWN syllabus version, and at least one CO mapping of that version whose
-- verifier is recorded (verified_by). Generation eligibility (exam-generator.js), analytics and the copy check use it.
CREATE OR REPLACE FUNCTION question_has_verified_mapping(p_question_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM questions q
      JOIN canonical_questions cq ON cq.id = q.canonical_question_id
      JOIN syllabus_topics t ON t.id = cq.verified_syllabus_topic_id AND t.is_active
      JOIN syllabus_units u ON u.id = t.syllabus_unit_id AND u.is_active AND u.syllabus_version_id = q.syllabus_version_id
     WHERE q.id = p_question_id
       AND cq.verified_bloom_level IS NOT NULL
       AND (cq.verified_syllabus_unit_id IS NULL OR cq.verified_syllabus_unit_id = u.id)
       AND (cq.verified_syllabus_subtopic_id IS NULL OR EXISTS (
             SELECT 1 FROM syllabus_subtopics s WHERE s.id = cq.verified_syllabus_subtopic_id AND s.syllabus_topic_id = t.id AND s.is_active))
       AND EXISTS (
             SELECT 1 FROM question_course_outcomes qco JOIN course_outcomes oc ON oc.id = qco.course_outcome_id
              WHERE qco.canonical_question_id = q.canonical_question_id AND qco.verified_by IS NOT NULL
                AND oc.syllabus_version_id = q.syllabus_version_id AND oc.is_active))
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION question_has_verified_mapping(UUID) IS
  'Reviewer-verified Bloom, topic (unit/subtopic when set) and CO (verified_by recorded) in the question''s own syllabus version (042)';

-- Quality gate (041 version) with: the version must be approved (ACTIVE or SUPERSEDED status); the topic, CO and Bloom
-- level must be reviewer-verified for the question's own version (free-text topics no longer satisfy it); a subtopic
-- (verified, else the question's subtopic_id, else the legacy text) must sit under the verified topic.
CREATE OR REPLACE FUNCTION validate_question_for_active(p_question_id UUID, p_from_status TEXT DEFAULT NULL)
RETURNS TABLE(valid BOOLEAN, errors TEXT[]) AS $$
DECLARE
  q RECORD;
  error_list TEXT[] := ARRAY[]::TEXT[];
  v_topic RECORD;
  v_from TEXT;
BEGIN
  SELECT qs.*, sv.status AS sv_status, sv.course_offering_id AS sv_offering_id,
         cq.verified_syllabus_topic_id AS verified_topic_id, cq.verified_syllabus_unit_id AS verified_unit_id,
         cq.verified_syllabus_subtopic_id AS verified_subtopic_id, cq.verified_bloom_level AS verified_bloom
  INTO q
  FROM questions qs
  LEFT JOIN syllabus_versions sv ON sv.id = qs.syllabus_version_id
  LEFT JOIN canonical_questions cq ON cq.id = qs.canonical_question_id
  WHERE qs.id = p_question_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, ARRAY['Question not found']::TEXT[];
    RETURN;
  END IF;

  -- APPROVED -> ACTIVE (activation) or RETIRED -> ACTIVE (restore); the transition guard owns the rest of the table.
  v_from := COALESCE(p_from_status, q.question_status);
  IF v_from IS NULL OR v_from NOT IN ('APPROVED', 'RETIRED') THEN
    error_list := array_append(error_list, 'Question must be APPROVED (or RETIRED, to restore) before ACTIVE');
  END IF;
  IF q.course_offering_id IS NULL THEN error_list := array_append(error_list, 'Missing course offering'); END IF;
  IF q.subject_id IS NULL THEN error_list := array_append(error_list, 'Missing subject'); END IF;
  IF q.syllabus_version_id IS NULL THEN
    error_list := array_append(error_list, 'Missing syllabus version mapping');
  ELSE
    IF q.sv_offering_id IS DISTINCT FROM q.course_offering_id THEN error_list := array_append(error_list, 'Syllabus version does not belong to this course offering'); END IF;
    IF q.sv_status IS NULL OR q.sv_status NOT IN ('ACTIVE', 'SUPERSEDED') THEN error_list := array_append(error_list, 'Syllabus version is not approved'); END IF;
  END IF;

  -- 042: the reviewer-verified topic of the question's own version (free text is not a mapping).
  IF q.verified_topic_id IS NULL THEN
    error_list := array_append(error_list, 'Missing reviewer-verified topic');
  ELSIF q.syllabus_version_id IS NOT NULL THEN
    SELECT t.id, u.id AS unit_id INTO v_topic
      FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
     WHERE t.id = q.verified_topic_id AND u.syllabus_version_id = q.syllabus_version_id AND t.is_active AND u.is_active;
    IF NOT FOUND THEN
      error_list := array_append(error_list, 'Verified topic is not part of the question''s syllabus version');
    ELSIF q.verified_unit_id IS NOT NULL AND q.verified_unit_id <> v_topic.unit_id THEN
      error_list := array_append(error_list, 'Verified unit does not contain the verified topic');
    END IF;
  END IF;

  IF q.canonical_question_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM question_course_outcomes WHERE canonical_question_id = q.canonical_question_id) THEN
      error_list := array_append(error_list, 'Missing course outcome mapping');
    ELSIF NOT EXISTS (
      SELECT 1 FROM question_course_outcomes qco JOIN course_outcomes oc ON oc.id = qco.course_outcome_id
       WHERE qco.canonical_question_id = q.canonical_question_id AND qco.verified_by IS NOT NULL
         AND oc.syllabus_version_id IS NOT DISTINCT FROM q.syllabus_version_id AND oc.is_active) THEN
      error_list := array_append(error_list, 'Course outcome mapping is not reviewer-verified for the question''s syllabus version');
    END IF;
  ELSE
    error_list := array_append(error_list, 'Missing canonical question mapping');
  END IF;

  IF q.bloom_level IS NULL THEN error_list := array_append(error_list, 'Missing Bloom level'); END IF;
  IF q.canonical_question_id IS NOT NULL AND q.verified_bloom IS NULL THEN
    error_list := array_append(error_list, 'Missing reviewer-verified Bloom level');
  END IF;
  IF q.difficulty IS NULL THEN error_list := array_append(error_list, 'Missing difficulty level'); END IF;
  IF q.marks IS NULL OR q.marks <= 0 THEN error_list := array_append(error_list, 'Invalid marks (must be > 0)'); END IF;
  IF q.question_type IS NULL THEN error_list := array_append(error_list, 'Missing question type'); END IF;
  IF q.question_text IS NULL OR length(trim(q.question_text)) < 10 THEN error_list := array_append(error_list, 'Question text too short or missing'); END IF;

  -- Type-specific rules (spec §10); mirrors src/question-types.js validateQuestionByType(forActivation).
  CASE q.question_type
    WHEN 'mcq' THEN
      IF q.option_a IS NULL OR q.option_b IS NULL OR q.option_c IS NULL OR q.option_d IS NULL THEN error_list := array_append(error_list, 'MCQ missing options'); END IF;
      IF q.correct_answer IS NULL THEN error_list := array_append(error_list, 'MCQ missing correct answer'); END IF;
    WHEN 'true_false' THEN
      IF upper(coalesce(q.correct_answer, '')) NOT IN ('TRUE', 'FALSE') THEN error_list := array_append(error_list, 'True/False needs a correct answer of TRUE or FALSE'); END IF;
    WHEN 'assertion_reason' THEN
      IF coalesce(trim(q.answer_data->>'assertion'), '') = '' OR coalesce(trim(q.answer_data->>'reason'), '') = '' THEN error_list := array_append(error_list, 'Assertion-Reason needs an assertion and a reason'); END IF;
      IF upper(coalesce(q.correct_answer, '')) NOT IN ('A', 'B', 'C', 'D') THEN error_list := array_append(error_list, 'Assertion-Reason needs a correct answer of A, B, C or D'); END IF;
    WHEN 'numerical' THEN
      IF coalesce(q.answer_data->>'expected_value', '') !~ '^\s*-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?\s*$' THEN error_list := array_append(error_list, 'Numerical needs an expected numeric answer'); END IF;
    WHEN 'fill_blank' THEN
      IF COALESCE(CASE WHEN jsonb_typeof(q.answer_data->'answers') = 'array' THEN jsonb_array_length(q.answer_data->'answers') END, 0) = 0 THEN error_list := array_append(error_list, 'Fill in the Blank needs accepted answers'); END IF;
    WHEN 'programming' THEN
      IF coalesce(trim(q.answer_data->>'language'), '') = '' THEN error_list := array_append(error_list, 'Programming needs a language'); END IF;
    WHEN 'case_study' THEN
      IF length(coalesce(trim(q.answer_data->>'case_text'), '')) < 20 THEN error_list := array_append(error_list, 'Case Study needs the case text'); END IF;
    WHEN 'diagram' THEN
      IF NOT EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = p_question_id AND a.scan_status = 'clean') THEN
        error_list := array_append(error_list, 'Diagram question needs a clean attached diagram');
      ELSIF NOT EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = p_question_id AND a.scan_status = 'clean'
                          AND a.file_type IN ('image/png', 'image/jpeg')) THEN
        error_list := array_append(error_list, 'Diagram question needs its diagram as a PNG or JPEG image (the printed paper can only embed those)');
      END IF;
    ELSE NULL;
  END CASE;

  IF EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = p_question_id AND a.scan_status <> 'clean') THEN
    error_list := array_append(error_list, 'Attachment has not passed the virus scan');
  END IF;

  -- Subtopic (spec §3/§8): the verified one, else the question's subtopic_id, else the legacy title, must be an active
  -- subtopic of the verified topic.
  IF q.verified_topic_id IS NOT NULL THEN
    IF q.verified_subtopic_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM syllabus_subtopics st WHERE st.id = q.verified_subtopic_id AND st.syllabus_topic_id = q.verified_topic_id AND st.is_active) THEN
        error_list := array_append(error_list, 'Verified subtopic is not part of the verified topic');
      END IF;
    ELSIF q.subtopic_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM syllabus_subtopics st WHERE st.id = q.subtopic_id AND st.syllabus_topic_id = q.verified_topic_id AND st.is_active) THEN
        error_list := array_append(error_list, 'Subtopic is not part of the question''s verified topic');
      END IF;
    ELSIF q.subtopic IS NOT NULL AND trim(q.subtopic) <> '' AND NOT EXISTS (
      SELECT 1 FROM syllabus_subtopics st WHERE st.syllabus_topic_id = q.verified_topic_id AND st.is_active
         AND lower(trim(st.title)) = lower(trim(q.subtopic))) THEN
      error_list := array_append(error_list, 'Subtopic is not part of the question''s verified topic');
    END IF;
  END IF;

  IF q.model_answer IS NULL OR length(trim(q.model_answer)) < 5 THEN error_list := array_append(error_list, 'Missing or insufficient model answer'); END IF;
  IF q.approved_by IS NULL THEN error_list := array_append(error_list, 'Missing reviewer approval'); END IF;

  IF EXISTS (
    SELECT 1 FROM question_relationships r
    WHERE r.status = 'pending' AND r.relationship_type = 'duplicate'
      AND (r.source_question_id = p_question_id
           OR (r.target_question_id = p_question_id AND EXISTS (
                 SELECT 1 FROM questions s WHERE s.id = r.source_question_id
                    AND s.question_status NOT IN ('DRAFT', 'CHANGES_REQUESTED', 'REJECTED'))))
  ) THEN
    error_list := array_append(error_list, 'Unresolved duplicate conflict');
  END IF;

  RETURN QUERY SELECT (array_length(error_list, 1) IS NULL), error_list;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION validate_question_for_active(UUID, TEXT) IS
  'Quality gate for ACTIVE (spec §11). Accepts APPROVED (activate) or RETIRED (restore) as the prior state; 042 requires a reviewer-verified topic, CO and Bloom level of the question''s own (approved) syllabus version. Returns (valid, errors[]).';

-- ---------------------------------------------------------------------------------------------------------------
-- G. Report (nothing below changes data)
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n_inelig INT; n_active INT; n_ptr INT; n_cons INT; n_sub INT; v_dist TEXT;
BEGIN
  SELECT count(*) FILTER (WHERE NOT question_has_verified_mapping(q.id)), count(*) INTO n_inelig, n_active
    FROM questions q WHERE q.question_status = 'ACTIVE';
  IF n_inelig > 0 THEN
    RAISE NOTICE '042: % of % ACTIVE question(s) lack a reviewer-verified topic, CO or Bloom level in their own syllabus version; they stay ACTIVE but are not generation-eligible until re-reviewed or mapped (HOD: Question mapping)', n_inelig, n_active;
  END IF;
  SELECT count(*) INTO n_ptr FROM course_offerings co
   WHERE co.syllabus_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM syllabus_versions sv WHERE sv.id = co.syllabus_version_id AND sv.status = 'ACTIVE');
  IF n_ptr > 0 THEN
    RAISE NOTICE '042: % course offering(s) point at a syllabus version that is not HOD-approved; examinations refuse them until a version is approved', n_ptr;
  END IF;
  SELECT count(*) INTO n_cons FROM question_course_outcomes WHERE verified_at IS NOT NULL AND verified_by IS NULL;
  IF n_cons > 0 THEN
    RAISE NOTICE '042: % CO mapping(s) were verified by a multi-reviewer consensus before 042 and have no recorded verifier; they count as unverified until the question is re-reviewed', n_cons;
  END IF;
  SELECT count(*) INTO n_sub FROM questions WHERE subtopic IS NOT NULL AND trim(subtopic) <> '' AND subtopic_id IS NULL;
  IF n_sub > 0 THEN
    RAISE NOTICE '042: % question(s) keep a subtopic title only (no subtopic_id); the reviewer verifies the subtopic on the next review', n_sub;
  END IF;
  SELECT string_agg(status || '=' || n, ', ' ORDER BY status) INTO v_dist FROM (SELECT status, count(*) n FROM syllabus_versions GROUP BY 1) x;
  RAISE NOTICE '042: syllabus versions by status: %', COALESCE(v_dist, 'none');
END $$;
