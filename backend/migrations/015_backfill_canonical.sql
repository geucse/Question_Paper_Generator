-- ---------------------------------------------------------------------
-- Safe, additive backfill: every pre-existing `questions` row (submitted
-- before the canonical-question split existed) gets its own 1:1 canonical
-- question, version 1, and (if it had one) a canonical answer — wired up
-- exactly like a brand-new submission would be from this point forward.
--
-- Nothing in `questions` is modified except setting the new
-- canonical_question_id link. No row is deleted. This block only touches
-- rows where canonical_question_id IS NULL, so it is safe to re-run (e.g.
-- if migrate.js is ever re-invoked against a database that already has
-- some canonical rows) — already-linked rows are simply skipped.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  q RECORD;
  cq_id UUID;
  qv_id UUID;
  cq_workflow_status TEXT;
  cq_quality_status TEXT;
BEGIN
  FOR q IN SELECT * FROM questions WHERE canonical_question_id IS NULL LOOP

    cq_quality_status := CASE
      WHEN q.status IN ('approved','ai_cleared') THEN 'ai_cleared'
      WHEN q.status = 'flagged' THEN 'flagged'
      ELSE 'pending'
    END;

    cq_workflow_status := CASE q.status
      WHEN 'pending' THEN 'submitted'
      WHEN 'ai_cleared' THEN 'ai_review'
      WHEN 'needs_teacher_fix' THEN 'needs_teacher_revision'
      WHEN 'approved' THEN 'approved'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'flagged' THEN 'reviewer_review'
      WHEN 'withdrawn_duplicate' THEN 'retired'
      ELSE 'submitted'
    END;

    INSERT INTO canonical_questions
      (subject_id, canonical_text, normalized_text, question_type, question_hash,
       quality_status, workflow_status, applicability_status, embedding, created_at, updated_at)
    VALUES
      (q.subject_id, q.question_text, lower(regexp_replace(q.question_text, '\s+', ' ', 'g')),
       q.question_type, q.question_hash, cq_quality_status, cq_workflow_status, 'active',
       q.embedding, q.created_at, now())
    RETURNING id INTO cq_id;

    INSERT INTO question_versions
      (canonical_question_id, version_number, question_text, question_type, marks,
       option_a, option_b, option_c, option_d, correct_answer, created_by, change_reason, is_current, created_at)
    VALUES
      (cq_id, 1, q.question_text, q.question_type, q.marks,
       q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.submitted_by,
       'Initial migration from legacy flat question record (pre-canonical-architecture)', TRUE, q.created_at)
    RETURNING id INTO qv_id;

    UPDATE canonical_questions SET current_version_id = qv_id WHERE id = cq_id;

    IF q.model_answer IS NOT NULL AND length(trim(q.model_answer)) > 0 THEN
      INSERT INTO canonical_answers
        (canonical_question_id, version_number, answer_text, created_by, status, is_current, created_at)
      VALUES
        (cq_id, 1, q.model_answer, q.submitted_by, 'draft', TRUE, q.created_at);
    END IF;

    INSERT INTO question_canonicalization_events
      (canonical_question_id, submission_id, action, reason, performed_by, created_at)
    VALUES
      (cq_id, q.id, 'created_canonical',
       'Backfilled during canonical-architecture migration — pre-existing flat question record', NULL, now());

    UPDATE questions SET canonical_question_id = cq_id WHERE id = q.id;

  END LOOP;
END $$;
