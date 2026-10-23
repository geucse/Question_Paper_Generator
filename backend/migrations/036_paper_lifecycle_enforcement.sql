-- 036 (was 032): close the gaps found in the post-pivot review.
--   1. PRINT_READY could be "unlocked" by any UPDATE that changed paper_status away from it.
--   2. Paper states were only enforced in route handlers ("no skipping states", spec §26).
--   3. "All 4 validators must approve" was hard-coded; spec §27 asks for it to be configurable.
--   4. ARCHIVED existed in the CHECK constraint but nothing could reach it.
--   5. paper_questions could be rewritten after a paper was generated/validated.
--   6. The quality gate accepted any non-empty free-text topic (spec §11: valid topic mapping).
--   7. Snapshots stored the canonical question id in question_version_id.
-- Additive only: no data is dropped, no existing migration is changed.
-- The transition table here must match src/paper-policy.js (test-paper-policy.mjs checks this).

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS required_approvals SMALLINT
  CHECK (required_approvals IS NULL OR required_approvals BETWEEN 3 AND 4);
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id);
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS archive_reason TEXT;

COMMENT ON COLUMN exam_papers.required_approvals IS
  'Validator approvals (of 4) this paper needs. Copied from system_state.required_validator_approvals when validators are assigned, then frozen.';

-- Institution-wide default (spec §27: default all 4 must approve). Changed only through /api/admin/settings/validation-policy.
INSERT INTO system_state (key, value, updated_at)
VALUES ('required_validator_approvals', '4', now())
ON CONFLICT (key) DO NOTHING;

-- Legacy papers that the old HOD+Admin flow marked admin_approved were mapped to COE_APPROVED by 028
-- without any validator review. Spec §38: previously approved legacy papers must be revalidated.
-- Done before the lifecycle trigger below exists, so it is not blocked by it.
UPDATE exam_papers SET paper_status = 'GENERATED'
WHERE paper_status = 'COE_APPROVED' AND coe_approved_by IS NULL;

-- ---------------------------------------------------------------------------
-- Paper lifecycle trigger (replaces trg_enforce_paper_immutability from 029)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_paper_lifecycle()
RETURNS TRIGGER AS $$
DECLARE
  v_override  BOOLEAN := COALESCE(current_setting('app.paper_override', true), '') = 'on';
  v_archive_cols TEXT[] := ARRAY['paper_status', 'archived_at', 'archived_by', 'archive_reason'];
  v_generation_cols TEXT[] := ARRAY['examination_id', 'generation_seed', 'generator_version', 'blueprint_version_id',
                                    'eligible_question_set_hash', 'paper_version', 'parent_paper_id', 'course_offering_id', 'subject_id'];
  v_required  INTEGER;
  v_total     INTEGER;
  v_approvals INTEGER;
  v_allowed   TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.paper_status NOT IN ('DRAFT', 'GENERATING') THEN
      RAISE EXCEPTION 'Invalid paper status on insert: % (a paper starts as DRAFT or GENERATING)', NEW.paper_status;
    END IF;
    RETURN NEW;
  END IF;

  -- ARCHIVED is terminal and frozen.
  IF OLD.paper_status = 'ARCHIVED' THEN
    IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
      RAISE EXCEPTION 'Cannot modify ARCHIVED paper (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- PRINT_READY is locked. The only permitted change is archiving, which may touch the archive fields only.
  IF OLD.paper_status = 'PRINT_READY' THEN
    IF NEW.paper_status = 'ARCHIVED' THEN
      IF (to_jsonb(OLD) - v_archive_cols) IS DISTINCT FROM (to_jsonb(NEW) - v_archive_cols) THEN
        RAISE EXCEPTION 'Archiving a PRINT_READY paper may only set its archive fields';
      END IF;
      RETURN NEW;
    END IF;
    IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
      RAISE EXCEPTION 'Cannot modify PRINT_READY paper. Create a new revision instead.';
    END IF;
    RETURN NEW;
  END IF;

  -- Generation metadata of an examination paper never changes once it has been generated (spec §24, §28).
  IF OLD.examination_id IS NOT NULL AND OLD.paper_status NOT IN ('DRAFT', 'GENERATING')
     AND (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(v_generation_cols) AS k)
         IS DISTINCT FROM
         (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(v_generation_cols) AS k) THEN
    RAISE EXCEPTION 'Generation metadata of paper % cannot change after generation (fields: %)', OLD.id, array_to_string(v_generation_cols, ', ');
  END IF;

  -- The approval threshold is frozen once validators are assigned; only the admin reset may clear it.
  IF OLD.required_approvals IS NOT NULL AND NEW.required_approvals IS DISTINCT FROM OLD.required_approvals AND NOT v_override THEN
    RAISE EXCEPTION 'required_approvals is frozen for paper % once validators are assigned', OLD.id;
  END IF;

  IF NEW.paper_status IS NOT DISTINCT FROM OLD.paper_status THEN
    RETURN NEW;
  END IF;

  -- Prerequisites, checked before the transition table so the error names the missing approval.
  IF NEW.paper_status IN ('VALIDATED', 'COE_APPROVED', 'PRINT_READY') THEN
    v_required := LEAST(4, GREATEST(3, COALESCE(OLD.required_approvals, 4)));
    SELECT COUNT(*), COUNT(*) FILTER (WHERE decision = 'APPROVE')
      INTO v_total, v_approvals
      FROM paper_validator_assignments
     WHERE paper_id = NEW.id AND is_active = TRUE;

    IF NEW.paper_status IN ('COE_APPROVED', 'PRINT_READY') AND NEW.coe_approved_by IS NULL THEN
      RAISE EXCEPTION 'COE approval required before %', NEW.paper_status;
    END IF;
    IF NEW.paper_status = 'COE_APPROVED' AND NEW.coe_approval_totp_verified IS NOT TRUE THEN
      RAISE EXCEPTION 'COE approval must be TOTP-verified';
    END IF;
    IF v_total <> 4 THEN
      RAISE EXCEPTION 'Paper must have exactly 4 active validators before % (currently: %)', NEW.paper_status, v_total;
    END IF;
    IF v_approvals < v_required THEN
      RAISE EXCEPTION 'At least % of 4 validators must approve before % (currently: %)', v_required, NEW.paper_status, v_approvals;
    END IF;
  END IF;

  v_allowed := CASE OLD.paper_status
    WHEN 'DRAFT'              THEN ARRAY['GENERATING']
    WHEN 'GENERATING'         THEN ARRAY['GENERATED', 'DRAFT']
    WHEN 'GENERATED'          THEN ARRAY['VALIDATION_PENDING', 'REGENERATED', 'ARCHIVED']
    WHEN 'VALIDATION_PENDING' THEN ARRAY['VALIDATED', 'CHANGES_REQUIRED']
    WHEN 'CHANGES_REQUIRED'   THEN ARRAY['REGENERATED', 'ARCHIVED']
    WHEN 'REGENERATED'        THEN ARRAY['ARCHIVED']
    WHEN 'VALIDATED'          THEN ARRAY['COE_APPROVED']
    WHEN 'COE_APPROVED'       THEN ARRAY['PRINT_READY']
    ELSE ARRAY[]::TEXT[]
  END;

  IF NEW.paper_status = ANY (v_allowed) THEN
    IF NEW.paper_status = 'PRINT_READY' THEN
      NEW.locked_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- Admin emergency reset (spec §36): routes/admin.js sets app.paper_override inside its transaction.
  IF v_override AND NEW.paper_status = 'GENERATED'
     AND OLD.paper_status IN ('VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED', 'COE_APPROVED') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid paper status transition: % -> %', OLD.paper_status, NEW.paper_status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_paper_immutability ON exam_papers;
DROP FUNCTION IF EXISTS enforce_paper_immutability();
DROP TRIGGER IF EXISTS trg_enforce_paper_lifecycle ON exam_papers;
CREATE TRIGGER trg_enforce_paper_lifecycle
  BEFORE INSERT OR UPDATE ON exam_papers
  FOR EACH ROW EXECUTE FUNCTION enforce_paper_lifecycle();

COMMENT ON TRIGGER trg_enforce_paper_lifecycle ON exam_papers IS
  'Paper state machine (spec §26), PRINT_READY/ARCHIVED lock (§28), validator + COE prerequisites (§29). Mirrors src/paper-policy.js.';

-- ---------------------------------------------------------------------------
-- Deletion: generated examination papers and locked papers are history, never deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_print_ready_deletion()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.paper_status IN ('PRINT_READY', 'ARCHIVED')
     OR (OLD.examination_id IS NOT NULL AND OLD.paper_status NOT IN ('DRAFT', 'GENERATING')) THEN
    RAISE EXCEPTION 'Cannot delete % paper (id: %). Archive it instead.', OLD.paper_status, OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- paper_questions may only be written while the paper is being built.
-- Validators approve a fixed question list; any change after that is a new revision.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION protect_locked_paper_questions()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT paper_status INTO v_status FROM exam_papers WHERE id = COALESCE(NEW.paper_id, OLD.paper_id);
  -- Parent already gone (cascade delete of a DRAFT/GENERATING paper) or still being built: allowed.
  IF v_status IS NULL OR v_status IN ('DRAFT', 'GENERATING') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'Cannot % questions of a % paper; regenerate a new revision instead', TG_OP, v_status;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Snapshot: record the real question version, and the canonical id in the metadata.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_paper_question_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  q RECORD;
BEGIN
  SELECT qs.question_text, qs.marks, qs.option_a, qs.option_b, qs.option_c, qs.option_d,
         qs.correct_answer, qs.model_answer, qs.difficulty, qs.bloom_level, qs.topic, qs.question_type,
         qs.canonical_question_id, cq.current_version_id
    INTO q
    FROM questions qs
    LEFT JOIN canonical_questions cq ON cq.id = qs.canonical_question_id
   WHERE qs.id = NEW.question_id;

  NEW.question_text_snapshot := q.question_text;
  NEW.marks_snapshot := q.marks;
  NEW.question_version_id := q.current_version_id;
  NEW.metadata_snapshot := jsonb_build_object(
    'question_type', q.question_type,
    'difficulty', q.difficulty,
    'bloom_level', q.bloom_level,
    'topic', q.topic,
    'option_a', q.option_a,
    'option_b', q.option_b,
    'option_c', q.option_c,
    'option_d', q.option_d,
    'correct_answer', q.correct_answer,
    'model_answer', q.model_answer,
    'canonical_question_id', q.canonical_question_id,
    'snapshot_at', now()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Quality gate: the topic must belong to the question's syllabus version (spec §11).
-- Accepted when either the reviewer-verified topic (canonical_questions.verified_syllabus_topic_id)
-- belongs to that syllabus version, or the free-text topic matches an active topic title in it.
-- Existing ACTIVE questions are not re-checked; the gate runs on the transition to ACTIVE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_question_for_active(p_question_id UUID)
RETURNS TABLE(valid BOOLEAN, errors TEXT[]) AS $$
DECLARE
  q RECORD;
  error_list TEXT[] := ARRAY[]::TEXT[];
  v_topic_ok BOOLEAN := FALSE;
BEGIN
  SELECT qs.*, sv.approval_status AS sv_status, sv.course_offering_id AS sv_offering_id,
         cq.verified_syllabus_topic_id AS verified_topic_id
  INTO q
  FROM questions qs
  LEFT JOIN syllabus_versions sv ON sv.id = qs.syllabus_version_id
  LEFT JOIN canonical_questions cq ON cq.id = qs.canonical_question_id
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

  IF q.verified_topic_id IS NULL AND (q.topic IS NULL OR trim(q.topic) = '') THEN
    error_list := array_append(error_list, 'Missing topic mapping');
  ELSIF q.syllabus_version_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
       WHERE u.syllabus_version_id = q.syllabus_version_id AND t.is_active AND u.is_active
         AND (t.id = q.verified_topic_id
              OR (q.topic IS NOT NULL AND lower(trim(t.title)) = lower(trim(q.topic))))
    ) INTO v_topic_ok;
    IF NOT v_topic_ok THEN
      error_list := array_append(error_list, 'Topic is not part of the question''s syllabus version');
    END IF;
  END IF;

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
-- Indexes for the new checks
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_paper_issues_open ON paper_issues(paper_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_pva_paper_active ON paper_validator_assignments(paper_id) WHERE is_active;
