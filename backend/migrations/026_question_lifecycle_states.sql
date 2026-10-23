-- Question lifecycle state machine - docs/development/PIVOT_SPEC_V2.md section 7
-- New states: DRAFT → SUBMITTED → UNDER_REVIEW → CHANGES_REQUESTED ↔ RESUBMITTED → APPROVED → ACTIVE → RETIRED
-- Terminal state: REJECTED

-- Add new question_status field with proper state machine
ALTER TABLE questions ADD COLUMN question_status TEXT;

-- Migrate existing status values to new state machine
-- docs/development/PIVOT_SPEC_V2.md section 38: Legacy question status migration
UPDATE questions
SET question_status = CASE
  WHEN is_draft = true THEN 'DRAFT'
  WHEN status = 'pending' THEN 'SUBMITTED'
  WHEN status = 'ai_cleared' THEN 'UNDER_REVIEW'
  WHEN status = 'flagged' THEN 'UNDER_REVIEW'
  WHEN status = 'needs_teacher_fix' THEN 'CHANGES_REQUESTED'
  WHEN status = 'approved' THEN 'APPROVED'
  WHEN status = 'rejected' THEN 'REJECTED'
  ELSE 'DRAFT'
END;

-- Make question_status NOT NULL with proper constraint
ALTER TABLE questions ALTER COLUMN question_status SET NOT NULL;
ALTER TABLE questions ADD CONSTRAINT questions_question_status_check
  CHECK (question_status IN (
    'DRAFT',
    'SUBMITTED',
    'UNDER_REVIEW',
    'CHANGES_REQUESTED',
    'RESUBMITTED',
    'APPROVED',
    'ACTIVE',
    'RETIRED',
    'REJECTED'
  ));

-- Add state transition tracking fields
ALTER TABLE questions ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE questions ADD COLUMN approved_by UUID REFERENCES users(id);
ALTER TABLE questions ADD COLUMN activated_at TIMESTAMPTZ;
ALTER TABLE questions ADD COLUMN activated_by UUID REFERENCES users(id);
ALTER TABLE questions ADD COLUMN retired_at TIMESTAMPTZ;
ALTER TABLE questions ADD COLUMN retired_by UUID REFERENCES users(id);
ALTER TABLE questions ADD COLUMN retirement_reason TEXT;

-- Keep old status field temporarily for backward compatibility
-- Will be removed after frontend migration
-- Sync old status with new question_status via trigger
CREATE OR REPLACE FUNCTION sync_question_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Sync new question_status back to old status field for backward compatibility
  NEW.status := CASE NEW.question_status
    WHEN 'DRAFT' THEN 'pending'
    WHEN 'SUBMITTED' THEN 'pending'
    WHEN 'UNDER_REVIEW' THEN 'ai_cleared'
    WHEN 'CHANGES_REQUESTED' THEN 'needs_teacher_fix'
    WHEN 'RESUBMITTED' THEN 'pending'
    WHEN 'APPROVED' THEN 'approved'
    WHEN 'ACTIVE' THEN 'approved'
    WHEN 'RETIRED' THEN 'approved'
    WHEN 'REJECTED' THEN 'rejected'
    ELSE 'pending'
  END;

  -- Sync is_draft
  NEW.is_draft := (NEW.question_status = 'DRAFT');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_question_status
  BEFORE INSERT OR UPDATE OF question_status ON questions
  FOR EACH ROW
  EXECUTE FUNCTION sync_question_status();

-- State transition validation function
-- Enforces valid state transitions according to the state machine
CREATE OR REPLACE FUNCTION validate_question_state_transition()
RETURNS TRIGGER AS $$
DECLARE
  old_state TEXT;
  new_state TEXT;
  valid_transition BOOLEAN := false;
BEGIN
  -- Allow any state on INSERT
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  old_state := OLD.question_status;
  new_state := NEW.question_status;

  -- No change is always valid
  IF old_state = new_state THEN
    RETURN NEW;
  END IF;

  -- Define valid state transitions
  valid_transition := CASE
    -- From DRAFT
    WHEN old_state = 'DRAFT' AND new_state IN ('SUBMITTED') THEN true

    -- From SUBMITTED
    WHEN old_state = 'SUBMITTED' AND new_state IN ('UNDER_REVIEW', 'DRAFT') THEN true

    -- From UNDER_REVIEW
    WHEN old_state = 'UNDER_REVIEW' AND new_state IN ('CHANGES_REQUESTED', 'APPROVED', 'REJECTED') THEN true

    -- From CHANGES_REQUESTED
    WHEN old_state = 'CHANGES_REQUESTED' AND new_state IN ('RESUBMITTED', 'REJECTED') THEN true

    -- From RESUBMITTED
    WHEN old_state = 'RESUBMITTED' AND new_state IN ('UNDER_REVIEW') THEN true

    -- From APPROVED
    WHEN old_state = 'APPROVED' AND new_state IN ('ACTIVE', 'CHANGES_REQUESTED') THEN true

    -- From ACTIVE
    WHEN old_state = 'ACTIVE' AND new_state IN ('RETIRED', 'CHANGES_REQUESTED') THEN true

    -- From RETIRED (can be reactivated if needed)
    WHEN old_state = 'RETIRED' AND new_state IN ('ACTIVE') THEN true

    -- REJECTED is terminal (cannot transition out)
    WHEN old_state = 'REJECTED' THEN false

    ELSE false
  END;

  IF NOT valid_transition THEN
    RAISE EXCEPTION 'Invalid question state transition: % → %', old_state, new_state;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_question_state_transition
  BEFORE UPDATE OF question_status ON questions
  FOR EACH ROW
  EXECUTE FUNCTION validate_question_state_transition();

-- Index for efficient queries by new status
CREATE INDEX idx_questions_question_status ON questions(question_status);
CREATE INDEX idx_questions_active ON questions(question_status, course_offering_id)
  WHERE question_status = 'ACTIVE';

-- View: Only ACTIVE questions (for paper generation)
CREATE OR REPLACE VIEW active_questions AS
SELECT q.*
FROM questions q
WHERE q.question_status = 'ACTIVE';

COMMENT ON COLUMN questions.question_status IS 'Question lifecycle state: DRAFT → SUBMITTED → UNDER_REVIEW → CHANGES_REQUESTED ↔ RESUBMITTED → APPROVED → ACTIVE → RETIRED (terminal: REJECTED)';
COMMENT ON VIEW active_questions IS 'Only ACTIVE questions - eligible for paper generation';
COMMENT ON COLUMN questions.retirement_reason IS 'Reason for retirement: Syllabus changed, Incorrect, Duplicate, Outdated, Poor quality, Overused, Curriculum removed';
