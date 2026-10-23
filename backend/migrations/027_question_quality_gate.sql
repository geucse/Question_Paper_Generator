-- Question quality gate - docs/development/PIVOT_SPEC_V2.md section 11
-- Questions must pass validation before transitioning to ACTIVE
-- Validates: academic context, metadata, CO, Bloom, difficulty, type-specific requirements

-- Function: Validate question is ready for ACTIVE status
-- Returns: { valid: boolean, errors: string[] }
CREATE OR REPLACE FUNCTION validate_question_for_active(p_question_id UUID)
RETURNS TABLE(valid BOOLEAN, errors TEXT[]) AS $$
DECLARE
  q RECORD;
  error_list TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Get question with all related data
  SELECT
    qs.*,
    co.id as offering_id,
    co.syllabus_version_id,
    sv.approval_status as syllabus_approved
  INTO q
  FROM questions qs
  LEFT JOIN course_offerings co ON qs.course_offering_id = co.id
  LEFT JOIN syllabus_versions sv ON co.syllabus_version_id = sv.id
  WHERE qs.id = p_question_id;

  IF NOT FOUND THEN
    error_list := array_append(error_list, 'Question not found');
    RETURN QUERY SELECT false, error_list;
    RETURN;
  END IF;

  -- Must be APPROVED first
  IF q.question_status != 'APPROVED' THEN
    error_list := array_append(error_list, 'Question must be APPROVED before ACTIVE');
  END IF;

  -- Valid academic context
  IF q.course_offering_id IS NULL THEN
    error_list := array_append(error_list, 'Missing course offering');
  END IF;

  IF q.subject_id IS NULL THEN
    error_list := array_append(error_list, 'Missing subject');
  END IF;

  -- Valid syllabus/topic mapping
  IF q.syllabus_version_id IS NULL THEN
    error_list := array_append(error_list, 'Missing syllabus version mapping');
  END IF;

  IF q.topic IS NULL OR q.topic = '' THEN
    error_list := array_append(error_list, 'Missing topic mapping');
  END IF;

  -- Course outcomes (must have at least one)
  -- Note: COs are mapped to canonical_question_id, not question_id
  IF q.canonical_question_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM question_course_outcomes
      WHERE canonical_question_id = q.canonical_question_id
    ) THEN
      error_list := array_append(error_list, 'Missing course outcome mapping');
    END IF;
  ELSE
    error_list := array_append(error_list, 'Missing canonical question mapping');
  END IF;

  -- Bloom level
  IF q.bloom_level IS NULL THEN
    error_list := array_append(error_list, 'Missing Bloom level');
  END IF;

  -- Difficulty
  IF q.difficulty IS NULL THEN
    error_list := array_append(error_list, 'Missing difficulty level');
  END IF;

  -- Marks
  IF q.marks IS NULL OR q.marks <= 0 THEN
    error_list := array_append(error_list, 'Invalid marks (must be > 0)');
  END IF;

  -- Question type
  IF q.question_type IS NULL THEN
    error_list := array_append(error_list, 'Missing question type');
  END IF;

  -- Required content
  IF q.question_text IS NULL OR length(trim(q.question_text)) < 10 THEN
    error_list := array_append(error_list, 'Question text too short or missing');
  END IF;

  -- Type-specific validation
  IF q.question_type = 'objective' THEN
    -- MCQ must have options and correct answer
    IF q.option_a IS NULL OR q.option_b IS NULL OR
       q.option_c IS NULL OR q.option_d IS NULL THEN
      error_list := array_append(error_list, 'MCQ missing options');
    END IF;
    IF q.correct_answer IS NULL THEN
      error_list := array_append(error_list, 'MCQ missing correct answer');
    END IF;
  END IF;

  -- Must have model answer (any type)
  IF q.model_answer IS NULL OR length(trim(q.model_answer)) < 5 THEN
    error_list := array_append(error_list, 'Missing or insufficient model answer');
  END IF;

  -- Final reviewer decision (must have been reviewed)
  IF q.approved_by IS NULL THEN
    error_list := array_append(error_list, 'Missing reviewer approval');
  END IF;

  -- No unresolved duplicate conflict
  -- Check if duplicate detection tables exist and have unresolved conflicts
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'duplicate_questions'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM duplicate_questions dq
      WHERE (dq.question_id = p_question_id OR dq.duplicate_of_id = p_question_id)
        AND dq.classification = 'EXACT_DUPLICATE'
        AND dq.resolution_status IS NULL
    ) THEN
      error_list := array_append(error_list, 'Unresolved duplicate conflict');
    END IF;
  END IF;

  -- Return validation result
  RETURN QUERY SELECT (array_length(error_list, 1) IS NULL), error_list;
END;
$$ LANGUAGE plpgsql STABLE;

-- Trigger: Enforce quality gate on ACTIVE transition
CREATE OR REPLACE FUNCTION enforce_quality_gate()
RETURNS TRIGGER AS $$
DECLARE
  validation_result RECORD;
BEGIN
  -- Only enforce when transitioning TO ACTIVE
  IF NEW.question_status = 'ACTIVE' AND
     (TG_OP = 'INSERT' OR OLD.question_status != 'ACTIVE') THEN

    -- Validate question
    SELECT * INTO validation_result
    FROM validate_question_for_active(NEW.id);

    IF NOT validation_result.valid THEN
      RAISE EXCEPTION 'Quality gate failed: %',
        array_to_string(validation_result.errors, '; ');
    END IF;

    -- Set activation metadata
    NEW.activated_at := now();
    IF NEW.activated_by IS NULL THEN
      NEW.activated_by := NEW.approved_by; -- Default to approver
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_quality_gate
  BEFORE INSERT OR UPDATE OF question_status ON questions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_quality_gate();

-- Add missing columns referenced in quality gate
ALTER TABLE questions ADD COLUMN IF NOT EXISTS bloom_level TEXT
  CHECK (bloom_level IN ('Remember', 'Understand', 'Apply', 'Analyze', 'Evaluate', 'Create'));
ALTER TABLE questions ADD COLUMN IF NOT EXISTS syllabus_version_id UUID REFERENCES syllabus_versions(id);

-- Create index for quality gate checks
CREATE INDEX IF NOT EXISTS idx_questions_approved_by ON questions(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qco_canonical ON question_course_outcomes(canonical_question_id);

COMMENT ON FUNCTION validate_question_for_active IS 'Validates that a question meets all requirements for ACTIVE status. Returns (valid, errors[]).';
COMMENT ON FUNCTION enforce_quality_gate IS 'Trigger function that enforces quality gate when transitioning to ACTIVE. Blocks transition if validation fails.';
