-- subject_id is kept as a denormalized convenience column (copied from the
-- linked course_offering at write time) purely so subject-wide reporting
-- doesn't need a join through course_offerings for every query. The
-- authoritative link for "which offering/section is this question part of"
-- is course_offering_id / section_id.
CREATE TABLE questions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id          UUID NOT NULL REFERENCES subjects(id),
  course_offering_id  UUID NOT NULL REFERENCES course_offerings(id),
  section_id          UUID REFERENCES sections(id),
  submitted_by        UUID NOT NULL REFERENCES users(id),
  question_type       TEXT NOT NULL DEFAULT 'objective' CHECK (question_type IN ('objective','subjective')),
  question_text       TEXT NOT NULL,
  option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT,
  correct_answer      TEXT,
  model_answer        TEXT,
  difficulty          TEXT CHECK (difficulty IN ('easy','medium','hard')),
  topic               TEXT,
  marks               INTEGER NOT NULL DEFAULT 1,
  question_hash       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ai_cleared','needs_teacher_fix','approved','rejected','flagged')),
  ai_review_notes     TEXT,
  rejection_reason    TEXT,
  is_draft            BOOLEAN NOT NULL DEFAULT TRUE,
  bulk_batch_id       UUID,
  submitted_at        TIMESTAMPTZ,
  last_edited_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE question_attachments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id       UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  uploaded_by       UUID REFERENCES users(id),
  file_path         TEXT NOT NULL,
  file_name         TEXT NOT NULL,
  file_type         TEXT NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  file_hash         TEXT NOT NULL,
  scan_status       TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE previous_year_papers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id          UUID NOT NULL REFERENCES subjects(id),
  course_offering_id  UUID REFERENCES course_offerings(id),
  year                INTEGER,
  question_hash       TEXT NOT NULL
);

CREATE TABLE exam_papers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id          UUID NOT NULL REFERENCES subjects(id),
  course_offering_id  UUID REFERENCES course_offerings(id),
  title               TEXT,
  format_config       TEXT,
  generated_by        UUID REFERENCES users(id),
  -- draft -> hod_approved -> admin_approved -> locked.
  -- HOD and Admin approve independently, each with only their own
  -- credentials (see migration notes in routes/review.js) — neither role
  -- ever authenticates as the other.
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','hod_approved','admin_approved','locked')),
  approved_by_hod     UUID REFERENCES users(id),
  hod_approved_at     TIMESTAMPTZ,
  approved_by_admin   UUID REFERENCES users(id),
  admin_approved_at   TIMESTAMPTZ,
  locked_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE paper_questions (
  paper_id     UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  question_id  UUID NOT NULL REFERENCES questions(id),
  PRIMARY KEY (paper_id, question_id)
);

CREATE TABLE bulk_upload_batches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by         UUID REFERENCES users(id),
  course_offering_id  UUID REFERENCES course_offerings(id),
  file_name           TEXT,
  total_rows          INTEGER,
  valid_rows          INTEGER,
  error_rows          INTEGER,
  status              TEXT NOT NULL DEFAULT 'processing',
  error_report        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliberately NO unique constraint on (course_offering_id, question_hash) —
-- duplicates are allowed in as drafts/submissions and caught by the AI
-- reviewer / mistake-detection endpoint instead of the database silently
-- rejecting a teacher's submission with an opaque error.
CREATE INDEX idx_question_hash_offering ON questions(course_offering_id, question_hash);
CREATE INDEX idx_questions_offering_status ON questions(course_offering_id, status, is_draft);
CREATE INDEX idx_questions_submitted_by ON questions(submitted_by);
CREATE INDEX idx_questions_subject ON questions(subject_id);
CREATE INDEX idx_prev_year_offering_hash ON previous_year_papers(course_offering_id, question_hash);
CREATE INDEX idx_exam_papers_offering ON exam_papers(course_offering_id);
