-- 038: question workflow hardening (phase 1 of the post-pivot gap audit).
-- Closes the ways a question could leave the reviewer workflow (PIVOT_SPEC_V2 §2, §7, §11, §12, §14, §39):
--   1. AI review / appeal wrote the legacy `status`, which the 031 bridge turned into question_status changes
--      (an ACTIVE question became editable). AI findings are now advisory columns only (§39 inv. 10).
--   2. The 026 transition guard was BEFORE UPDATE OF question_status. PostgreSQL fires a column-list trigger
--      only when the UPDATE statement itself names the column; a value set by another BEFORE trigger does not
--      count. Legacy writes (SET status / is_draft) get their question_status from trg_a_legacy_status_to_qs,
--      so none of those changes were validated (SUBMITTED -> APPROVED 'Approve anyway', CHANGES_REQUESTED ->
--      DRAFT, APPROVED -> UNDER_REVIEW, ...). The guard is now an AFTER trigger without a column list.
--   3. APPROVED / ACTIVE / RETIRED / REJECTED content could be edited in place (§14: approved edits make a new
--      version). It is now locked, attachments included.
--   4. validate_question_for_active() required APPROVED, so a restore (RETIRED -> ACTIVE) always failed.
--   5. A resubmission created a new canonical question; versions now carry the type data so a revision is a
--      new version of the SAME canonical question. The reviewer's change request is stored on the question.
--   6. Bulk-imported questions had no canonical record / CO mapping, so they could never pass the gate.
--   7. Review-batch verdicts never drove the decision; a single reviewer could approve via /transition alone.
--      Leaving UNDER_REVIEW now needs the decision recorded on the question's open review round, and
--      REJECTED is reached only that way (CHANGES_REQUESTED -> REJECTED is gone: nobody rejects alone).
--
-- Row triggers on questions after this migration. Same-timing triggers fire alphabetically, each receiving the
-- NEW row returned by the previous one; a column-list trigger fires only when the statement names the column.
--   BEFORE UPDATE
--     trg_a_legacy_status_to_qs      OF status, is_draft       derives question_status from legacy writes
--     trg_bloom_on_canonical_link    OF canonical_question_id  mirrors the reviewer-verified Bloom level
--     trg_enforce_quality_gate       OF question_status        gate on the stored row + activation stamp
--     trg_sync_question_campus       OF course_offering_id     campus_id
--     trg_sync_question_status       OF question_status        legacy status / is_draft mirror
--   AFTER UPDATE (see the final row, whichever BEFORE trigger produced it)
--     trg_question_content_lock      WHEN the old state is locked
--     trg_question_transition_guard  WHEN question_status changed (replaces trg_validate_question_state_transition)
-- The transition table must allow every transition in src/routes/questions-lifecycle.js TRANSITIONS
-- (test/lifecycle.test.mjs checks this).
-- Forward-only and idempotent. No data is dropped.

-- ---------------------------------------------------------------------------
-- 1. AI review is advisory (spec §39 invariant 10). Findings and the author's dispute are stored next to
--    the question; nothing here can change question_status.
-- ---------------------------------------------------------------------------
ALTER TABLE questions ADD COLUMN IF NOT EXISTS ai_reviewed_at TIMESTAMPTZ;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS ai_review_dispute TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS ai_review_disputed_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_ai_review_dispute_len') THEN
    ALTER TABLE questions ADD CONSTRAINT questions_ai_review_dispute_len
      CHECK (ai_review_dispute IS NULL OR char_length(ai_review_dispute) BETWEEN 3 AND 2000);
  END IF;
END $$;
-- Questions appealed under the old workflow keep showing in the HOD attention list.
UPDATE questions q SET
  ai_review_dispute = 'Appealed to the HOD under the previous workflow (no reason was recorded).',
  ai_review_disputed_at = a.appealed_at
FROM (SELECT entity_id, MAX(created_at) AS appealed_at FROM audit_log
      WHERE action = 'ai_review_appealed' GROUP BY entity_id) a
WHERE a.entity_id = q.id::text AND q.ai_review_dispute IS NULL;
CREATE INDEX IF NOT EXISTS idx_questions_ai_dispute ON questions(course_offering_id) WHERE ai_review_dispute IS NOT NULL;
COMMENT ON COLUMN questions.ai_review_notes IS 'Advisory automated/AI findings (JSON array). Never drives question_status (spec §39 inv. 10).';
COMMENT ON COLUMN questions.ai_review_dispute IS 'Author''s note disputing the AI findings, shown to the HOD/reviewers. Advisory; never changes status.';

-- ---------------------------------------------------------------------------
-- 2. Question versions carry the full type-specific content (spec §8, §10, §14). A resubmission after
--    CHANGES_REQUESTED appends a version to the SAME canonical question (canonical.js appendCanonicalVersion).
-- ---------------------------------------------------------------------------
ALTER TABLE question_versions ADD COLUMN IF NOT EXISTS answer_data JSONB;
ALTER TABLE question_versions ADD COLUMN IF NOT EXISTS subtopic TEXT;
DO $$ BEGIN
  ALTER TABLE question_versions ADD CONSTRAINT question_versions_answer_data_object
    CHECK (answer_data IS NULL OR jsonb_typeof(answer_data) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Current versions: copy type data from the submission that created the canonical, only where the wording still matches.
UPDATE question_versions v SET answer_data = q.answer_data, subtopic = q.subtopic
  FROM question_canonicalization_events e JOIN questions q ON q.id = e.submission_id
 WHERE e.canonical_question_id = v.canonical_question_id AND e.action = 'created_canonical'
   AND v.is_current AND v.answer_data IS NULL AND v.subtopic IS NULL
   AND (q.answer_data IS NOT NULL OR q.subtopic IS NOT NULL) AND q.question_text = v.question_text;
-- At most one current version / current canonical answer per canonical question (guards concurrent resubmits).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM question_versions WHERE is_current GROUP BY canonical_question_id HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_question_versions_current ON question_versions (canonical_question_id) WHERE is_current;
  ELSE
    RAISE NOTICE 'question_versions has canonical questions with several current versions; uq_question_versions_current not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM canonical_answers WHERE is_current GROUP BY canonical_question_id HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_canonical_answers_current ON canonical_answers (canonical_question_id) WHERE is_current;
  ELSE
    RAISE NOTICE 'canonical_answers has several current answers for one canonical question; uq_canonical_answers_current not created';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The reviewer's change request is stored on the question (it lived only in audit_log details), so the
--    author sees what to fix and the next reviewer sees what was asked. Kept after resubmission.
-- ---------------------------------------------------------------------------
ALTER TABLE questions ADD COLUMN IF NOT EXISTS change_request_reason TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS change_requested_by UUID REFERENCES users(id);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS change_requested_at TIMESTAMPTZ;
-- Open change requests, from the audit trail (details is the JSON text written by logAudit).
UPDATE questions q SET change_request_reason = a.details::jsonb->>'reason', change_requested_by = a.user_id, change_requested_at = a.created_at
  FROM (SELECT DISTINCT ON (entity_id) entity_id, details, user_id, created_at FROM audit_log
         WHERE action = 'question_transition_changes_requested' ORDER BY entity_id, created_at DESC, id DESC) a
 WHERE a.entity_id = q.id::text AND q.question_status = 'CHANGES_REQUESTED' AND q.change_request_reason IS NULL;

-- ---------------------------------------------------------------------------
-- 4. CO mappings typed in a bulk spreadsheet (codes resolved against the question's syllabus version,
--    unverified until a reviewer confirms them) are recorded as source 'bulk'.
-- ---------------------------------------------------------------------------
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'question_course_outcomes'::regclass AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%source%'
  LOOP EXECUTE format('ALTER TABLE question_course_outcomes DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE question_course_outcomes ADD CONSTRAINT question_course_outcomes_source_check
  CHECK (source IN ('ai', 'manual', 'reviewer', 'bulk'));

-- ---------------------------------------------------------------------------
-- 5. A question's review round is its review_batch_items row (brain.md §5, §8). outcome IS NULL = open round;
--    the decision that ends it (APPROVED / CHANGES_REQUESTED / REJECTED) is written there by
--    POST /questions/:id/transition in the same transaction as the question_status change (section 11 checks it).
-- ---------------------------------------------------------------------------
ALTER TABLE review_batch_items ADD COLUMN IF NOT EXISTS outcome    TEXT;
ALTER TABLE review_batch_items ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES users(id);
ALTER TABLE review_batch_items ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_batch_items_outcome_check') THEN
    ALTER TABLE review_batch_items ADD CONSTRAINT review_batch_items_outcome_check
      CHECK (outcome IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'SUPERSEDED'));
  END IF;
END $$;
-- Rounds that ended before 038 (question already left review, or batch cancelled): closed without a recorded decision.
UPDATE review_batch_items rbi SET outcome = 'SUPERSEDED'
  FROM questions q, review_batches rb
 WHERE rbi.outcome IS NULL AND q.id = rbi.question_id AND rb.id = rbi.review_batch_id
   AND (q.question_status NOT IN ('SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW') OR rb.status = 'cancelled');
-- Rounds that can no longer decide anything. Before 038 a decision applied through /transition, a withdrawal,
-- an edit or a resubmission did not close the round, so its verdicts may predate the question's current
-- content; and a closed batch takes no verdicts, so an open round in it could never be decided (the question
-- would stay UNDER_REVIEW for good). Closed here; the HOD puts the question in a new review batch.
UPDATE review_batch_items rbi SET outcome = 'SUPERSEDED'
 WHERE rbi.outcome IS NULL AND (
       EXISTS (SELECT 1 FROM review_batches rb WHERE rb.id = rbi.review_batch_id AND rb.status = 'closed')
    OR EXISTS (SELECT 1 FROM questions q WHERE q.id = rbi.question_id AND q.last_edited_at > rbi.created_at)
    OR EXISTS (SELECT 1 FROM audit_log a
                WHERE a.entity_id = rbi.question_id::text AND a.created_at > rbi.created_at
                  AND a.action IN ('question_transition_changes_requested', 'question_transition_approved',
                                   'question_transition_rejected', 'question_transition_draft',
                                   'question_transition_submitted', 'question_transition_resubmitted',
                                   'question_final_submit', 'question_resubmitted', 'draft_updated',
                                   'question_approved', 'question_rejected')));
-- At most one open round per question: keep the newest.
UPDATE review_batch_items rbi SET outcome = 'SUPERSEDED'
 WHERE rbi.outcome IS NULL AND EXISTS (SELECT 1 FROM review_batch_items newer
   WHERE newer.question_id = rbi.question_id AND newer.outcome IS NULL
     AND (newer.created_at, newer.id) > (rbi.created_at, rbi.id));
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_batch_items_open_round ON review_batch_items(question_id) WHERE outcome IS NULL;
COMMENT ON COLUMN review_batch_items.outcome IS
  'NULL = open review round; else the lifecycle decision that closed it (SUPERSEDED = closed without a recorded decision)';

-- ---------------------------------------------------------------------------
-- 6. Legacy mirror of ACTIVE / RETIRED / REJECTED questions. An AI review or appeal could mark an ACTIVE
--    question 'needs_teacher_fix' / 'flagged' (the 031 bridge left question_status alone), which made it
--    editable through the draft route. Runs while the 031 bridge is still in place, before section 9 starts
--    refusing such writes.
-- ---------------------------------------------------------------------------
UPDATE questions SET status = 'approved', is_draft = FALSE
WHERE question_status IN ('ACTIVE', 'RETIRED') AND (status IS DISTINCT FROM 'approved' OR is_draft);

UPDATE questions SET status = 'rejected', is_draft = FALSE
WHERE question_status = 'REJECTED' AND (status NOT IN ('rejected', 'withdrawn_duplicate') OR is_draft);

-- ---------------------------------------------------------------------------
-- 7. Bulk-imported questions that are already past DRAFT get the canonical question, version 1, canonical
--    answer and (unverified, source 'bulk') CO mapping a bulk confirm now creates (migration 015's precedent).
--    Safe to re-run: only rows with canonical_question_id IS NULL. Runs before the content lock (section 12).
--    The event reason marks these rows so run-checks.sh can tell them from any other row-count change.
-- ---------------------------------------------------------------------------
DO $$ DECLARE q RECORD; cq_id UUID; qv_id UUID; BEGIN
  FOR q IN SELECT * FROM questions
            WHERE bulk_batch_id IS NOT NULL AND canonical_question_id IS NULL AND question_status NOT IN ('DRAFT', 'REJECTED') LOOP
    INSERT INTO canonical_questions (subject_id, canonical_text, normalized_text, question_type, question_hash,
                                     quality_status, workflow_status, applicability_status, embedding)
    VALUES (q.subject_id, q.question_text, lower(trim(regexp_replace(q.question_text, '\s+', ' ', 'g'))), q.question_type, q.question_hash, 'pending',
      CASE q.question_status WHEN 'APPROVED' THEN 'approved' WHEN 'ACTIVE' THEN 'approved' WHEN 'RETIRED' THEN 'retired'
        WHEN 'CHANGES_REQUESTED' THEN 'needs_teacher_revision' WHEN 'UNDER_REVIEW' THEN 'reviewer_review' ELSE 'submitted' END,
      'active', q.embedding)
    RETURNING id INTO cq_id;
    INSERT INTO question_versions (canonical_question_id, version_number, question_text, question_type, marks,
                                   option_a, option_b, option_c, option_d, correct_answer, answer_data, subtopic,
                                   created_by, change_reason, is_current)
    VALUES (cq_id, 1, q.question_text, q.question_type, q.marks, q.option_a, q.option_b, q.option_c, q.option_d,
            q.correct_answer, q.answer_data, q.subtopic, q.submitted_by, 'Initial submission (bulk import)', TRUE)
    RETURNING id INTO qv_id;
    UPDATE canonical_questions SET current_version_id = qv_id WHERE id = cq_id;
    IF q.model_answer IS NOT NULL AND length(trim(q.model_answer)) > 0 THEN
      INSERT INTO canonical_answers (canonical_question_id, version_number, answer_text, created_by, status, is_current)
      VALUES (cq_id, 1, q.model_answer, q.submitted_by, 'draft', TRUE);
    END IF;
    INSERT INTO question_canonicalization_events (canonical_question_id, submission_id, action, reason, performed_by)
    VALUES (cq_id, q.id, 'created_canonical', 'Backfilled by 038: bulk-imported before bulk confirm created canonical questions', NULL);
    -- First code typed = PRIMARY, the rest SECONDARY (same model as /submit); unknown codes are skipped.
    INSERT INTO question_course_outcomes (canonical_question_id, course_outcome_id, relationship_type, source)
    SELECT cq_id, m.id, CASE WHEN m.ord = min(m.ord) OVER () THEN 'primary' ELSE 'secondary' END, 'bulk'
      FROM (SELECT DISTINCT ON (co.id) co.id, c.ord
              FROM unnest(q.submitted_cos) WITH ORDINALITY AS c(code, ord)
              JOIN course_outcomes co ON co.syllabus_version_id = q.syllabus_version_id AND co.is_active
                                     AND lower(co.code) = lower(trim(c.code))
             ORDER BY co.id, c.ord) m
    ON CONFLICT (canonical_question_id, course_outcome_id) DO NOTHING;
    UPDATE questions SET canonical_question_id = cq_id WHERE id = q.id;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Quality gate: restore (RETIRED -> ACTIVE) re-runs every check.
--    p_from_status is the state the question leaves; NULL = its stored state (inside a BEFORE trigger that is
--    OLD). Same rules as 037 otherwise. The one-argument version is dropped: two overloads with a default
--    would make validate_question_for_active($1) ambiguous.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS validate_question_for_active(UUID);

CREATE OR REPLACE FUNCTION validate_question_for_active(p_question_id UUID, p_from_status TEXT DEFAULT NULL)
RETURNS TABLE(valid BOOLEAN, errors TEXT[]) AS $$
DECLARE
  q RECORD;
  error_list TEXT[] := ARRAY[]::TEXT[];
  v_topic_ok BOOLEAN := FALSE;
  v_from TEXT;
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

  -- APPROVED -> ACTIVE (activation) or RETIRED -> ACTIVE (restore); the transition guard owns the rest of the table.
  v_from := COALESCE(p_from_status, q.question_status);
  IF v_from IS NULL OR v_from NOT IN ('APPROVED', 'RETIRED') THEN
    error_list := array_append(error_list, 'Question must be APPROVED (or RETIRED, to restore) before ACTIVE');
  END IF;
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

  -- Type-specific rules (spec §10); mirrors src/question-types.js validateQuestionByType(forActivation).
  CASE q.question_type
    WHEN 'mcq' THEN
      IF q.option_a IS NULL OR q.option_b IS NULL OR q.option_c IS NULL OR q.option_d IS NULL THEN error_list := array_append(error_list, 'MCQ missing options'); END IF;
      IF q.correct_answer IS NULL THEN error_list := array_append(error_list, 'MCQ missing correct answer'); END IF;
    WHEN 'true_false' THEN
      IF upper(coalesce(q.correct_answer, '')) NOT IN ('TRUE', 'FALSE') THEN error_list := array_append(error_list, 'True/False needs a correct answer of TRUE or FALSE'); END IF;
    WHEN 'assertion_reason' THEN
      IF coalesce(trim(q.answer_data->>'assertion'), '') = '' OR coalesce(trim(q.answer_data->>'reason'), '') = '' THEN error_list := array_append(error_list, 'Assertion-Reason needs an assertion and a reason'); END IF;
      IF upper(coalesce(q.correct_answer, '')) NOT IN ('A', 'B', 'C', 'D') THEN error_list := array_append(error_list, 'Assertion-Reason needs a correct answer of A, B, C or D'); END IF;
    WHEN 'numerical' THEN
      IF coalesce(q.answer_data->>'expected_value', '') !~ '^\s*-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?\s*$' THEN error_list := array_append(error_list, 'Numerical needs an expected numeric answer'); END IF;
    WHEN 'fill_blank' THEN
      IF COALESCE(CASE WHEN jsonb_typeof(q.answer_data->'answers') = 'array' THEN jsonb_array_length(q.answer_data->'answers') END, 0) = 0 THEN error_list := array_append(error_list, 'Fill in the Blank needs accepted answers'); END IF;
    WHEN 'programming' THEN
      IF coalesce(trim(q.answer_data->>'language'), '') = '' THEN error_list := array_append(error_list, 'Programming needs a language'); END IF;
    WHEN 'case_study' THEN
      IF length(coalesce(trim(q.answer_data->>'case_text'), '')) < 20 THEN error_list := array_append(error_list, 'Case Study needs the case text'); END IF;
    WHEN 'diagram' THEN
      IF NOT EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = p_question_id) THEN error_list := array_append(error_list, 'Diagram question needs an attached diagram'); END IF;
    ELSE NULL;
  END CASE;

  -- Subtopic (spec §3/§8), when given, must be an active subtopic of the question's topic in its syllabus version.
  IF q.subtopic IS NOT NULL AND trim(q.subtopic) <> '' AND q.syllabus_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM syllabus_subtopics st JOIN syllabus_topics t ON t.id = st.syllabus_topic_id JOIN syllabus_units u ON u.id = t.syllabus_unit_id
     WHERE u.syllabus_version_id = q.syllabus_version_id AND st.is_active AND t.is_active
       AND lower(trim(st.title)) = lower(trim(q.subtopic))
       AND (lower(trim(t.title)) = lower(trim(coalesce(q.topic, ''))) OR t.id = q.verified_topic_id)
  ) THEN
    error_list := array_append(error_list, 'Subtopic is not part of the question''s topic in its syllabus version');
  END IF;

  IF q.model_answer IS NULL OR length(trim(q.model_answer)) < 5 THEN error_list := array_append(error_list, 'Missing or insufficient model answer'); END IF;
  IF q.approved_by IS NULL THEN error_list := array_append(error_list, 'Missing reviewer approval'); END IF;

  -- A pending candidate recorded for this question, or by a question past editing that names it. A candidate
  -- recorded by another author's draft (their preview) is theirs to resolve before they submit (/submit refuses
  -- while it is pending); it does not block this question.
  IF EXISTS (
    SELECT 1 FROM question_relationships r
    WHERE r.status = 'pending' AND r.relationship_type = 'duplicate'
      AND (r.source_question_id = p_question_id
           OR (r.target_question_id = p_question_id AND EXISTS (
                 SELECT 1 FROM questions s WHERE s.id = r.source_question_id
                    AND s.question_status NOT IN ('DRAFT', 'CHANGES_REQUESTED', 'REJECTED'))))
  ) THEN
    error_list := array_append(error_list, 'Unresolved duplicate conflict');
  END IF;

  RETURN QUERY SELECT (array_length(error_list, 1) IS NULL), error_list;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION validate_question_for_active(UUID, TEXT) IS
  'Quality gate for ACTIVE (spec §11). Accepts APPROVED (activate) or RETIRED (restore) as the prior state and re-runs every other check. Returns (valid, errors[]).';

-- ---------------------------------------------------------------------------
-- 9. Legacy status bridge (031 §8), corrected so the legitimate legacy writes only derive legal transitions:
--    - a CHANGES_REQUESTED question written with is_draft = TRUE stays CHANGES_REQUESTED (031 made it DRAFT,
--      which is not a legal transition), and a following 'pending' submit makes it RESUBMITTED;
--    - status 'pending' on an APPROVED question (the pre-038 syllabus re-confirm; academic.js now sets
--      question_status itself, with a reason and an audit row) becomes CHANGES_REQUESTED: the author
--      re-confirms, then it is reviewed again. APPROVED -> UNDER_REVIEW is not in the lifecycle (spec §7);
--    - ACTIVE / RETIRED / REJECTED never move through the legacy columns, and their legacy columns cannot be
--      rewritten either (that is what made an ACTIVE question editable).
--    Every derived change is then checked by trg_question_transition_guard (section 11).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legacy_status_to_question_status()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.question_status IS NULL THEN
      NEW.question_status := CASE
        WHEN NEW.is_draft THEN 'DRAFT'
        WHEN NEW.status IN ('ai_cleared', 'flagged') THEN 'UNDER_REVIEW'
        WHEN NEW.status = 'needs_teacher_fix' THEN 'CHANGES_REQUESTED'
        WHEN NEW.status = 'approved' THEN 'APPROVED'
        WHEN NEW.status IN ('rejected', 'withdrawn_duplicate') THEN 'REJECTED'
        ELSE 'SUBMITTED' END;
    END IF;
    RETURN NEW;
  END IF;

  -- question_status set directly (lifecycle route): nothing to derive.
  IF NEW.question_status IS DISTINCT FROM OLD.question_status THEN
    RETURN NEW;
  END IF;

  IF OLD.question_status IN ('ACTIVE', 'RETIRED', 'REJECTED') THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.is_draft IS DISTINCT FROM OLD.is_draft THEN
      RAISE EXCEPTION 'Invalid question state transition: question is % and its legacy status cannot change (status %, is_draft %)',
        OLD.question_status, NEW.status, NEW.is_draft;
    END IF;
    RETURN NEW;
  END IF;

  NEW.question_status := CASE
    WHEN NEW.is_draft AND OLD.question_status = 'CHANGES_REQUESTED' THEN 'CHANGES_REQUESTED'
    WHEN NEW.is_draft THEN 'DRAFT'
    WHEN NEW.status = 'approved' THEN 'APPROVED'
    WHEN NEW.status IN ('rejected', 'withdrawn_duplicate') THEN 'REJECTED'
    WHEN NEW.status = 'needs_teacher_fix' THEN 'CHANGES_REQUESTED'
    WHEN NEW.status IN ('ai_cleared', 'flagged') THEN 'UNDER_REVIEW'
    WHEN NEW.status = 'pending' THEN
      CASE OLD.question_status
        WHEN 'DRAFT' THEN 'SUBMITTED'
        WHEN 'CHANGES_REQUESTED' THEN 'RESUBMITTED'
        WHEN 'APPROVED' THEN 'CHANGES_REQUESTED'  -- syllabus changed: the author re-confirms it
        ELSE OLD.question_status END
    ELSE OLD.question_status END;

  -- sync_question_status only runs when question_status is SET directly; keep the legacy mirror consistent.
  IF NEW.question_status = 'CHANGES_REQUESTED' AND NOT NEW.is_draft THEN
    NEW.status := 'needs_teacher_fix';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- (trigger trg_a_legacy_status_to_qs from 031 is kept as is; the function is replaced in place)

-- ---------------------------------------------------------------------------
-- 10. Bloom mirrors (031 §9) never touch a question that is in use or closed: a later re-verification of a
--     shared canonical question must not reclassify an ACTIVE question, and must not fail on the content lock.
--     APPROVED questions still follow the reviewer-verified value; the gate checks it at activation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mirror_verified_bloom_to_questions()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.verified_bloom_level IS NOT NULL THEN
    UPDATE questions SET bloom_level = NEW.verified_bloom_level
    WHERE canonical_question_id = NEW.id AND bloom_level IS DISTINCT FROM NEW.verified_bloom_level
      AND question_status NOT IN ('ACTIVE', 'RETIRED', 'REJECTED');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bloom_on_canonical_link()
RETURNS TRIGGER AS $$
BEGIN
  -- A withdrawn duplicate (REJECTED) is linked to the existing canonical question; its Bloom level is irrelevant.
  IF TG_OP = 'UPDATE' AND OLD.question_status IN ('ACTIVE', 'RETIRED', 'REJECTED') THEN
    RETURN NEW;
  END IF;
  IF NEW.canonical_question_id IS NOT NULL THEN
    SELECT COALESCE(verified_bloom_level, NEW.bloom_level) INTO NEW.bloom_level
    FROM canonical_questions WHERE id = NEW.canonical_question_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 11. Transition guard: every question_status change, whether set directly or derived by the bridge.
--     AFTER, without a column list: it sees the final row whatever BEFORE trigger produced the change.
--     No runtime override: a data-repair migration that must move states disables the trigger inside its
--     own transaction (needs owner rights and is visible in the migration file).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_validate_question_state_transition ON questions;
DROP FUNCTION IF EXISTS validate_question_state_transition();

CREATE OR REPLACE FUNCTION guard_question_state_transition()
RETURNS TRIGGER AS $$
DECLARE
  v_allowed TEXT[];
  v_gate RECORD;
BEGIN
  v_allowed := CASE OLD.question_status
    WHEN 'DRAFT'             THEN ARRAY['SUBMITTED']
    WHEN 'SUBMITTED'         THEN ARRAY['UNDER_REVIEW', 'DRAFT']
    WHEN 'UNDER_REVIEW'      THEN ARRAY['CHANGES_REQUESTED', 'APPROVED', 'REJECTED']
    WHEN 'CHANGES_REQUESTED' THEN ARRAY['RESUBMITTED']  -- revised and reviewed again; rejected only from review
    WHEN 'RESUBMITTED'       THEN ARRAY['UNDER_REVIEW']
    WHEN 'APPROVED'          THEN ARRAY['ACTIVE', 'CHANGES_REQUESTED']
    WHEN 'ACTIVE'            THEN ARRAY['RETIRED', 'CHANGES_REQUESTED']
    WHEN 'RETIRED'           THEN ARRAY['ACTIVE']
    ELSE ARRAY[]::TEXT[]  -- REJECTED is terminal
  END;

  -- 'Use existing question' (duplicate resolution): the author withdraws their own draft as a duplicate.
  IF OLD.question_status = 'DRAFT' AND NEW.question_status = 'REJECTED' AND NEW.status = 'withdrawn_duplicate' THEN
    RETURN NULL;
  END IF;

  IF NOT (NEW.question_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'Invalid question state transition: % → %', OLD.question_status, NEW.question_status;
  END IF;

  -- Leaving review is the reviewers' decision on the question's open review round (brain.md §8), recorded on
  -- that round in this same transaction by POST /questions/:id/transition.
  IF OLD.question_status = 'UNDER_REVIEW' AND NOT EXISTS (
    SELECT 1 FROM review_batch_items rbi
     WHERE rbi.question_id = NEW.id AND rbi.outcome = NEW.question_status AND rbi.decided_at = now()
  ) THEN
    RAISE EXCEPTION 'Review decision required: % -> % must be applied from the question''s review batch',
      OLD.question_status, NEW.question_status;
  END IF;

  IF NEW.question_status = 'APPROVED' THEN
    -- Spec §2/§12: only a reviewer approves, never the author.
    IF NEW.approved_by IS NULL OR NEW.approved_by = NEW.submitted_by OR NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id = NEW.approved_by AND u.role = 'reviewer' AND u.is_active
    ) THEN
      RAISE EXCEPTION 'Approval must be recorded by an active reviewer who is not the author (question %)', NEW.id;
    END IF;
  ELSIF NEW.question_status = 'RETIRED' THEN
    -- Spec §18.
    IF NEW.retired_by IS NULL OR NEW.retired_at IS NULL OR coalesce(trim(NEW.retirement_reason), '') = '' THEN
      RAISE EXCEPTION 'Retirement requires retired_by, retired_at and retirement_reason (question %)', NEW.id;
    END IF;
  ELSIF NEW.question_status = 'ACTIVE' THEN
    -- Re-run the gate on the stored final row (the BEFORE gate in 027 reads the row as it was).
    SELECT * INTO v_gate FROM validate_question_for_active(NEW.id, OLD.question_status);
    IF NOT v_gate.valid THEN
      RAISE EXCEPTION 'Quality gate failed: %', array_to_string(v_gate.errors, '; ');
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_question_transition_guard ON questions;
CREATE TRIGGER trg_question_transition_guard
  AFTER UPDATE ON questions
  FOR EACH ROW
  WHEN (OLD.question_status IS DISTINCT FROM NEW.question_status)
  EXECUTE FUNCTION guard_question_state_transition();

-- ---------------------------------------------------------------------------
-- 12. Content lock. An APPROVED / ACTIVE / RETIRED / REJECTED question's content and academic context never
--     change in place: changes go through CHANGES_REQUESTED (and a new version, spec §14).
--     bloom_level may still follow the reviewer-verified value while APPROVED (section 10).
--     canonical_question_id may change on a REJECTED row (a withdrawn duplicate is linked to the existing question).
--     Not locked (written legitimately after approval): embedding, times_used / last_used_at, AI findings,
--     status / is_draft (owned by the bridge), rejection_reason, lifecycle stamps, change_request_*.
--     Escape hatch for data-repair migrations only (no route sets it):
--       SELECT set_config('app.question_content_override', 'on', true);
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION protect_locked_question_content()
RETURNS TRIGGER AS $$
DECLARE
  v_cols TEXT[] := ARRAY['question_type', 'question_text', 'option_a', 'option_b', 'option_c', 'option_d',
                         'correct_answer', 'model_answer', 'answer_data', 'marks', 'difficulty', 'topic', 'subtopic',
                         'submitted_bloom_level', 'submitted_cos', 'question_hash', 'course_offering_id', 'subject_id',
                         'section_id', 'campus_id', 'syllabus_version_id', 'submitted_by', 'approved_by', 'approved_at'];
  v_old JSONB := to_jsonb(OLD);
  v_new JSONB := to_jsonb(NEW);
  v_changed TEXT[];
BEGIN
  IF COALESCE(current_setting('app.question_content_override', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF OLD.question_status <> 'APPROVED' THEN
    v_cols := array_append(v_cols, 'bloom_level');
  END IF;
  IF OLD.question_status <> 'REJECTED' THEN
    v_cols := array_append(v_cols, 'canonical_question_id');
  END IF;

  SELECT array_agg(c ORDER BY c) INTO v_changed
    FROM unnest(v_cols) AS c
   WHERE v_old -> c IS DISTINCT FROM v_new -> c;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'Question content is locked while the question is % (changed: %); request changes to revise it',
      OLD.question_status, array_to_string(v_changed, ', ');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_question_content_lock ON questions;
CREATE TRIGGER trg_question_content_lock
  AFTER UPDATE ON questions
  FOR EACH ROW
  WHEN (OLD.question_status IN ('APPROVED', 'ACTIVE', 'RETIRED', 'REJECTED'))
  EXECUTE FUNCTION protect_locked_question_content();

-- ---------------------------------------------------------------------------
-- 13. Attachments are question content (the diagram gate counts them): they can be added, moved or removed
--     only while the author may edit the question (DRAFT / CHANGES_REQUESTED), the same rule as
--     src/routes/attachments.js. scan_status / file_path updates are not guarded (the upload route records the
--     stored file name after the insert, and a rescan must be able to record its verdict). A parent that is
--     already gone (ON DELETE CASCADE) is allowed. Same data-repair hatch as section 12.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_question_attachments()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF COALESCE(current_setting('app.question_content_override', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Moving a file to another question: the question it leaves must be editable too.
    SELECT question_status INTO v_status FROM questions WHERE id = OLD.question_id;
    IF FOUND AND v_status NOT IN ('DRAFT', 'CHANGES_REQUESTED') THEN
      RAISE EXCEPTION 'Question attachments can only change while the question is DRAFT or CHANGES_REQUESTED (it is %)', v_status;
    END IF;
  END IF;
  SELECT question_status INTO v_status FROM questions
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.question_id ELSE NEW.question_id END;
  IF FOUND AND v_status NOT IN ('DRAFT', 'CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'Question attachments can only change while the question is DRAFT or CHANGES_REQUESTED (it is %)', v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_question_attachments ON question_attachments;
CREATE TRIGGER trg_guard_question_attachments
  BEFORE INSERT OR DELETE OR UPDATE OF question_id ON question_attachments
  FOR EACH ROW EXECUTE FUNCTION guard_question_attachments();

COMMENT ON TRIGGER trg_question_transition_guard ON questions IS
  'Question state machine (spec §7) for every question_status change, direct or derived by the legacy bridge; review decisions from the review round (brain §8); approval by a reviewer (§2, §12); retirement fields (§18); gate on ACTIVE (§11).';
COMMENT ON TRIGGER trg_question_content_lock ON questions IS
  'APPROVED/ACTIVE/RETIRED/REJECTED content is never edited in place (spec §14). Override: app.question_content_override (data repair only).';
