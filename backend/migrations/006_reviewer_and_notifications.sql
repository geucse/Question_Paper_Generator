-- Reviewer assignment: which reviewer(s) an HOD has put on a given course
-- offering. A reviewer only ever sees questions for offerings they're
-- actively assigned to — same "you only see what you're assigned to"
-- principle as teacher_course_assignments.
CREATE TABLE reviewer_assignments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_offering_id  UUID NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  assigned_by         UUID REFERENCES users(id),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reviewer_id, course_offering_id)
);
CREATE INDEX idx_reviewer_assignments_offering ON reviewer_assignments(course_offering_id, is_active);
CREATE INDEX idx_reviewer_assignments_reviewer ON reviewer_assignments(reviewer_id, is_active);

-- A reviewer's verdict on a question, kept separate from the final
-- HOD/admin decision on `questions.status`. A reviewer flags something for
-- the HOD's attention; they don't have final approve/reject authority
-- themselves (that stays with HOD, matching the existing escalation model —
-- a reviewer's "reject" is a recommendation, not a final rejection).
CREATE TABLE reviewer_verdicts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id   UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  reviewer_id   UUID NOT NULL REFERENCES users(id),
  verdict       TEXT NOT NULL CHECK (verdict IN ('looks_good','needs_hod_attention')),
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, reviewer_id)
);
CREATE INDEX idx_reviewer_verdicts_question ON reviewer_verdicts(question_id);

-- Simple in-app notification feed. Deliberately generic (one row per
-- notification, a type + free-form payload) rather than a table per event
-- type — this is a small app, not a message bus.
CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  message      TEXT NOT NULL,
  entity_id    TEXT,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, read_at);

-- Lightweight lexical embedding for near-duplicate detection, distinct from
-- the exact question_hash match already in place. This is a 256-dimension
-- hashed character-trigram vector (computed in application code, not a deep
-- semantic model) — it catches reworded/reordered near-duplicates that exact
-- hashing misses, without depending on any external embedding API or
-- downloaded model. It is NOT a substitute for true semantic similarity;
-- see backend/src/embeddings.js for the exact method and its limits.
ALTER TABLE questions ADD COLUMN embedding vector(256);

-- ivfflat requires at least a few rows to build meaningful lists; with a
-- small question bank this index is more for correctness/futureproofing
-- than raw performance at this scale.
CREATE INDEX idx_questions_embedding ON questions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
