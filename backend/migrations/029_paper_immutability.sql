-- Paper snapshot immutability - docs/development/PIVOT_SPEC_V2.md section 28
-- paper_questions must store complete snapshots
-- Once PRINT_READY, papers are LOCKED and immutable

-- Ensure paper_questions has snapshot columns
ALTER TABLE paper_questions ADD COLUMN IF NOT EXISTS question_text_snapshot TEXT;
ALTER TABLE paper_questions ADD COLUMN IF NOT EXISTS marks_snapshot INTEGER;
ALTER TABLE paper_questions ADD COLUMN IF NOT EXISTS metadata_snapshot JSONB;
ALTER TABLE paper_questions ADD COLUMN IF NOT EXISTS question_version_id UUID;

-- Function: Create immutable snapshot when adding questions to paper
CREATE OR REPLACE FUNCTION create_paper_question_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  q RECORD;
BEGIN
  -- Get full question details
  SELECT
    q.question_text,
    q.marks,
    q.option_a,
    q.option_b,
    q.option_c,
    q.option_d,
    q.correct_answer,
    q.model_answer,
    q.difficulty,
    q.bloom_level,
    q.topic,
    q.question_type,
    cq.id as canonical_id
  INTO q
  FROM questions q
  LEFT JOIN canonical_questions cq ON q.canonical_question_id = cq.id
  WHERE q.id = NEW.question_id;

  -- Store complete snapshot
  NEW.question_text_snapshot := q.question_text;
  NEW.marks_snapshot := q.marks;
  NEW.question_version_id := q.canonical_id;
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
    'snapshot_at', now()
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_create_paper_question_snapshot
  BEFORE INSERT ON paper_questions
  FOR EACH ROW
  EXECUTE FUNCTION create_paper_question_snapshot();

-- Function: Enforce paper immutability once PRINT_READY
CREATE OR REPLACE FUNCTION enforce_paper_immutability()
RETURNS TRIGGER AS $$
DECLARE
  approval_count INTEGER;
BEGIN
  -- Once PRINT_READY, paper is locked and immutable
  IF OLD.paper_status = 'PRINT_READY' AND NEW.paper_status = 'PRINT_READY' THEN
    IF OLD IS DISTINCT FROM NEW THEN
      RAISE EXCEPTION 'Cannot modify PRINT_READY paper. Create a new revision instead.';
    END IF;
  END IF;

  -- Track when paper becomes PRINT_READY
  IF NEW.paper_status = 'PRINT_READY' AND
     (TG_OP = 'INSERT' OR OLD.paper_status != 'PRINT_READY') THEN
    NEW.locked_at := now();

    -- Verify COE approval
    IF NEW.coe_approved_by IS NULL THEN
      RAISE EXCEPTION 'COE approval required before PRINT_READY';
    END IF;

    -- Count validator approvals
    SELECT COUNT(*) INTO approval_count
    FROM paper_validator_assignments
    WHERE paper_id = NEW.id
      AND is_active = true
      AND decision = 'APPROVE';

    IF approval_count != 4 THEN
      RAISE EXCEPTION 'All 4 validators must approve before PRINT_READY (currently: %)', approval_count;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_paper_immutability
  BEFORE UPDATE ON exam_papers
  FOR EACH ROW
  EXECUTE FUNCTION enforce_paper_immutability();

-- Prevent deletion of PRINT_READY papers
CREATE OR REPLACE FUNCTION prevent_print_ready_deletion()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.paper_status = 'PRINT_READY' THEN
    RAISE EXCEPTION 'Cannot delete PRINT_READY paper (id: %). Archive it instead.', OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_print_ready_deletion
  BEFORE DELETE ON exam_papers
  FOR EACH ROW
  EXECUTE FUNCTION prevent_print_ready_deletion();

-- Prevent modifications to paper_questions after paper is locked
CREATE OR REPLACE FUNCTION protect_locked_paper_questions()
RETURNS TRIGGER AS $$
DECLARE
  paper_locked BOOLEAN;
BEGIN
  SELECT (paper_status = 'PRINT_READY') INTO paper_locked
  FROM exam_papers
  WHERE id = COALESCE(NEW.paper_id, OLD.paper_id);

  IF paper_locked THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete questions from PRINT_READY paper';
    ELSIF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'Cannot modify questions in PRINT_READY paper';
    ELSIF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Cannot add questions to PRINT_READY paper';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_locked_paper_questions
  BEFORE INSERT OR UPDATE OR DELETE ON paper_questions
  FOR EACH ROW
  EXECUTE FUNCTION protect_locked_paper_questions();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_paper_questions_paper_locked ON paper_questions(paper_id)
  WHERE question_text_snapshot IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exam_papers_print_ready ON exam_papers(paper_status, locked_at)
  WHERE paper_status = 'PRINT_READY';

COMMENT ON TRIGGER trg_create_paper_question_snapshot ON paper_questions IS 'Creates immutable snapshot of question when added to paper. Historical papers never change when question bank changes.';
COMMENT ON TRIGGER trg_enforce_paper_immutability ON exam_papers IS 'PRINT_READY papers are locked and immutable. Any change requires a new revision.';
COMMENT ON COLUMN paper_questions.question_text_snapshot IS 'Immutable snapshot of question text at time of paper generation';
COMMENT ON COLUMN paper_questions.marks_snapshot IS 'Immutable snapshot of marks at time of paper generation';
COMMENT ON COLUMN paper_questions.metadata_snapshot IS 'Complete question metadata snapshot (options, answer, difficulty, bloom, etc.)';
