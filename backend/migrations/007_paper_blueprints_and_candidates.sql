-- Reusable paper format templates ("mid-sem: 20 easy / 20 medium / 10
-- hard"), so HOD/admin don't retype the same distribution every exam cycle.
-- department_id NULL means a global/admin-authored template usable by any
-- department; otherwise it's scoped to the HOD's own department.
CREATE TABLE paper_blueprints (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  description    TEXT,
  department_id  UUID REFERENCES departments(id),
  easy_count     INTEGER NOT NULL DEFAULT 0,
  medium_count   INTEGER NOT NULL DEFAULT 0,
  hard_count     INTEGER NOT NULL DEFAULT 0,
  created_by     UUID REFERENCES users(id),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Groups a batch of candidate papers generated together from the same
-- offering + format, so a HOD/admin can compare several independently-drawn
-- selections before promoting exactly one into the real approval pipeline.
CREATE TABLE paper_generation_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_offering_id  UUID NOT NULL REFERENCES course_offerings(id),
  blueprint_id        UUID REFERENCES paper_blueprints(id),
  easy_count          INTEGER NOT NULL DEFAULT 0,
  medium_count        INTEGER NOT NULL DEFAULT 0,
  hard_count          INTEGER NOT NULL DEFAULT 0,
  candidate_count     INTEGER NOT NULL DEFAULT 1,
  requested_by        UUID REFERENCES users(id),
  selected_paper_id   UUID,  -- set once one candidate is promoted; FK added below after exam_papers exists in this migration context
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extend exam_papers with candidate-generation bookkeeping and widen the
-- status enum to cover the candidate/discarded states. Postgres requires
-- dropping and recreating a CHECK constraint to widen it.
ALTER TABLE exam_papers ADD COLUMN generation_request_id UUID REFERENCES paper_generation_requests(id);
ALTER TABLE exam_papers ADD COLUMN candidate_label TEXT; -- e.g. "Candidate 1" for display

ALTER TABLE exam_papers DROP CONSTRAINT exam_papers_status_check;
ALTER TABLE exam_papers ADD CONSTRAINT exam_papers_status_check
  CHECK (status IN ('candidate','discarded','draft','hod_approved','admin_approved','locked'));

ALTER TABLE paper_generation_requests
  ADD CONSTRAINT fk_generation_request_selected_paper
  FOREIGN KEY (selected_paper_id) REFERENCES exam_papers(id);

CREATE INDEX idx_exam_papers_generation_request ON exam_papers(generation_request_id);
CREATE INDEX idx_paper_blueprints_department ON paper_blueprints(department_id, is_active);
