-- 039: paper workflow integrity (phase 2 of the post-pivot gap audit: validator workflow and issues).
-- Closes these gaps (PIVOT_SPEC_V2 §26-§30, §35, §36, §39 inv. 6/7/9):
--   1. One decision per validator was enforced only in route code; a recorded decision could be rewritten.
--   2. Validator assignments had no history: the admin reset DELETEd them, and paper_validation_reviews kept
--      UNIQUE (paper_id, validator_id), so a validator re-assigned after a reset could never decide again.
--      Assignments now end (is_active = FALSE + reason) instead of being deleted, each full set of four is
--      a numbered validation round, and every review row belongs to one assignment.
--   3. A single validator could not be replaced; the UNIQUE (paper_id, validator_number) forbade it.
--      Uniqueness now holds among ACTIVE rows only.
--   4. A superseded (REGENERATED / ARCHIVED) revision kept its validators active. A trigger ends them on
--      every path that supersedes a paper.
--   5. The reviewer set of the independence policy missed most reviewer actions. paper_question_reviewers()
--      and paper_question_authors() are the one definition, shared by the API (src/validator-eligibility.js)
--      and the smoke tests.
--   6. Issues could be reported in any status, closed more than once and edited. They are now reported only
--      while a paper is VALIDATION_PENDING or VALIDATED, closed exactly once (resolved | wont_fix, or
--      carried_forward by regeneration), and never edited or deleted.
--   7. An open issue on a VALIDATED paper was a dead end. The COE can now send a paper back
--      (VALIDATED -> CHANGES_REQUIRED) with a recorded reason; COE approval with an open issue is refused
--      by the database as well as the route.
--   8. A regeneration that resolves or carries issues writes an 'issue_resolution' revision row next to its
--      'question_regenerated' row, so UNIQUE (paper_id, revision_number) becomes per change_type.
-- Generation, targets and sections (sections 11-16):
--   9. paper_version was computed outside any lock (two papers could share a version): UNIQUE per examination.
--  10. Two live papers of one examination could exist; the second silently took over the first's reservations.
--      At most one live paper per examination (deferred constraint trigger, same advisory key as the generator).
--  11. Blueprint versions could collide under concurrent saves and more than one version could be active.
--  12. A used blueprint's sections, hard_targets and name could change in place, and it could be deleted
--      (exam_papers.blueprint_version_id has no foreign key). Only is_active may change on a used blueprint.
--  13. What the generator decided (format_config with the section rules printed on the paper, candidate_metrics
--      with the resolved targets, constraint_overrides, bloom_realized) could change after generation.
--  14. Constraint overrides are recorded in paper_constraint_overrides by the generation itself, approved by
--      the generating COE (PIVOT_SPEC_V2 §29), and never changed afterwards.
-- Review fixes (same migration, still unapplied outside throwaway databases):
--  15. A recorded decision is never discarded by a replacement or reassignment (only by supersession or the
--      technical reset), and the technical reset never overturns a CHANGES_REQUIRED verdict (§36): it is refused
--      from CHANGES_REQUIRED and from a VALIDATION_PENDING round that holds a CHANGES_REQUIRED decision.
--  16. An issue is reported only by an active validator whose validator scope still covers the examination.
--  17. A printed paper is revised as a new revision (§28): at most one paper in progress AND at most one
--      PRINT_READY paper per examination; the printed paper is archived when its revision is printed.
--  Existing rows are never renumbered or deleted: duplicates left by the old races are listed with NOTICE and
--  exempted by id from the new unique indexes.
-- Forward-only and idempotent; no data is dropped and no earlier migration is changed. Order matters:
-- columns, backfill (with this migration's guards dropped), constraints/indexes, functions, triggers.
-- The transition table in enforce_paper_lifecycle must match src/paper-policy.js (test-paper-policy.mjs
-- reads the newest migration that defines the function).

-- Re-running this file must not be blocked by its own guards during the backfill.
DROP TRIGGER IF EXISTS trg_guard_validator_assignment ON paper_validator_assignments;
DROP TRIGGER IF EXISTS trg_protect_validation_reviews ON paper_validation_reviews;
DROP TRIGGER IF EXISTS trg_enforce_paper_issue_rules ON paper_issues;

-- ---------------------------------------------------------------------------
-- 1. Validator assignment rounds and history
-- ---------------------------------------------------------------------------
ALTER TABLE paper_validator_assignments ADD COLUMN IF NOT EXISTS validation_round SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE paper_validator_assignments ADD COLUMN IF NOT EXISTS replaces_assignment_id UUID REFERENCES paper_validator_assignments(id);
ALTER TABLE paper_validator_assignments ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE paper_validator_assignments ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES users(id);
ALTER TABLE paper_validator_assignments ADD COLUMN IF NOT EXISTS deactivation_reason TEXT;
ALTER TABLE paper_validator_assignments ADD COLUMN IF NOT EXISTS deactivation_note TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pva_round_positive') THEN
    ALTER TABLE paper_validator_assignments ADD CONSTRAINT pva_round_positive CHECK (validation_round >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pva_deactivation_reason_check') THEN
    ALTER TABLE paper_validator_assignments ADD CONSTRAINT pva_deactivation_reason_check CHECK (deactivation_reason IS NULL
      OR deactivation_reason IN ('reassigned', 'replaced', 'paper_reset', 'paper_regenerated', 'paper_archived'));
  END IF;
  -- Legacy inactive rows (if any) are not re-checked; every row written from now on must satisfy it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pva_active_xor_ended') THEN
    ALTER TABLE paper_validator_assignments ADD CONSTRAINT pva_active_xor_ended CHECK (is_active = (deactivation_reason IS NULL)) NOT VALID;
  END IF;
END $$;
ALTER TABLE paper_validation_reviews ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES paper_validator_assignments(id);

-- Backfill. Before 039, (paper_id, validator_id) was unique in both tables, so a decided assignment whose
-- decision matches the review is its assignment. A review left over from a round the old reset DELETEd is
-- never pinned on a newer, undecided assignment.
UPDATE paper_validation_reviews r SET assignment_id = a.id
  FROM paper_validator_assignments a
 WHERE r.assignment_id IS NULL AND a.paper_id = r.paper_id AND a.validator_id = r.validator_id
   AND a.decision IS NOT NULL AND a.decision = r.overall_decision AND r.created_at >= a.assigned_at;
-- Superseded papers kept active validators (nothing ever set is_active = FALSE before 039).
UPDATE paper_validator_assignments a
   SET is_active = FALSE, deactivated_at = now(),
       deactivation_reason = CASE ep.paper_status WHEN 'REGENERATED' THEN 'paper_regenerated' ELSE 'paper_archived' END,
       deactivation_note = 'Ended by migration 039 (paper was already superseded)'
  FROM exam_papers ep
 WHERE ep.id = a.paper_id AND a.is_active
   AND (ep.paper_status = 'REGENERATED' OR (ep.paper_status = 'ARCHIVED' AND ep.locked_at IS NULL));

-- Uniqueness among ACTIVE rows only (028 had table-wide UNIQUEs).
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT con.conrelid::regclass AS tbl, con.conname FROM pg_constraint con
            WHERE con.contype = 'u'
              AND ((con.conrelid = 'paper_validator_assignments'::regclass
                    AND pg_get_constraintdef(con.oid) IN ('UNIQUE (paper_id, validator_number)', 'UNIQUE (paper_id, validator_id)'))
                OR (con.conrelid = 'paper_validation_reviews'::regclass AND pg_get_constraintdef(con.oid) = 'UNIQUE (paper_id, validator_id)'))
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname); END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pva_active_slot ON paper_validator_assignments(paper_id, validator_number) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pva_active_validator ON paper_validator_assignments(paper_id, validator_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_pva_validator_active ON paper_validator_assignments(validator_id) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pvr_assignment ON paper_validation_reviews(assignment_id) WHERE assignment_id IS NOT NULL;
DO $$ BEGIN
  -- New review rows only; legacy orphans (reviews of a deleted round) stay as they are.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pvr_assignment_required') THEN
    ALTER TABLE paper_validation_reviews ADD CONSTRAINT pvr_assignment_required CHECK (assignment_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN paper_validator_assignments.validation_round IS 'Full sets of four are numbered 1, 2, ...; a single replacement keeps the round. Mirrors src/routes/examinations.js.';
COMMENT ON COLUMN paper_validator_assignments.replaces_assignment_id IS 'The ended assignment this one replaced (single-validator replacement by the COE).';
COMMENT ON COLUMN paper_validator_assignments.deactivation_reason IS 'Why the assignment ended: reassigned | replaced | paper_reset | paper_regenerated | paper_archived (src/paper-policy.js ASSIGNMENT_END_REASONS). Ended rows are history.';
COMMENT ON COLUMN paper_validation_reviews.assignment_id IS 'The assignment (round) this decision belongs to; unique, so a validator decides once per assignment.';

-- ---------------------------------------------------------------------------
-- 2. Conflict sets of a paper (spec §27), shared by src/validator-eligibility.js and the smoke tests.
--    Both cover the paper's questions plus every questions row sharing their canonical question
--    (older revisions and merged duplicates).
-- ---------------------------------------------------------------------------
-- Authors are submitted_by only: question_versions.created_by is also written by the HOD/reviewer who
-- merges duplicates (duplicate-detection.js), and they are not authors.
CREATE OR REPLACE FUNCTION paper_question_authors(p_paper_id UUID) RETURNS TABLE(author_id UUID) AS $$
  SELECT DISTINCT q2.submitted_by
    FROM paper_questions pq
    JOIN questions q ON q.id = pq.question_id
    JOIN questions q2 ON q2.id = q.id OR (q.canonical_question_id IS NOT NULL AND q2.canonical_question_id = q.canonical_question_id)
   WHERE pq.paper_id = p_paper_id AND q2.submitted_by IS NOT NULL;
$$ LANGUAGE sql STABLE;

-- Everyone who took a review decision on those questions. Sending a question to review (HOD,
-- question_transition_under_review), withdrawals and SUPERSEDED rounds are not review decisions.
-- Accounts are compared by user id: one person with two accounts cannot be linked (users.employee_id is
-- unique per account), so the rule catches a reviewer account that was later re-roled to validator.
CREATE OR REPLACE FUNCTION paper_question_reviewers(p_paper_id UUID) RETURNS TABLE(reviewer_id UUID, source TEXT) AS $$
  WITH pq AS (
    SELECT DISTINCT q2.id, q2.canonical_question_id
      FROM paper_questions p
      JOIN questions q ON q.id = p.question_id
      JOIN questions q2 ON q2.id = q.id OR (q.canonical_question_id IS NOT NULL AND q2.canonical_question_id = q.canonical_question_id)
     WHERE p.paper_id = p_paper_id)
  SELECT DISTINCT x.rid, x.src FROM (
              SELECT q.approved_by, 'approved the question' FROM pq JOIN questions q ON q.id = pq.id
    UNION ALL SELECT q.change_requested_by, 'requested changes' FROM pq JOIN questions q ON q.id = pq.id
    UNION ALL SELECT q.retired_by, 'retired the question' FROM pq JOIN questions q ON q.id = pq.id
    UNION ALL SELECT qr.reviewer_id, 'review batch verdict' FROM pq JOIN question_reviews qr ON qr.question_id = pq.id
    UNION ALL SELECT rv.reviewer_id, 'reviewer verdict' FROM pq JOIN reviewer_verdicts rv ON rv.question_id = pq.id
    UNION ALL SELECT rbi.decided_by, 'review round decision' FROM pq
                JOIN review_batch_items rbi ON rbi.question_id = pq.id AND rbi.outcome IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED')
    UNION ALL SELECT rr.decided_by, 'classification resolution' FROM pq JOIN review_resolutions rr ON rr.question_id = pq.id
    UNION ALL SELECT ca.approved_by, 'approved the answer'
                FROM (SELECT DISTINCT canonical_question_id FROM pq WHERE canonical_question_id IS NOT NULL) c
                JOIN canonical_answers ca ON ca.canonical_question_id = c.canonical_question_id
    UNION ALL SELECT a.user_id, 'lifecycle decision' FROM pq
                JOIN audit_log a ON a.entity_id = pq.id::text
                 AND a.action IN ('question_transition_approved', 'question_transition_changes_requested', 'question_transition_rejected',
                                  'question_transition_active', 'question_transition_retired', 'question_transition_restore',
                                  'question_reviewed', 'review_resolution_recorded', 'question_approved', 'question_rejected')
  ) x(rid, src)
  WHERE x.rid IS NOT NULL;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION paper_question_authors(UUID) IS 'Authors of a paper''s questions (and their canonical siblings). Used by src/validator-eligibility.js (validator ≠ author, spec §27).';
COMMENT ON FUNCTION paper_question_reviewers(UUID) IS 'Reviewer decisions on a paper''s questions, with their source. Used by src/validator-eligibility.js for the optional independence policy (spec §27).';

-- ---------------------------------------------------------------------------
-- 3. Guard on paper_validator_assignments (one decision per assignment; history never changes)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_validator_assignment()
RETURNS TRIGGER AS $$
DECLARE
  v_override BOOLEAN := COALESCE(current_setting('app.paper_override', true), '') = 'on';
  v_status   TEXT;
  v_identity TEXT[] := ARRAY['id', 'paper_id', 'validator_id', 'validator_number', 'assigned_by', 'assigned_at', 'validation_round', 'replaces_assignment_id'];
  v_decision TEXT[] := ARRAY['decision', 'comments', 'checklist_results', 'decided_at'];
  v_end      TEXT[] := ARRAY['is_active', 'deactivated_at', 'deactivated_by', 'deactivation_reason', 'deactivation_note'];
BEGIN
  SELECT paper_status INTO v_status FROM exam_papers WHERE id = COALESCE(NEW.paper_id, OLD.paper_id);

  IF TG_OP = 'DELETE' THEN
    IF v_status IS NULL THEN RETURN OLD; END IF;  -- cascade from a deleted DRAFT/GENERATING paper
    RAISE EXCEPTION 'Validator assignments are history and cannot be deleted (paper %); end them instead', OLD.paper_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'GENERATED' AND v_status IS DISTINCT FROM 'VALIDATION_PENDING' THEN
      RAISE EXCEPTION 'Validators can only be assigned to a GENERATED or VALIDATION_PENDING paper (current: %)', v_status;
    END IF;
    IF NOT NEW.is_active OR NEW.decision IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.deactivation_reason IS NOT NULL THEN
      RAISE EXCEPTION 'A new validator assignment starts active and undecided';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.validator_id AND role = 'validator' AND status = 'ACTIVE' AND is_active) THEN
      RAISE EXCEPTION 'User % is not an active validator', NEW.validator_id;
    END IF;
    RETURN NEW;
  END IF;

  IF (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(v_identity) k)
     IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(v_identity) k) THEN
    RAISE EXCEPTION 'The identity of validator assignment % cannot change', OLD.id;
  END IF;

  -- Ended rows are frozen and never reactivated.
  IF NOT OLD.is_active THEN
    IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
      RAISE EXCEPTION 'Ended validator assignment % is history and cannot change', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT NEW.is_active THEN  -- ending it
    IF (to_jsonb(OLD) - v_end) IS DISTINCT FROM (to_jsonb(NEW) - v_end) THEN
      RAISE EXCEPTION 'Ending a validator assignment may only set its deactivation fields';
    END IF;
    IF NEW.deactivation_reason IS NULL THEN
      RAISE EXCEPTION 'Ending a validator assignment needs a deactivation_reason';
    END IF;
    IF v_status = 'PRINT_READY' THEN
      RAISE EXCEPTION 'Validators of a PRINT_READY paper are its approval record and cannot be removed';
    END IF;
    IF v_status IN ('VALIDATED', 'COE_APPROVED') AND NOT v_override THEN
      RAISE EXCEPTION 'Validators of a % paper can only be removed by the technical reset', v_status;
    END IF;
    -- A recorded decision is never discarded by a replacement or a new round (src/routes/examinations.js
    -- refuses it under the row lock; this is the backstop). Only supersession or the technical reset ends it.
    IF OLD.decision IS NOT NULL AND NEW.deactivation_reason NOT IN ('paper_reset', 'paper_regenerated', 'paper_archived') THEN
      RAISE EXCEPTION 'Validator % already recorded a decision on paper %; a recorded decision cannot be replaced', OLD.validator_id, OLD.paper_id;
    END IF;
    -- The technical reset (§36) recovers a stuck paper; it never overturns a CHANGES_REQUIRED verdict.
    IF NEW.deactivation_reason = 'paper_reset'
       AND (v_status = 'CHANGES_REQUIRED' OR (v_status = 'VALIDATION_PENDING' AND OLD.decision = 'CHANGES_REQUIRED')) THEN
      RAISE EXCEPTION 'The technical reset cannot discard a CHANGES_REQUIRED decision (paper %); regenerate or archive the paper', OLD.paper_id;
    END IF;
    NEW.deactivated_at := COALESCE(NEW.deactivated_at, now());
    RETURN NEW;
  END IF;

  IF NEW.deactivated_at IS NOT NULL OR NEW.deactivated_by IS NOT NULL OR NEW.deactivation_reason IS NOT NULL OR NEW.deactivation_note IS NOT NULL THEN
    RAISE EXCEPTION 'Deactivation fields are set only when an assignment ends';
  END IF;

  -- A recorded decision never changes. app.paper_override is kept for a §36 manual repair; no route uses it here.
  IF OLD.decision IS NOT NULL THEN
    IF (to_jsonb(OLD) - v_end) IS DISTINCT FROM (to_jsonb(NEW) - v_end) AND NOT v_override THEN
      RAISE EXCEPTION 'Validator % already recorded a decision on paper %; a recorded decision cannot be changed', OLD.validator_id, OLD.paper_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.decision IS NOT NULL THEN
    IF v_status IS DISTINCT FROM 'VALIDATION_PENDING' THEN
      RAISE EXCEPTION 'A validator decision can only be recorded while the paper is VALIDATION_PENDING (current: %)', v_status;
    END IF;
    IF NEW.decision = 'CHANGES_REQUIRED' AND COALESCE(btrim(NEW.comments), '') = '' THEN
      RAISE EXCEPTION 'CHANGES_REQUIRED needs comments';
    END IF;
    NEW.decided_at := COALESCE(NEW.decided_at, now());
  ELSIF (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(v_decision) k)
        IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(v_decision) k) THEN
    RAISE EXCEPTION 'Comments and checklist are recorded together with the decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_validator_assignment
  BEFORE INSERT OR UPDATE OR DELETE ON paper_validator_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_validator_assignment();
COMMENT ON TRIGGER trg_guard_validator_assignment ON paper_validator_assignments IS
  'One decision per assignment, only while VALIDATION_PENDING; assignments end (never deleted or reactivated). Mirrors src/routes/examinations.js and src/validator-eligibility.js.';

-- ---------------------------------------------------------------------------
-- 4. paper_validation_reviews is append-only; each row belongs to the decided assignment it records.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION protect_validation_reviews()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM paper_validator_assignments a
                    WHERE a.id = NEW.assignment_id AND a.paper_id = NEW.paper_id AND a.validator_id = NEW.validator_id
                      AND a.is_active AND a.decision = NEW.overall_decision) THEN
      RAISE EXCEPTION 'A validator review must record the decision of an active assignment of that validator on that paper';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM exam_papers WHERE id = OLD.paper_id) THEN
    RETURN OLD;  -- cascade from a deleted DRAFT/GENERATING paper
  END IF;
  RAISE EXCEPTION 'Validator reviews are history and cannot be %d (paper %)', lower(TG_OP), OLD.paper_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_validation_reviews
  BEFORE INSERT OR UPDATE OR DELETE ON paper_validation_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_validation_reviews();

-- ---------------------------------------------------------------------------
-- 5. Supersession ends a paper's active validators on every path (regenerate, archive, reset backstop).
--    PRINT_READY -> ARCHIVED keeps them: they are the approval record that made PRINT_READY legal.
--    No column list on purpose (a column-list trigger misses values set by other triggers, see 038).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION end_validator_assignments()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.paper_status = 'REGENERATED' OR (NEW.paper_status = 'ARCHIVED' AND OLD.paper_status <> 'PRINT_READY') THEN
    UPDATE paper_validator_assignments SET is_active = FALSE, deactivation_reason = 'paper_' || lower(NEW.paper_status)
     WHERE paper_id = NEW.id AND is_active;
  ELSIF NEW.paper_status = 'GENERATED' AND OLD.paper_status IN ('VALIDATION_PENDING', 'VALIDATED', 'COE_APPROVED') THEN
    -- Backstop for the admin reset, which ends them itself (with its reason) before changing the status.
    UPDATE paper_validator_assignments SET is_active = FALSE, deactivation_reason = 'paper_reset'
     WHERE paper_id = NEW.id AND is_active;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_end_validator_assignments ON exam_papers;
CREATE TRIGGER trg_end_validator_assignments
  AFTER UPDATE ON exam_papers
  FOR EACH ROW WHEN (OLD.paper_status IS DISTINCT FROM NEW.paper_status)
  EXECUTE FUNCTION end_validator_assignments();
COMMENT ON TRIGGER trg_end_validator_assignments ON exam_papers IS
  'Ends active validator assignments when a paper is superseded (REGENERATED, ARCHIVED before printing) or reset. Mirrors src/paper-policy.js ASSIGNMENT_END_REASONS.';

-- ---------------------------------------------------------------------------
-- 6. Paper issues: status set, provenance across regenerations
-- ---------------------------------------------------------------------------
ALTER TABLE paper_issues DROP CONSTRAINT IF EXISTS paper_issues_status_check;
ALTER TABLE paper_issues ADD CONSTRAINT paper_issues_status_check CHECK (status IN ('open', 'resolved', 'wont_fix', 'carried_forward'));
ALTER TABLE paper_issues ADD COLUMN IF NOT EXISTS carried_from_issue_id UUID REFERENCES paper_issues(id);
ALTER TABLE paper_issues ADD COLUMN IF NOT EXISTS carried_to_issue_id UUID REFERENCES paper_issues(id);
ALTER TABLE paper_issues ADD COLUMN IF NOT EXISTS origin_issue_id UUID REFERENCES paper_issues(id);  -- root of a carry chain; NULL = this row is the origin
CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_issues_carried_from ON paper_issues(carried_from_issue_id) WHERE carried_from_issue_id IS NOT NULL;
ALTER TABLE paper_issues DROP CONSTRAINT IF EXISTS paper_issues_closed_complete;
ALTER TABLE paper_issues ADD CONSTRAINT paper_issues_closed_complete
  CHECK (status = 'open' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)) NOT VALID;  -- legacy rows not re-checked
COMMENT ON COLUMN paper_issues.status IS 'open | resolved | wont_fix (COE, once) | carried_forward (regeneration only). src/paper-policy.js ISSUE_STATUSES.';
COMMENT ON COLUMN paper_issues.origin_issue_id IS 'The first issue of a carry chain (NULL when this row is the origin). Referrals are keyed by it.';

-- ---------------------------------------------------------------------------
-- 7. Referrals of a source question (examination-side record only; the question bank is never written, §1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_issue_referrals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id       UUID NOT NULL UNIQUE REFERENCES paper_issues(id),   -- origin issue
  question_id    UUID NOT NULL REFERENCES questions(id),
  referred_by    UUID NOT NULL REFERENCES users(id),
  recipients     UUID[] NOT NULL CHECK (cardinality(recipients) > 0),
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('reviewer', 'hod')),
  note           TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 10 AND 1000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 8. COE send-backs (append-only; txid ties the row to the status change made in the same transaction)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_send_backs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id       UUID NOT NULL REFERENCES exam_papers(id),
  from_status    TEXT NOT NULL CHECK (from_status IN ('VALIDATION_PENDING', 'VALIDATED')),
  reason         TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 2000),
  open_issue_ids UUID[] NOT NULL DEFAULT '{}',
  sent_back_by   UUID NOT NULL REFERENCES users(id),
  txid           BIGINT NOT NULL DEFAULT txid_current(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paper_send_backs_paper ON paper_send_backs(paper_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_history_rewrite()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% rows are history and cannot be changed or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_paper_send_backs_append_only ON paper_send_backs;
CREATE TRIGGER trg_paper_send_backs_append_only BEFORE UPDATE OR DELETE ON paper_send_backs
  FOR EACH ROW EXECUTE FUNCTION prevent_history_rewrite();
DROP TRIGGER IF EXISTS trg_paper_issue_referrals_append_only ON paper_issue_referrals;
CREATE TRIGGER trg_paper_issue_referrals_append_only BEFORE UPDATE OR DELETE ON paper_issue_referrals
  FOR EACH ROW EXECUTE FUNCTION prevent_history_rewrite();

-- ---------------------------------------------------------------------------
-- 9. Two history rows per regeneration: question_regenerated + issue_resolution share a revision number.
-- ---------------------------------------------------------------------------
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'paper_revisions'::regclass AND contype = 'u'
              AND pg_get_constraintdef(oid) = 'UNIQUE (paper_id, revision_number)'
  LOOP EXECUTE format('ALTER TABLE paper_revisions DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_revisions_paper_revision_type ON paper_revisions(paper_id, revision_number, change_type);

-- ---------------------------------------------------------------------------
-- 10. Issue rules (src/paper-policy.js ISSUE_REPORTABLE_IN / ISSUE_CLOSABLE_IN; drift-checked)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_paper_issue_rules()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT paper_status INTO v_status FROM exam_papers WHERE id = COALESCE(NEW.paper_id, OLD.paper_id);

  IF TG_OP = 'DELETE' THEN
    IF v_status IS NULL OR v_status IN ('DRAFT', 'GENERATING') THEN RETURN OLD; END IF;  -- cascade of an unbuilt paper
    RAISE EXCEPTION 'Paper issues are history and cannot be deleted (issue %)', OLD.id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.resolution IS NOT NULL OR NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL
       OR NEW.carried_to_issue_id IS NOT NULL THEN
      RAISE EXCEPTION 'A new paper issue starts open';
    END IF;
    IF NEW.question_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM paper_questions WHERE paper_id = NEW.paper_id AND question_id = NEW.question_id) THEN
      RAISE EXCEPTION 'Question % is not part of paper %', NEW.question_id, NEW.paper_id;
    END IF;
    IF NEW.carried_from_issue_id IS NOT NULL THEN
      IF v_status NOT IN ('GENERATING', 'GENERATED') THEN
        RAISE EXCEPTION 'Issues are carried only onto a newly generated revision (paper is %)', v_status;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM paper_issues s JOIN exam_papers np ON np.id = NEW.paper_id
                      WHERE s.id = NEW.carried_from_issue_id AND s.status = 'open' AND np.parent_paper_id = s.paper_id
                        AND s.reported_by = NEW.reported_by AND s.issue_type = NEW.issue_type AND s.description = NEW.description
                        AND s.question_id IS NOT DISTINCT FROM NEW.question_id) THEN
        RAISE EXCEPTION 'A carried issue must copy an open issue of the parent revision';
      END IF;
      RETURN NEW;
    END IF;
    IF v_status IS NULL OR v_status NOT IN ('VALIDATION_PENDING', 'VALIDATED') THEN
      RAISE EXCEPTION 'Issues can be reported only while a paper is VALIDATION_PENDING or VALIDATED (current: %)', v_status;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM paper_validator_assignments WHERE paper_id = NEW.paper_id AND validator_id = NEW.reported_by AND is_active) THEN
      RAISE EXCEPTION 'Only a validator assigned to this paper can report an issue';
    END IF;
    -- Still eligible (src/paper-access.js): an active validator account whose validator scope covers the examination.
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.reported_by AND role = 'validator' AND status = 'ACTIVE' AND is_active)
       OR NOT EXISTS (SELECT 1 FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id JOIN programs pr ON pr.id = e.program_id
                       WHERE ep.id = NEW.paper_id
                         AND user_has_scope(NEW.reported_by, 'validator', e.campus_id, pr.department_id, e.program_id, e.course_offering_id)) THEN
      RAISE EXCEPTION 'Only an active validator whose scope covers this examination can report an issue';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: what was reported never changes.
  IF ROW(NEW.id, NEW.paper_id, NEW.question_id, NEW.issue_type, NEW.description, NEW.reported_by, NEW.created_at, NEW.carried_from_issue_id, NEW.origin_issue_id)
     IS DISTINCT FROM ROW(OLD.id, OLD.paper_id, OLD.question_id, OLD.issue_type, OLD.description, OLD.reported_by, OLD.created_at, OLD.carried_from_issue_id, OLD.origin_issue_id) THEN
    RAISE EXCEPTION 'A reported issue cannot be edited (issue %)', OLD.id;
  END IF;
  IF OLD.status <> 'open' THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'Issue % is already closed (%); a closed issue cannot change', OLD.id, OLD.status;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'open' THEN
    IF ROW(NEW.resolution, NEW.resolved_by, NEW.resolved_at, NEW.carried_to_issue_id)
       IS DISTINCT FROM ROW(OLD.resolution, OLD.resolved_by, OLD.resolved_at, OLD.carried_to_issue_id) THEN
      RAISE EXCEPTION 'An open issue has no resolution; close it with a status';
    END IF;
    RETURN NEW;
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED') THEN
    RAISE EXCEPTION 'Issues of a % paper cannot be closed', v_status;
  END IF;
  IF NEW.resolution IS NULL OR length(trim(NEW.resolution)) < 10 OR NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'Closing an issue records who, when and a resolution of at least 10 characters';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.resolved_by AND role = 'coe' AND is_active) THEN
    RAISE EXCEPTION 'Only an active COE closes validator issues';
  END IF;
  IF (NEW.status = 'carried_forward') <> (NEW.carried_to_issue_id IS NOT NULL) THEN
    RAISE EXCEPTION 'carried_forward is set only together with the issue it was carried to';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_paper_issue_rules
  BEFORE INSERT OR UPDATE OR DELETE ON paper_issues
  FOR EACH ROW EXECUTE FUNCTION enforce_paper_issue_rules();
COMMENT ON TRIGGER trg_enforce_paper_issue_rules ON paper_issues IS
  'Issues are reported by an active validator while VALIDATION_PENDING/VALIDATED, closed once by a COE (or carried by regeneration), never edited or deleted. Mirrors src/paper-policy.js.';

-- ---------------------------------------------------------------------------
-- 11. Paper lifecycle (036's function, verbatim apart from the five 039 edits marked below).
--     The trigger trg_enforce_paper_lifecycle already points at this function.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_paper_lifecycle()
RETURNS TRIGGER AS $$
DECLARE
  v_override  BOOLEAN := COALESCE(current_setting('app.paper_override', true), '') = 'on';
  v_archive_cols TEXT[] := ARRAY['paper_status', 'archived_at', 'archived_by', 'archive_reason'];
  v_generation_cols TEXT[] := ARRAY['examination_id', 'generation_seed', 'generator_version', 'blueprint_version_id',
                                    'eligible_question_set_hash', 'paper_version', 'parent_paper_id', 'course_offering_id', 'subject_id',
                                    -- 039 edit (d): what the generator decided and why (spec §21, §24, §28): the section
                                    -- rules printed on the paper, resolved targets, overrides, realised Bloom profile.
                                    'format_config', 'candidate_metrics', 'constraint_overrides', 'bloom_realized'];
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
    -- 039 edit (a): open validator issues block COE approval in the database too (spec §29).
    IF NEW.paper_status = 'COE_APPROVED' AND EXISTS (SELECT 1 FROM paper_issues WHERE paper_id = NEW.id AND status = 'open') THEN
      RAISE EXCEPTION 'Open validator issues must be resolved before COE approval';
    END IF;
    IF v_total <> 4 THEN
      RAISE EXCEPTION 'Paper must have exactly 4 active validators before % (currently: %)', NEW.paper_status, v_total;
    END IF;
    IF v_approvals < v_required THEN
      RAISE EXCEPTION 'At least % of 4 validators must approve before % (currently: %)', v_required, NEW.paper_status, v_approvals;
    END IF;
  END IF;

  -- 039 edit (b): the COE send-back is the only way from VALIDATED back to CHANGES_REQUIRED, and it must be
  -- recorded (paper_send_backs, same transaction, by an active COE).
  IF OLD.paper_status = 'VALIDATED' AND NEW.paper_status = 'CHANGES_REQUIRED' AND NOT EXISTS (
      SELECT 1 FROM paper_send_backs b JOIN users u ON u.id = b.sent_back_by
       WHERE b.paper_id = NEW.id AND b.from_status = 'VALIDATED' AND b.txid = txid_current() AND u.role = 'coe' AND u.is_active) THEN
    RAISE EXCEPTION 'A VALIDATED paper returns to CHANGES_REQUIRED only through a recorded COE send-back with a reason';
  END IF;

  -- 039 edit (c): VALIDATED -> CHANGES_REQUIRED (COE send-back) added.
  v_allowed := CASE OLD.paper_status
    WHEN 'DRAFT'              THEN ARRAY['GENERATING']
    WHEN 'GENERATING'         THEN ARRAY['GENERATED', 'DRAFT']
    WHEN 'GENERATED'          THEN ARRAY['VALIDATION_PENDING', 'REGENERATED', 'ARCHIVED']
    WHEN 'VALIDATION_PENDING' THEN ARRAY['VALIDATED', 'CHANGES_REQUIRED']
    WHEN 'CHANGES_REQUIRED'   THEN ARRAY['REGENERATED', 'ARCHIVED']
    WHEN 'REGENERATED'        THEN ARRAY['ARCHIVED']
    WHEN 'VALIDATED'          THEN ARRAY['COE_APPROVED', 'CHANGES_REQUIRED']
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
  -- 039 edit (e): never from CHANGES_REQUIRED, nor from a round holding a CHANGES_REQUIRED decision: the reset
  -- recovers a stuck paper and must not let rejected content be re-validated unchanged.
  IF v_override AND NEW.paper_status = 'GENERATED'
     AND OLD.paper_status IN ('VALIDATION_PENDING', 'VALIDATED', 'COE_APPROVED') THEN
    IF OLD.paper_status = 'VALIDATION_PENDING' AND EXISTS (
        SELECT 1 FROM paper_validator_assignments WHERE paper_id = NEW.id AND is_active AND decision = 'CHANGES_REQUIRED') THEN
      RAISE EXCEPTION 'The technical reset cannot discard a CHANGES_REQUIRED decision (paper %); regenerate or archive the paper', NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid paper status transition: % -> %', OLD.paper_status, NEW.paper_status;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enforce_paper_lifecycle() IS
  'Paper state machine (spec §26), locks (§28), validator + COE prerequisites (§29). 039: COE send-back VALIDATED -> CHANGES_REQUIRED (needs a paper_send_backs row), open issues block COE_APPROVED, generation results (format_config, candidate_metrics, constraint_overrides, bloom_realized) frozen, the technical reset never from CHANGES_REQUIRED or over a CHANGES_REQUIRED decision. Mirrors src/paper-policy.js.';

-- ---------------------------------------------------------------------------
-- 12. paper_version is unique per examination (computed under the generation lock, exam-generator.js).
--     Duplicates from the old race are exempted by id, not renumbered (036 freezes paper_version; §38, §39 inv. 7).
-- ---------------------------------------------------------------------------
DO $$ DECLARE v_dups UUID[]; BEGIN
  IF to_regclass('uq_exam_papers_examination_version') IS NULL THEN
    SELECT array_agg(id ORDER BY id) INTO v_dups FROM (
      SELECT id, row_number() OVER (PARTITION BY examination_id, paper_version ORDER BY created_at, id) AS rn
        FROM exam_papers WHERE examination_id IS NOT NULL) d WHERE rn > 1;
    IF v_dups IS NOT NULL THEN
      RAISE NOTICE '039: % legacy paper(s) repeat an earlier paper_version of their examination; exempted: %', cardinality(v_dups), v_dups;
    END IF;
    -- The earliest row of each duplicate group stays indexed, so no new row can reuse that (examination, version).
    EXECUTE 'CREATE UNIQUE INDEX uq_exam_papers_examination_version ON exam_papers (examination_id, paper_version) WHERE examination_id IS NOT NULL'
      || CASE WHEN v_dups IS NULL THEN '' ELSE format(' AND id <> ALL (%L::uuid[])', v_dups) END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 13. Per examination: at most one paper in progress (src/paper-policy.js LIVE_PAPER_STATUSES; drift-checked)
--     and at most one printed (PRINT_READY) paper. A new candidate is a regeneration of the paper in progress,
--     or a revision of the printed one (§28), never a second paper. Checked at COMMIT, under the generator's
--     advisory key, so it is race-free for any writer: on INSERT and DRAFT -> GENERATING (in progress) and on
--     -> PRINT_READY (printed; the print-ready route archives the previous printed paper in the same
--     transaction). Examinations that already break the rule are grandfathered (listed below with NOTICE).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_one_live_paper_per_examination()
RETURNS TRIGGER AS $$
DECLARE
  -- Must match LIVE_PAPER_STATUSES in src/paper-policy.js (test-paper-policy.mjs checks this).
  v_live_statuses TEXT[] := ARRAY['GENERATING', 'GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED', 'COE_APPROVED'];
  v_offering UUID;
  v_count    INTEGER;
BEGIN
  IF NEW.examination_id IS NULL THEN RETURN NULL; END IF;
  SELECT course_offering_id INTO v_offering FROM examinations WHERE id = NEW.examination_id;
  -- Same key as generatePaper: already held (re-entrant) by a generation transaction; serialises any other writer.
  PERFORM pg_advisory_xact_lock(hashtextextended('generate:' || v_offering::text, 0));
  IF NEW.paper_status = 'PRINT_READY' THEN
    SELECT COUNT(*) INTO v_count FROM exam_papers WHERE examination_id = NEW.examination_id AND paper_status = 'PRINT_READY';
    IF v_count > 1 THEN
      RAISE EXCEPTION 'Examination % already has a printed paper; archive it when its revision is printed', NEW.examination_id
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_one_printed_paper_per_examination';
    END IF;
    RETURN NULL;
  END IF;
  SELECT COUNT(*) INTO v_count FROM exam_papers WHERE examination_id = NEW.examination_id AND paper_status = ANY (v_live_statuses);
  IF v_count > 1 THEN
    RAISE EXCEPTION 'Examination % already has a paper in progress; regenerate or archive it instead of generating another', NEW.examination_id
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_one_live_paper_per_examination';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_one_live_paper_per_examination ON exam_papers;
CREATE CONSTRAINT TRIGGER trg_one_live_paper_per_examination
  AFTER INSERT ON exam_papers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_one_live_paper_per_examination();
COMMENT ON TRIGGER trg_one_live_paper_per_examination ON exam_papers IS
  'At most one paper in progress per examination, checked at COMMIT. Mirrors src/paper-policy.js LIVE_PAPER_STATUSES and the check in exam-generator.js generatePaper.';
DROP TRIGGER IF EXISTS trg_one_live_paper_per_examination_status ON exam_papers;
CREATE CONSTRAINT TRIGGER trg_one_live_paper_per_examination_status
  AFTER UPDATE ON exam_papers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.paper_status IS DISTINCT FROM NEW.paper_status AND NEW.paper_status IN ('GENERATING', 'PRINT_READY'))
  EXECUTE FUNCTION check_one_live_paper_per_examination();
COMMENT ON TRIGGER trg_one_live_paper_per_examination_status ON exam_papers IS
  'DRAFT -> GENERATING: at most one paper in progress; -> PRINT_READY: at most one printed paper per examination (src/routes/coe-approval.js archives the previous one). Checked at COMMIT.';

DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT examination_id, COUNT(*) AS n FROM exam_papers
            WHERE examination_id IS NOT NULL
              AND paper_status IN ('GENERATING', 'GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED', 'COE_APPROVED')
            GROUP BY examination_id HAVING COUNT(*) > 1 LOOP
    RAISE NOTICE '039: examination % has % papers in progress (grandfathered); /generate and /regenerate refuse until the extras are archived', r.examination_id, r.n;
  END LOOP;
  FOR r IN SELECT examination_id, COUNT(*) AS n FROM exam_papers
            WHERE examination_id IS NOT NULL AND paper_status = 'PRINT_READY'
            GROUP BY examination_id HAVING COUNT(*) > 1 LOOP
    RAISE NOTICE '039: examination % has % PRINT_READY papers (grandfathered); archive all but the one in use', r.examination_id, r.n;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 14. A used blueprint never changes (spec §21): only is_active (and updated_at) may change; it cannot be
--     deleted (exam_papers.blueprint_version_id has no foreign key, 028). hard_targets never goes back to FALSE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION protect_used_blueprint()
RETURNS TRIGGER AS $$
DECLARE
  v_mutable TEXT[] := ARRAY['is_active', 'updated_at'];
  v_used    BOOLEAN;
BEGIN
  v_used := EXISTS (SELECT 1 FROM exam_papers WHERE blueprint_version_id = OLD.id);
  IF TG_OP = 'DELETE' THEN
    IF v_used THEN
      RAISE EXCEPTION 'Blueprint % is used by a generated paper and cannot be deleted', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.hard_targets AND NOT NEW.hard_targets THEN
    RAISE EXCEPTION 'A blueprint with exact CO/Bloom targets cannot be turned back into a legacy soft-target blueprint';
  END IF;
  IF v_used AND (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    -- Same text as 031 (the smoke test matches it).
    RAISE EXCEPTION 'Blueprint is used by a generated paper and cannot be modified; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_used_blueprint ON paper_blueprints;
CREATE TRIGGER trg_protect_used_blueprint
  BEFORE UPDATE OR DELETE ON paper_blueprints
  FOR EACH ROW EXECUTE FUNCTION protect_used_blueprint();
ALTER TABLE paper_blueprints ALTER COLUMN hard_targets SET DEFAULT TRUE;  -- existing rows keep FALSE (= legacy)
COMMENT ON COLUMN paper_blueprints.hard_targets IS
  'FALSE = legacy (pre-037) soft targets. Since 039 such a version cannot generate while it has CO/Bloom targets; copy it into a new version (src/exam-generator.js legacyTargetError).';

-- ---------------------------------------------------------------------------
-- 15. Blueprint versions under concurrency: one version number per examination, one active version.
--     The save route locks the examination row; these indexes are the backstop.
-- ---------------------------------------------------------------------------
UPDATE paper_blueprints b SET is_active = FALSE
 WHERE b.is_active AND b.examination_id IS NOT NULL AND EXISTS (
   SELECT 1 FROM paper_blueprints n WHERE n.examination_id = b.examination_id AND n.is_active
      AND (n.version_number, n.created_at, n.id) > (b.version_number, b.created_at, b.id));
CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_blueprints_active_per_examination
  ON paper_blueprints (examination_id) WHERE is_active AND examination_id IS NOT NULL;
DO $$ DECLARE v_dups UUID[]; BEGIN
  IF to_regclass('uq_paper_blueprints_examination_version') IS NULL THEN
    SELECT array_agg(id ORDER BY id) INTO v_dups FROM (
      SELECT id, row_number() OVER (PARTITION BY examination_id, version_number ORDER BY created_at, id) AS rn
        FROM paper_blueprints WHERE examination_id IS NOT NULL) d WHERE rn > 1;
    IF v_dups IS NOT NULL THEN
      RAISE NOTICE '039: % legacy blueprint(s) repeat an earlier version_number of their examination; exempted: %', cardinality(v_dups), v_dups;
    END IF;
    EXECUTE 'CREATE UNIQUE INDEX uq_paper_blueprints_examination_version ON paper_blueprints (examination_id, version_number) WHERE examination_id IS NOT NULL'
      || CASE WHEN v_dups IS NULL THEN '' ELSE format(' AND id <> ALL (%L::uuid[])', v_dups) END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 16. Constraint override records: written by the generation that uses them (paper still GENERATING), approved
--     by the generating COE (spec §29; HOD and admin take no part, §2/§36), never changed afterwards.
-- ---------------------------------------------------------------------------
ALTER TABLE paper_constraint_overrides ADD COLUMN IF NOT EXISTS approval_basis TEXT;
COMMENT ON COLUMN paper_constraint_overrides.approved_by IS 'The generating COE (PIVOT_SPEC_V2 §29). HOD and admin take no part.';
COMMENT ON COLUMN paper_constraint_overrides.approval_basis IS 'generating_coe: the COE who generated the paper approved the override (src/exam-generator.js generatePaper).';

CREATE OR REPLACE FUNCTION protect_constraint_override_records()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT paper_status INTO v_status FROM exam_papers WHERE id = COALESCE(NEW.paper_id, OLD.paper_id);
  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'GENERATING' THEN
      RAISE EXCEPTION 'A constraint override can only be recorded by the generation that uses it (paper is %)', v_status;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (v_status IS NULL OR v_status IN ('DRAFT', 'GENERATING')) THEN
    RETURN OLD;  -- cascade of an unbuilt paper (same reasoning as 036 protect_locked_paper_questions)
  END IF;
  RAISE EXCEPTION 'Constraint override records are permanent (paper %)', COALESCE(NEW.paper_id, OLD.paper_id);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_constraint_override_records ON paper_constraint_overrides;
CREATE TRIGGER trg_protect_constraint_override_records
  BEFORE INSERT OR UPDATE OR DELETE ON paper_constraint_overrides
  FOR EACH ROW EXECUTE FUNCTION protect_constraint_override_records();
