-- 041: phase 4a, UI and PDF (implementation prompt §3 question types in output, §5 printable paper).
--
-- Forward-only and idempotent (CREATE OR REPLACE only; nothing existing is rewritten).
--
--   A. Paper question snapshots also record the question's clean attachments (id, file name, type, hash) at
--      generation, so the paper views and the PDF show exactly the diagrams the paper was generated with. Snapshots
--      made before 041 have no such list; the application then refers only to files that already existed when the
--      paper was generated (src/paper-attachments.js) and never changes the old snapshot.
--   B. Quality gate: a diagram question needs a clean PNG or JPEG image (the PDF writer, pdfkit, embeds only those).
--      The upload route refuses other formats for diagram questions with the same message. Questions that are
--      already ACTIVE are not touched; a NOTICE reports any diagram question whose only diagrams are not printable.

-- ---------------------------------------------------------------------------------------------------------------
-- A. Snapshot with attachments (same columns as 037 section 4, plus 'attachments')
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_paper_question_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  q RECORD;
  v_attachments JSONB;
BEGIN
  SELECT qs.question_text, qs.marks, qs.option_a, qs.option_b, qs.option_c, qs.option_d,
         qs.correct_answer, qs.model_answer, qs.difficulty, qs.bloom_level, qs.topic, qs.question_type,
         qs.canonical_question_id, cq.current_version_id, qs.answer_data, qs.subtopic
    INTO q
    FROM questions qs
    LEFT JOIN canonical_questions cq ON cq.id = qs.canonical_question_id
   WHERE qs.id = NEW.question_id;

  -- Only files that passed the virus scan (the generator never picks a question with any other file).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'file_type', a.file_type, 'file_hash', a.file_hash)
                            ORDER BY a.created_at, a.id), '[]'::jsonb)
    INTO v_attachments
    FROM question_attachments a
   WHERE a.question_id = NEW.question_id AND a.scan_status = 'clean';

  NEW.question_text_snapshot := q.question_text;
  NEW.marks_snapshot := q.marks;
  NEW.question_version_id := q.current_version_id;
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
    'canonical_question_id', q.canonical_question_id,
    'answer_data', q.answer_data,
    'subtopic', q.subtopic,
    'attachments', v_attachments,
    'snapshot_at', now()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------------------------
-- B. Quality gate (040 section E3, unchanged except the diagram rule)
-- ---------------------------------------------------------------------------------------------------------------
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
      IF NOT EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = p_question_id AND a.scan_status = 'clean') THEN
        error_list := array_append(error_list, 'Diagram question needs a clean attached diagram');
      -- 041: the printed paper embeds the diagram, and the PDF writer can only embed PNG and JPEG images.
      ELSIF NOT EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = p_question_id AND a.scan_status = 'clean'
                          AND a.file_type IN ('image/png', 'image/jpeg')) THEN
        error_list := array_append(error_list, 'Diagram question needs its diagram as a PNG or JPEG image (the printed paper can only embed those)');
      END IF;
    ELSE NULL;
  END CASE;

  -- 040: every attachment must have passed the virus scan.
  IF EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = p_question_id AND a.scan_status <> 'clean') THEN
    error_list := array_append(error_list, 'Attachment has not passed the virus scan');
  END IF;

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
  'Quality gate for ACTIVE (spec §11). Accepts APPROVED (activate) or RETIRED (restore) as the prior state and re-runs every other check, including clean attachments (040) and a printable PNG/JPEG diagram (041). Returns (valid, errors[]).';

-- E4. Submission (direct or derived by the legacy bridge) needs every attachment scanned clean. AFTER, so it also

DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM questions q
   WHERE q.question_type = 'diagram' AND q.question_status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = q.id AND a.scan_status = 'clean'
                       AND a.file_type IN ('image/png', 'image/jpeg'));
  IF n > 0 THEN
    RAISE NOTICE '041: % ACTIVE diagram question(s) have no clean PNG/JPEG diagram; they stay ACTIVE, but their printed papers name the file instead of embedding it until a reviewer sends them back for a PNG/JPEG copy', n;
  END IF;
END $$;
