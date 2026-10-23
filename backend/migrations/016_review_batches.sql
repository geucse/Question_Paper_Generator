-- ---------------------------------------------------------------------
-- Reviewer architecture, rebuilt to match spec sections 5 and 21-25.
--
-- The old model (reviewer_assignments + a single reviewer_verdicts row
-- per question) had no concept of a batch, no way for the HOD to track
-- "these N questions went out for review together", and no way to see
-- TWO reviewers disagree on the same question's Bloom/difficulty/CO — it
-- only supported a single "looks_good / needs_hod_attention" opinion.
--
-- reviewer_assignments and reviewer_verdicts are left in place (nothing is
-- dropped — no destruction of existing data/functionality) but are no
-- longer written to by new code; reviewer_assignments now additionally
-- backs review_batch_reviewers below (a reviewer must still hold an active
-- reviewer_assignment for the course offering before they can be put on a
-- batch for it).
-- ---------------------------------------------------------------------

CREATE TABLE review_batches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_offering_id  UUID NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  created_by_hod_id   UUID REFERENCES users(id),
  title               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN
    ('created','assigned','in_progress','review_complete','closed','cancelled')),
  due_at              TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX idx_review_batches_offering ON review_batches(course_offering_id, status);

-- Which submissions were put in front of reviewers as part of this batch.
CREATE TABLE review_batch_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_batch_id  UUID NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  question_id      UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_batch_id, question_id)
);
CREATE INDEX idx_review_batch_items_batch ON review_batch_items(review_batch_id);
CREATE INDEX idx_review_batch_items_question ON review_batch_items(question_id);

-- Which reviewer(s) were put on this batch. Kept distinct from a bare
-- reviewer_id column so a late/declined reviewer can be reassigned WITHOUT
-- deleting the historical row (spec section 24) — reassignment inserts a
-- new row and marks the old one 'revoked', it never deletes it.
CREATE TABLE review_batch_reviewers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_batch_id         UUID NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  reviewer_assignment_id  UUID NOT NULL REFERENCES reviewer_assignments(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN
    ('assigned','accepted','declined','in_progress','completed','revoked')),
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  reviewer_summary        TEXT,
  recommendation          TEXT,
  recommendation_score    NUMERIC(5,2),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_batch_id, reviewer_assignment_id)
);
CREATE INDEX idx_batch_reviewers_batch ON review_batch_reviewers(review_batch_id);
CREATE INDEX idx_batch_reviewers_assignment ON review_batch_reviewers(reviewer_assignment_id);

-- One reviewer's verdict on one question, within one batch. Multiple
-- reviewers on the same batch each get their OWN row here — disagreement
-- is simply "more than one distinct value across these rows for the same
-- question", never averaged into a single number. verified_* here are
-- this ONE reviewer's opinion; the authoritative, explicitly-recorded
-- final value lives in review_resolutions (or, if all reviewers agree,
-- is copied straight onto canonical_questions — see review-batches.js).
CREATE TABLE question_reviews (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_batch_id             UUID NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  question_id                 UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  reviewer_id                 UUID NOT NULL REFERENCES users(id),
  decision                    TEXT NOT NULL CHECK (decision IN ('accept','reject','request_revision')),
  verified_difficulty         TEXT CHECK (verified_difficulty IN ('easy','medium','hard')),
  verified_bloom_level        TEXT CHECK (verified_bloom_level IN ('remember','understand','apply','analyze','evaluate','create')),
  verified_course_outcome_id  UUID REFERENCES course_outcomes(id),
  flagged_ambiguous           BOOLEAN NOT NULL DEFAULT FALSE,
  flagged_duplicate           BOOLEAN NOT NULL DEFAULT FALSE,
  answer_approved             BOOLEAN NOT NULL DEFAULT FALSE,
  comment                     TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_batch_id, question_id, reviewer_id)
);
CREATE INDEX idx_question_reviews_question ON question_reviews(question_id);
CREATE INDEX idx_question_reviews_batch ON question_reviews(review_batch_id);

-- The explicit, authoritative final academic classification for a question
-- once independent reviewers disagreed. Written ONLY by an authorized
-- decision (HOD override, a designated additional reviewer's tie-break, or
-- a completed re-review) — never auto-computed as an average. Also used to
-- record the resolution when only one reviewer reviewed (single_reviewer_consensus).
CREATE TABLE review_resolutions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id              UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  final_difficulty         TEXT CHECK (final_difficulty IN ('easy','medium','hard')),
  final_bloom_level        TEXT CHECK (final_bloom_level IN ('remember','understand','apply','analyze','evaluate','create')),
  final_course_outcome_id  UUID REFERENCES course_outcomes(id),
  resolution_method        TEXT NOT NULL CHECK (resolution_method IN
    ('single_reviewer_consensus','hod_override','additional_reviewer','re_review')),
  decided_by               UUID REFERENCES users(id),
  reason                   TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_resolutions_question ON review_resolutions(question_id);

-- Conflict of interest (spec section 25): a reviewer must never be the one
-- recording a verdict on their own submission. Enforced here as a hard DB
-- constraint (belt-and-braces alongside the route-level check), by
-- rejecting any question_reviews row where the reviewer is also the
-- question's submitter.
CREATE OR REPLACE FUNCTION reject_self_review() RETURNS TRIGGER AS $$
DECLARE
  submitter UUID;
BEGIN
  SELECT submitted_by INTO submitter FROM questions WHERE id = NEW.question_id;
  IF submitter = NEW.reviewer_id THEN
    RAISE EXCEPTION 'A reviewer cannot record a verdict on their own submitted question (conflict of interest)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_self_review
  BEFORE INSERT OR UPDATE ON question_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_self_review();
