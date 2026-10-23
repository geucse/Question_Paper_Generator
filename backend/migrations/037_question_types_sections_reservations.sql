-- 037: examination features from exam-portal-v4-complete-implementation-prompt.md
--   * 13 question types (spec §8) with type-specific data and activation rules (spec §10)
--   * syllabus subtopics (spec §3, §8)
--   * paper sections (blueprint section rules, persisted on each paper question)
--   * hard CO/Bloom targets with recorded COE overrides
--   * question reservations: concurrent generations can't pick the same questions (spec §15 RESERVED)
--   * optional validator-independence policy: validator ≠ reviewer of a question in the paper (spec §27)
-- Forward-only and idempotent. Existing data is mapped, never dropped.

-- ---------------------------------------------------------------------------
-- 1. Question types
-- ---------------------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conrelid::regclass AS tbl, con.conname FROM pg_constraint con
    WHERE con.conrelid IN ('questions'::regclass, 'canonical_questions'::regclass) AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%question_type%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

-- Pre-pivot values: objective (multiple choice) -> mcq, subjective -> descriptive.
-- Paper snapshots are NOT touched: printed papers keep exactly what was validated.
UPDATE questions SET question_type = 'mcq' WHERE question_type = 'objective';
UPDATE questions SET question_type = 'descriptive' WHERE question_type = 'subjective';
UPDATE canonical_questions SET question_type = 'mcq' WHERE question_type = 'objective';
UPDATE canonical_questions SET question_type = 'descriptive' WHERE question_type = 'subjective';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'question_versions' AND column_name = 'question_type') THEN
    UPDATE question_versions SET question_type = 'mcq' WHERE question_type = 'objective';
    UPDATE question_versions SET question_type = 'descriptive' WHERE question_type = 'subjective';
  END IF;
END $$;

ALTER TABLE questions ALTER COLUMN question_type SET DEFAULT 'mcq';
ALTER TABLE questions ADD CONSTRAINT questions_question_type_check CHECK (question_type IN (
  'mcq','short_answer','long_answer','numerical','derivation','proof','programming',
  'case_study','diagram','assertion_reason','fill_blank','true_false','descriptive'));
ALTER TABLE canonical_questions ADD CONSTRAINT canonical_questions_question_type_check CHECK (question_type IN (
  'mcq','short_answer','long_answer','numerical','derivation','proof','programming',
  'case_study','diagram','assertion_reason','fill_blank','true_false','descriptive'));

-- Type-specific answer/marking data, e.g. {"expected_value": 11, "tolerance": 0.5, "unit": "m/s"},
-- {"answers": ["LIFO"]}, {"language": "Python"}, {"case_text": "..."}, {"assertion": "...", "reason": "..."}.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS answer_data JSONB;
DO $$ BEGIN
  ALTER TABLE questions ADD CONSTRAINT questions_answer_data_object CHECK (answer_data IS NULL OR jsonb_typeof(answer_data) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. Subtopics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS syllabus_subtopics (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  syllabus_topic_id UUID NOT NULL REFERENCES syllabus_topics(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (length(trim(title)) > 0),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_syllabus_subtopics_title ON syllabus_subtopics (syllabus_topic_id, lower(title));
ALTER TABLE questions ADD COLUMN IF NOT EXISTS subtopic TEXT;

-- ---------------------------------------------------------------------------
-- 3. Quality gate with type-specific and subtopic rules
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_question_for_active(p_question_id UUID)
RETURNS TABLE(valid BOOLEAN, errors TEXT[]) AS $$
DECLARE
  q RECORD;
  error_list TEXT[] := ARRAY[]::TEXT[];
  v_topic_ok BOOLEAN := FALSE;
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

  IF q.question_status != 'APPROVED' THEN error_list := array_append(error_list, 'Question must be APPROVED before ACTIVE'); END IF;
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

  IF EXISTS (
    SELECT 1 FROM question_relationships r
    WHERE r.status = 'pending' AND r.relationship_type = 'duplicate'
      AND (r.source_question_id = p_question_id OR r.target_question_id = p_question_id)
  ) THEN
    error_list := array_append(error_list, 'Unresolved duplicate conflict');
  END IF;

  RETURN QUERY SELECT (array_length(error_list, 1) IS NULL), error_list;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- 4. Snapshots also carry type-specific data and subtopic (needed to print/mark every type)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_paper_question_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  q RECORD;
BEGIN
  SELECT qs.question_text, qs.marks, qs.option_a, qs.option_b, qs.option_c, qs.option_d,
         qs.correct_answer, qs.model_answer, qs.difficulty, qs.bloom_level, qs.topic, qs.question_type,
         qs.canonical_question_id, cq.current_version_id, qs.answer_data, qs.subtopic
    INTO q
    FROM questions qs
    LEFT JOIN canonical_questions cq ON cq.id = qs.canonical_question_id
   WHERE qs.id = NEW.question_id;

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
    'snapshot_at', now()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 5. Sections and hard targets
-- ---------------------------------------------------------------------------
-- sections: [{"name": "Section A", "question_count": 5, "marks_per_question": 2, "total_marks": 10,
--             "question_types": ["mcq"], "easy": 3, "medium": 2, "hard": 0, "instructions": "..."}]
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS sections JSONB;
-- co_distribution / bloom_distribution become HARD targets for blueprints with hard_targets = TRUE
-- (every blueprint created from now on). Older blueprints keep their soft behaviour.
ALTER TABLE paper_blueprints ADD COLUMN IF NOT EXISTS hard_targets BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE paper_questions ADD COLUMN IF NOT EXISTS section_name TEXT;
ALTER TABLE paper_questions ADD COLUMN IF NOT EXISTS section_index INTEGER;
-- A COE may relax hard CO/Bloom targets for one generation only with a reason; recorded on the paper and audited.
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS constraint_overrides JSONB;

-- ---------------------------------------------------------------------------
-- 6. Reservations (spec §15): a question in an in-flight paper can't be picked by another examination.
--    The partial unique index makes this hold even under concurrent generation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_reservations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id    UUID NOT NULL REFERENCES questions(id),
  paper_id       UUID NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  examination_id UUID NOT NULL REFERENCES examinations(id),
  reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at    TIMESTAMPTZ,
  release_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_question_reservation_active
  ON question_reservations (question_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_question_reservations_paper ON question_reservations (paper_id);

-- Released when the paper leaves the in-flight window: printed (usage is recorded instead),
-- superseded by a new revision, or archived.
CREATE OR REPLACE FUNCTION release_question_reservations()
RETURNS TRIGGER AS $$
DECLARE
  rec RECORD;
  v_alt UUID;
BEGIN
  IF NEW.paper_status IN ('PRINT_READY', 'REGENERATED', 'ARCHIVED') AND NEW.paper_status IS DISTINCT FROM OLD.paper_status THEN
    FOR rec IN SELECT id, question_id FROM question_reservations WHERE paper_id = NEW.id AND released_at IS NULL LOOP
      -- Another in-flight paper of the same examination still uses the question: it keeps the reservation.
      SELECT ep.id INTO v_alt
        FROM exam_papers ep JOIN paper_questions pq ON pq.paper_id = ep.id
       WHERE ep.examination_id = NEW.examination_id AND ep.id <> NEW.id AND pq.question_id = rec.question_id
         AND ep.paper_status IN ('GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED', 'COE_APPROVED')
       ORDER BY ep.generated_at DESC LIMIT 1;
      IF v_alt IS NOT NULL THEN
        UPDATE question_reservations SET paper_id = v_alt WHERE id = rec.id;
      ELSE
        UPDATE question_reservations SET released_at = now(), release_reason = 'paper ' || NEW.paper_status WHERE id = rec.id;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_release_question_reservations ON exam_papers;
CREATE TRIGGER trg_release_question_reservations
  AFTER UPDATE OF paper_status ON exam_papers
  FOR EACH ROW EXECUTE FUNCTION release_question_reservations();

-- Existing in-flight papers reserve their questions (first paper wins if two already share one).
INSERT INTO question_reservations (question_id, paper_id, examination_id)
SELECT DISTINCT ON (pq.question_id) pq.question_id, ep.id, ep.examination_id
FROM paper_questions pq JOIN exam_papers ep ON ep.id = pq.paper_id
WHERE ep.examination_id IS NOT NULL
  AND ep.paper_status IN ('GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED', 'COE_APPROVED')
  AND NOT EXISTS (SELECT 1 FROM question_reservations r WHERE r.question_id = pq.question_id AND r.released_at IS NULL)
ORDER BY pq.question_id, ep.generated_at;

-- ---------------------------------------------------------------------------
-- 7. Validator independence policy (spec §27 "optionally also block validator = reviewer")
-- ---------------------------------------------------------------------------
INSERT INTO system_state (key, value, updated_at)
VALUES ('validator_excludes_question_reviewers', 'false', now())
ON CONFLICT (key) DO NOTHING;
