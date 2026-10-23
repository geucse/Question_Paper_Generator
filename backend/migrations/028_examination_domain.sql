-- Examination domain tables - docs/development/PIVOT_SPEC_V2.md sections 19-31
-- COE → 4 Validators workflow for paper validation and approval
-- Strict separation: Examination reads ACTIVE questions only, never writes to Question Bank

-- Examinations: COE creates examination with academic context
CREATE TABLE examinations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campus_id           UUID NOT NULL REFERENCES campuses(id),
  college_id          UUID NOT NULL REFERENCES colleges(id),
  program_id          UUID NOT NULL REFERENCES programs(id),
  academic_session_id UUID NOT NULL REFERENCES academic_sessions(id),
  semester            INTEGER NOT NULL CHECK (semester BETWEEN 1 AND 12),
  course_offering_id  UUID NOT NULL REFERENCES course_offerings(id),
  subject_id          UUID NOT NULL REFERENCES subjects(id),
  syllabus_version_id UUID NOT NULL REFERENCES syllabus_versions(id),

  exam_type           TEXT NOT NULL CHECK (exam_type IN ('mid_term', 'end_term', 'quiz', 'supplementary', 'makeup')),
  maximum_marks       INTEGER NOT NULL CHECK (maximum_marks > 0),
  duration_minutes    INTEGER NOT NULL CHECK (duration_minutes > 0),
  exam_date           DATE,

  created_by          UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (course_offering_id, exam_type, academic_session_id, semester)
);

-- Paper status state machine - docs/development/PIVOT_SPEC_V2.md section 26
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS paper_status TEXT;

-- Migrate existing status to new paper_status
UPDATE exam_papers
SET paper_status = CASE
  WHEN status = 'draft' THEN 'DRAFT'
  WHEN status = 'hod_approved' THEN 'GENERATED'
  WHEN status = 'admin_approved' THEN 'COE_APPROVED'
  WHEN status = 'locked' THEN 'PRINT_READY'
  ELSE 'DRAFT'
END
WHERE paper_status IS NULL;

ALTER TABLE exam_papers ALTER COLUMN paper_status SET DEFAULT 'DRAFT';
ALTER TABLE exam_papers ALTER COLUMN paper_status SET NOT NULL;
ALTER TABLE exam_papers ADD CONSTRAINT exam_papers_paper_status_check
  CHECK (paper_status IN (
    'DRAFT',
    'GENERATING',
    'GENERATED',
    'VALIDATION_PENDING',
    'CHANGES_REQUIRED',
    'REGENERATED',
    'VALIDATED',
    'COE_APPROVED',
    'PRINT_READY',
    'ARCHIVED'
  ));

-- Link papers to examinations
ALTER TABLE exam_papers ADD COLUMN examination_id UUID REFERENCES examinations(id);
ALTER TABLE exam_papers ADD COLUMN generation_seed TEXT;
ALTER TABLE exam_papers ADD COLUMN generator_version TEXT;
ALTER TABLE exam_papers ADD COLUMN blueprint_version_id UUID;
ALTER TABLE exam_papers ADD COLUMN generated_at TIMESTAMPTZ;
ALTER TABLE exam_papers ADD COLUMN eligible_question_set_hash TEXT;

-- Paper validator assignments - exactly 4 validators per paper
CREATE TABLE paper_validator_assignments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id          UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  validator_id      UUID NOT NULL REFERENCES users(id),
  validator_number  INTEGER NOT NULL CHECK (validator_number BETWEEN 1 AND 4),

  decision          TEXT CHECK (decision IN ('APPROVE', 'CHANGES_REQUIRED')),
  comments          TEXT,
  checklist_results JSONB,
  decided_at        TIMESTAMPTZ,

  assigned_by       UUID NOT NULL REFERENCES users(id),
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,

  UNIQUE (paper_id, validator_number),
  UNIQUE (paper_id, validator_id)
);

-- Paper validation reviews - detailed validator feedback
CREATE TABLE paper_validation_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id          UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  validator_id      UUID NOT NULL REFERENCES users(id),

  -- Validation checklist
  question_correctness    BOOLEAN,
  syllabus_relevance      BOOLEAN,
  co_mapping_correct      BOOLEAN,
  bloom_levels_correct    BOOLEAN,
  difficulty_appropriate  BOOLEAN,
  marks_distribution_ok   BOOLEAN,
  formatting_ok           BOOLEAN,
  numbering_correct       BOOLEAN,
  spelling_grammar_ok     BOOLEAN,
  instructions_clear      BOOLEAN,
  layout_acceptable       BOOLEAN,

  overall_decision  TEXT NOT NULL CHECK (overall_decision IN ('APPROVE', 'CHANGES_REQUIRED')),
  comments          TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (paper_id, validator_id)
);

-- Paper issues - problems identified by validators
CREATE TABLE paper_issues (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id          UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  question_id       UUID REFERENCES questions(id),

  issue_type        TEXT NOT NULL CHECK (issue_type IN (
    'spelling', 'grammar', 'incorrect', 'unclear', 'formatting',
    'wrong_co', 'wrong_bloom', 'wrong_difficulty', 'duplicate',
    'missing_answer', 'wrong_marks', 'syllabus_mismatch', 'other'
  )),
  description       TEXT NOT NULL,
  reported_by       UUID NOT NULL REFERENCES users(id),

  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'wont_fix')),
  resolution        TEXT,
  resolved_by       UUID REFERENCES users(id),
  resolved_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Paper revisions - track changes to papers
CREATE TABLE paper_revisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id          UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  revision_number   INTEGER NOT NULL,

  change_type       TEXT NOT NULL CHECK (change_type IN (
    'question_replaced', 'question_regenerated', 'metadata_updated',
    'blueprint_changed', 'manual_edit', 'issue_resolution'
  )),
  change_description TEXT NOT NULL,
  changed_by        UUID NOT NULL REFERENCES users(id),

  previous_snapshot JSONB,
  new_snapshot      JSONB,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (paper_id, revision_number)
);

-- COE approval tracking
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS coe_approved_by UUID REFERENCES users(id);
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS coe_approved_at TIMESTAMPTZ;
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS coe_approval_totp_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS locked_by UUID REFERENCES users(id);

-- Indexes
CREATE INDEX idx_examinations_campus ON examinations(campus_id);
CREATE INDEX idx_examinations_offering ON examinations(course_offering_id);
CREATE INDEX idx_examinations_session ON examinations(academic_session_id, semester);
CREATE INDEX idx_exam_papers_status ON exam_papers(paper_status);
CREATE INDEX idx_exam_papers_examination ON exam_papers(examination_id);
CREATE INDEX idx_validator_assignments_paper ON paper_validator_assignments(paper_id);
CREATE INDEX idx_validator_assignments_validator ON paper_validator_assignments(validator_id, is_active);
CREATE INDEX idx_paper_issues_paper ON paper_issues(paper_id, status);
CREATE INDEX idx_paper_revisions_paper ON paper_revisions(paper_id, revision_number DESC);

-- Constraint: Exactly 4 active validator assignments per paper
CREATE OR REPLACE FUNCTION check_validator_count()
RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
BEGIN
  IF NEW.is_active THEN
    SELECT COUNT(*) INTO active_count
    FROM paper_validator_assignments
    WHERE paper_id = NEW.paper_id AND is_active = true;

    IF active_count > 4 THEN
      RAISE EXCEPTION 'Paper cannot have more than 4 active validators';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_validator_count
  AFTER INSERT OR UPDATE ON paper_validator_assignments
  FOR EACH ROW
  EXECUTE FUNCTION check_validator_count();

COMMENT ON TABLE examinations IS 'COE-created examinations with full academic context. COE owns paper generation for these.';
COMMENT ON TABLE paper_validator_assignments IS 'Exactly 4 distinct validators per paper. All 4 must approve before COE approval.';
COMMENT ON TABLE paper_issues IS 'Problems identified by validators. COE decides whether to replace/regenerate.';
COMMENT ON TABLE paper_revisions IS 'Version history for papers. Any change after GENERATED creates a new revision.';
COMMENT ON COLUMN exam_papers.paper_status IS 'DRAFT → GENERATING → GENERATED → VALIDATION_PENDING → VALIDATED → COE_APPROVED → PRINT_READY';
COMMENT ON COLUMN exam_papers.generation_seed IS 'Seed for reproducible paper generation';
