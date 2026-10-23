-- 040: phase 3 security scoping (PIVOT_SPEC_V2 §2-§4, §28, §39; implementation prompt §2, §4, §5 criterion 6).
--
-- Forward-only and idempotent: every step checks before it changes anything, so running the file again (or on a
-- database that already carries some of it) is a no-op. Existing data is never rewritten, except the one-time
-- snapshot reconstruction of pre-029 legacy papers in section C, which is flagged on every row it touches.
--
--   A. A section belongs to exactly one course offering: teacher assignments and questions may only reference a
--      section of their OWN offering (composite foreign keys; the routes refuse it too with a clear 400/403).
--   B. Scope backfill. Phase 3 authorizes every academic route through user_scopes (never users.department_id),
--      so active HODs, reviewers and teachers get the scope the application should already have granted them.
--      A scope an admin explicitly revoked (an identical inactive row exists) is never resurrected.
--   C. Legacy papers created before migration 029 have no question snapshots; /api/papers now renders only from
--      snapshots, so they are rebuilt ONCE from the current question row and flagged (reconstructed = true).
--   D. Accounts and authentication: TOTP secrets sealed at rest (plaintext ones are revoked, users re-enrol),
--      replay protection and pending enrolment, step_up_auth_log per user, scope grant/revoke history, one active
--      scope per shape, deactivation/role change revoke scopes and sessions (DB backstop), case-insensitive email.
--   E. Infrastructure: virus-scan bookkeeping and quarantine rules for attachments; only clean attachments pass the
--      quality gate or a submission (with the attachment guard serialised against a concurrent submit).
--   F. Review follow-ups: HOD scopes are department-level (a program-limited one would silently cover the whole
--      department), automatic IP blocks expire, and HODs left without any scope are reported.

-- ---------------------------------------------------------------------------------------------------------------
-- A. Section-to-offering integrity
-- ---------------------------------------------------------------------------------------------------------------
-- NOT VALID: every new or changed row is checked at once; existing rows are validated only when none violates
-- the rule (otherwise a NOTICE reports how many do, for a human to fix; nothing is rewritten silently).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sections_id_offering_key') THEN
    ALTER TABLE sections ADD CONSTRAINT sections_id_offering_key UNIQUE (id, course_offering_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tca_section_same_offering_fk') THEN
    ALTER TABLE teacher_course_assignments ADD CONSTRAINT tca_section_same_offering_fk
      FOREIGN KEY (section_id, course_offering_id) REFERENCES sections (id, course_offering_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_section_same_offering_fk') THEN
    ALTER TABLE questions ADD CONSTRAINT questions_section_same_offering_fk
      FOREIGN KEY (section_id, course_offering_id) REFERENCES sections (id, course_offering_id) NOT VALID;
  END IF;
END $$;

DO $$
DECLARE n INT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tca_section_same_offering_fk' AND NOT convalidated) THEN
    SELECT COUNT(*) INTO n FROM teacher_course_assignments t
     WHERE t.section_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sections s WHERE s.id = t.section_id AND s.course_offering_id = t.course_offering_id);
    IF n = 0 THEN
      ALTER TABLE teacher_course_assignments VALIDATE CONSTRAINT tca_section_same_offering_fk;
    ELSE
      RAISE NOTICE '040: % teacher assignment(s) reference a section of another course offering; tca_section_same_offering_fk left NOT VALID (new rows are checked)', n;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_section_same_offering_fk' AND NOT convalidated) THEN
    SELECT COUNT(*) INTO n FROM questions q
     WHERE q.section_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sections s WHERE s.id = q.section_id AND s.course_offering_id = q.course_offering_id);
    IF n = 0 THEN
      ALTER TABLE questions VALIDATE CONSTRAINT questions_section_same_offering_fk;
    ELSE
      RAISE NOTICE '040: % question(s) reference a section of another course offering; questions_section_same_offering_fk left NOT VALID (new rows are checked)', n;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- B. Scope backfill (the scopes scopes.js grantScope would have created)
-- ---------------------------------------------------------------------------------------------------------------
-- HOD: (campus, department) of the HOD's home department, when the HOD holds no active hod scope at all.
-- Accounts created through POST /api/academic/users before phase 3 got none.
INSERT INTO user_scopes (user_id, role, campus_id, department_id)
SELECT u.id, 'hod', d.campus_id, d.id
  FROM users u JOIN departments d ON d.id = u.department_id
 WHERE u.role = 'hod' AND u.is_active AND d.campus_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = u.id AND s.role = 'hod' AND s.is_active)
   AND NOT EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = u.id AND s.role = 'hod' AND NOT s.is_active
                     AND s.campus_id = d.campus_id AND s.department_id = d.id
                     AND s.program_id IS NULL AND s.course_offering_id IS NULL);

-- Reviewer: (campus, department, program) of every active reviewer assignment not yet covered.
INSERT INTO user_scopes (user_id, role, campus_id, department_id, program_id)
SELECT DISTINCT ra.reviewer_id, 'reviewer', co.campus_id, p.department_id, co.program_id
  FROM reviewer_assignments ra
  JOIN course_offerings co ON co.id = ra.course_offering_id
  JOIN programs p ON p.id = co.program_id
  JOIN users u ON u.id = ra.reviewer_id AND u.is_active AND u.role = 'reviewer'
 WHERE ra.is_active AND co.campus_id IS NOT NULL
   AND NOT user_has_scope(ra.reviewer_id, 'reviewer', co.campus_id, p.department_id, co.program_id, NULL)
   AND NOT EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = ra.reviewer_id AND s.role = 'reviewer' AND NOT s.is_active
                     AND s.campus_id = co.campus_id AND s.department_id = p.department_id
                     AND s.program_id = co.program_id AND s.course_offering_id IS NULL);

-- Teacher: (campus, department, program, offering) of every active teacher assignment not yet covered. These rows
-- have no NULL level, so the table's UNIQUE constraint also covers revoked rows: the NOT EXISTS keeps the insert
-- from colliding with (and from resurrecting) a revoked one.
INSERT INTO user_scopes (user_id, role, campus_id, department_id, program_id, course_offering_id)
SELECT DISTINCT t.teacher_id, 'teacher', co.campus_id, p.department_id, co.program_id, co.id
  FROM teacher_course_assignments t
  JOIN course_offerings co ON co.id = t.course_offering_id
  JOIN programs p ON p.id = co.program_id
  JOIN users u ON u.id = t.teacher_id AND u.is_active AND u.role = 'teacher'
 WHERE t.is_active AND co.campus_id IS NOT NULL
   AND NOT user_has_scope(t.teacher_id, 'teacher', co.campus_id, p.department_id, co.program_id, co.id)
   AND NOT EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = t.teacher_id AND s.role = 'teacher'
                     AND s.campus_id = co.campus_id AND s.department_id = p.department_id
                     AND s.program_id = co.program_id AND s.course_offering_id = co.id);

DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM teacher_course_assignments t
    JOIN course_offerings co ON co.id = t.course_offering_id JOIN programs p ON p.id = co.program_id
    JOIN users u ON u.id = t.teacher_id AND u.is_active
   WHERE t.is_active AND NOT user_has_scope(t.teacher_id, 'teacher', co.campus_id, p.department_id, co.program_id, co.id);
  IF n > 0 THEN
    RAISE NOTICE '040: % active teacher assignment(s) have no active teacher scope because an admin revoked it; re-grant through /api/admin/scopes or end the assignment', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- C. Legacy paper snapshots (papers created before migration 029)
-- ---------------------------------------------------------------------------------------------------------------
-- Rebuilt once from the current question row (the same fields as the snapshot trigger, 037) and flagged, so the
-- API and the PDF say so instead of silently showing live data. From now on the rendered paper never changes.
-- Rows whose question no longer exists stay NULL and render as "[question text not recorded]".
-- The 036 lock trigger refuses any write to questions of a non-DRAFT paper, so it is disabled for this one
-- statement only; the migration runner wraps the file in one transaction, so a failure re-enables it as well.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM paper_questions pq JOIN questions q ON q.id = pq.question_id WHERE pq.question_text_snapshot IS NULL) THEN
    ALTER TABLE paper_questions DISABLE TRIGGER trg_protect_locked_paper_questions;
    UPDATE paper_questions pq
       SET question_text_snapshot = q.question_text,
           marks_snapshot = q.marks,
           question_version_id = COALESCE(pq.question_version_id, cq.current_version_id),
           metadata_snapshot = jsonb_build_object(
             'question_type', q.question_type, 'difficulty', q.difficulty, 'bloom_level', q.bloom_level, 'topic', q.topic,
             'option_a', q.option_a, 'option_b', q.option_b, 'option_c', q.option_c, 'option_d', q.option_d,
             'correct_answer', q.correct_answer, 'model_answer', q.model_answer,
             'canonical_question_id', q.canonical_question_id, 'answer_data', q.answer_data, 'subtopic', q.subtopic,
             'snapshot_at', now(), 'reconstructed', true, 'reconstructed_at', now(), 'reconstructed_by', '040')
      FROM questions q LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id
     WHERE q.id = pq.question_id AND pq.question_text_snapshot IS NULL;
    ALTER TABLE paper_questions ENABLE TRIGGER trg_protect_locked_paper_questions;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- D. Accounts and authentication (implementation prompt §2 security; PIVOT_SPEC_V2 §4, §5, §35, §37)
-- ---------------------------------------------------------------------------------------------------------------
-- D1. New user columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_used_step BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enrolled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_reenroll_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES users(id);
COMMENT ON COLUMN users.totp_secret IS 'Authenticator secret sealed with AES-256-GCM (src/secret-box.js, v1.<iv>.<tag>.<ct>, AAD totp:<user id>); never plaintext';
COMMENT ON COLUMN users.totp_last_used_step IS '30-second TOTP step of the last accepted code; a code of the same or an earlier step is a replay';
COMMENT ON COLUMN users.totp_pending_secret IS 'Sealed secret of an enrolment that is not confirmed yet; the active secret keeps working until it is';
COMMENT ON COLUMN users.totp_reenroll_required IS 'TRUE when 040 revoked a plaintext authenticator secret: the user must enrol again';

-- D2. A secret that sat in plaintext must be treated as exposed, and the encryption key is not available to SQL
--     (passing it through the session could reach the server logs), so plaintext secrets are revoked instead of
--     encrypted in place. Each affected user is notified once (a second run finds nothing to revoke).
WITH revoked AS (
  UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_reenroll_required = TRUE, totp_last_used_step = NULL
   WHERE totp_secret IS NOT NULL AND totp_secret !~ '^v1\.'
  RETURNING id
)
INSERT INTO notifications (user_id, type, message)
SELECT id, 'security_totp_reenroll', 'Your authenticator was reset during a security upgrade. Set it up again (Authenticator tab) before your next approval.'
  FROM revoked;
UPDATE users SET totp_pending_secret = NULL, totp_pending_expires_at = NULL
 WHERE totp_pending_secret IS NOT NULL AND totp_pending_secret !~ '^v1\.';
UPDATE users SET totp_enabled = FALSE WHERE totp_enabled AND totp_secret IS NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_totp_secret_sealed;
ALTER TABLE users ADD CONSTRAINT users_totp_secret_sealed CHECK (
  (totp_secret IS NULL OR totp_secret ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$')
  AND (totp_pending_secret IS NULL OR totp_pending_secret ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_totp_enabled_has_secret;
ALTER TABLE users ADD CONSTRAINT users_totp_enabled_has_secret CHECK (NOT totp_enabled OR totp_secret IS NOT NULL);

-- D3. Step-up log per user (it only had hod_id/admin_id from the retired approval flow).
ALTER TABLE step_up_auth_log ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE step_up_auth_log ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'totp';
ALTER TABLE step_up_auth_log ADD COLUMN IF NOT EXISTS failure_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_step_up_user_time ON step_up_auth_log (user_id, created_at DESC);

-- D4. Scope history: who granted or revoked, when and why. Exactly one ACTIVE scope per shape (NULL levels
--     included, which the old table-level UNIQUE never de-duplicated); revoked rows stay as history and no longer
--     block an identical re-grant.
ALTER TABLE user_scopes ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES users(id);
ALTER TABLE user_scopes ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE user_scopes ADD COLUMN IF NOT EXISTS revoked_by UUID REFERENCES users(id);
ALTER TABLE user_scopes ADD COLUMN IF NOT EXISTS revoke_reason TEXT;

WITH ranked AS (
  SELECT id, row_number() OVER (
           PARTITION BY user_id, role,
             COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
             COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(course_offering_id, '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY created_at, id) AS rn
    FROM user_scopes WHERE is_active
)
UPDATE user_scopes s SET is_active = FALSE, revoked_at = now(), revoke_reason = 'duplicate (040)', updated_at = now()
  FROM ranked r WHERE s.id = r.id AND r.rn > 1;

DO $$
DECLARE c RECORD;
BEGIN
  -- The 024 UNIQUE constraint has an auto-generated (truncated) name: find it by its column set.
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = 'user_scopes'::regclass AND con.contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a
             WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey))
           = ARRAY['campus_id', 'course_offering_id', 'department_id', 'program_id', 'role', 'user_id']
  LOOP
    EXECUTE format('ALTER TABLE user_scopes DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_scopes_active ON user_scopes (
  user_id, role,
  COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(course_offering_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;

-- Inactive users and scopes of another role than the user's never authorize anything.
DO $$
DECLARE n_inactive INT; n_role INT;
BEGIN
  WITH r AS (
    UPDATE user_scopes s SET is_active = FALSE, revoked_at = now(), revoke_reason = 'account_inactive (040)', updated_at = now()
      FROM users u WHERE u.id = s.user_id AND s.is_active AND NOT u.is_active RETURNING s.id)
  SELECT COUNT(*) INTO n_inactive FROM r;
  WITH r AS (
    UPDATE user_scopes s SET is_active = FALSE, revoked_at = now(), revoke_reason = 'role_mismatch (040)', updated_at = now()
      FROM users u WHERE u.id = s.user_id AND s.is_active AND s.role <> u.role RETURNING s.id)
  SELECT COUNT(*) INTO n_role FROM r;
  IF n_inactive + n_role > 0 THEN
    RAISE NOTICE '040: revoked % scope(s) of inactive accounts and % scope(s) whose role differs from the account role', n_inactive, n_role;
  END IF;
END $$;

-- D5. Database backstop for deactivation and role change: whatever path changes the user row (route, admin SQL),
--     every session ends (token_version), scopes are revoked and pending codes burned. Reactivation re-grants
--     scopes explicitly (src/routes/users.js), never here.
CREATE OR REPLACE FUNCTION users_session_epoch()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.is_active AND NOT NEW.is_active) OR NEW.role IS DISTINCT FROM OLD.role THEN
    NEW.token_version := GREATEST(NEW.token_version, OLD.token_version + 1);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- Named to sort after trg_sync_user_status, which derives is_active from status first.
DROP TRIGGER IF EXISTS trg_users_session_epoch ON users;
CREATE TRIGGER trg_users_session_epoch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_session_epoch();

CREATE OR REPLACE FUNCTION users_access_revoked()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    UPDATE user_scopes SET is_active = FALSE, revoked_at = now(), revoke_reason = 'account_deactivated', updated_at = now()
     WHERE user_id = NEW.id AND is_active;
    UPDATE otp_codes SET used = TRUE WHERE user_id = NEW.id AND used = FALSE;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    UPDATE user_scopes SET is_active = FALSE, revoked_at = now(), revoke_reason = 'role_changed', updated_at = now()
     WHERE user_id = NEW.id AND is_active AND role <> NEW.role;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- No column list: is_active may be changed by trg_sync_user_status (a status-only UPDATE), which UPDATE OF misses.
DROP TRIGGER IF EXISTS trg_users_access_revoked ON users;
CREATE TRIGGER trg_users_access_revoked AFTER UPDATE ON users FOR EACH ROW
  WHEN ((OLD.is_active AND NOT NEW.is_active) OR NEW.role IS DISTINCT FROM OLD.role)
  EXECUTE FUNCTION users_access_revoked();

CREATE OR REPLACE FUNCTION guard_user_scope()
RETURNS TRIGGER AS $$
DECLARE u RECORD;
BEGIN
  SELECT role, is_active INTO u FROM users WHERE id = NEW.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Scope role must match an active user''s role (no such user)';
  END IF;
  IF NOT u.is_active OR u.role <> NEW.role THEN
    RAISE EXCEPTION 'Scope role must match an active user''s role (scope role %, user role %, active %)', NEW.role, u.role, u.is_active;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_user_scope ON user_scopes;
CREATE TRIGGER trg_guard_user_scope BEFORE INSERT OR UPDATE ON user_scopes FOR EACH ROW
  WHEN (NEW.is_active) EXECUTE FUNCTION guard_user_scope();

-- D6. One-time codes: none stays usable for an inactive account; purposes are fixed (account_setup is new:
--     invitations replace temporary passwords).
UPDATE otp_codes o SET used = TRUE FROM users u WHERE u.id = o.user_id AND NOT u.is_active AND NOT o.used;
DO $$
DECLARE n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'otp_codes_purpose_check') THEN
    ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check CHECK (purpose IN ('login', 'password_reset', 'account_setup')) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'otp_codes_purpose_check' AND NOT convalidated) THEN
    SELECT COUNT(*) INTO n FROM otp_codes WHERE purpose NOT IN ('login', 'password_reset', 'account_setup');
    IF n = 0 THEN
      ALTER TABLE otp_codes VALIDATE CONSTRAINT otp_codes_purpose_check;
    ELSE
      RAISE NOTICE '040: % one-time code(s) have an unknown purpose; otp_codes_purpose_check left NOT VALID (new rows are checked)', n;
    END IF;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_otp_codes_hash_unused ON otp_codes (code_hash) WHERE used = FALSE;

-- D7. Email is case-insensitive (logins compare lower(email)). Accounts that differ only by case are a data
--     decision for a human, so the upgrade stops and says so instead of picking one silently.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM (SELECT lower(email) FROM users GROUP BY lower(email) HAVING COUNT(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION '040: % email address(es) are used by more than one account differing only by letter case; merge or rename them, then re-run the migration', n;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));

-- ---------------------------------------------------------------------------------------------------------------
-- E. Attachments: virus-scan bookkeeping, quarantine, and clean-only gates
-- ---------------------------------------------------------------------------------------------------------------
-- E1. Rescan bookkeeping (src/attachment-scan.js).
ALTER TABLE question_attachments ADD COLUMN IF NOT EXISTS scan_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE question_attachments ADD COLUMN IF NOT EXISTS last_scanned_at TIMESTAMPTZ;
ALTER TABLE question_attachments ADD COLUMN IF NOT EXISTS scan_detail TEXT;
CREATE INDEX IF NOT EXISTS idx_question_attachments_unscanned ON question_attachments (last_scanned_at NULLS FIRST)
  WHERE scan_status IN ('failed', 'pending');
COMMENT ON COLUMN question_attachments.scan_detail IS 'Fixed scanner reason token (scanner_unavailable, scan_timeout, ...) or the signature of an infected file';

-- E2. A clean file is never left in quarantine; an infected file is never stored. NOT VALID: new and changed rows
--     are checked at once, existing rows are validated only when none violates the rule.
DO $$
DECLARE n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_attachments_scan_storage_check') THEN
    ALTER TABLE question_attachments ADD CONSTRAINT question_attachments_scan_storage_check
      CHECK ((scan_status <> 'clean' OR file_path NOT LIKE 'quarantine/%') AND (scan_status <> 'infected' OR file_path = '')) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_attachments_scan_storage_check' AND NOT convalidated) THEN
    SELECT COUNT(*) INTO n FROM question_attachments
     WHERE NOT ((scan_status <> 'clean' OR file_path NOT LIKE 'quarantine/%') AND (scan_status <> 'infected' OR file_path = ''));
    IF n = 0 THEN
      ALTER TABLE question_attachments VALIDATE CONSTRAINT question_attachments_scan_storage_check;
    ELSE
      RAISE NOTICE '040: % attachment row(s) break the quarantine rule; question_attachments_scan_storage_check left NOT VALID (new rows are checked)', n;
    END IF;
  END IF;
END $$;

-- E3. Quality gate (038 section 8, unchanged otherwise): a diagram needs a CLEAN attachment, and no question with
--     an attachment that has not passed the virus scan can become ACTIVE.
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
  'Quality gate for ACTIVE (spec §11). Accepts APPROVED (activate) or RETIRED (restore) as the prior state and re-runs every other check, including clean attachments (040). Returns (valid, errors[]).';

-- E4. Submission (direct or derived by the legacy bridge) needs every attachment scanned clean. AFTER, so it also
--     sees the state the BEFORE triggers derived. Same data-repair hatch as the content lock (038 section 12).
CREATE OR REPLACE FUNCTION require_clean_attachments()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.question_content_override', true), '') = 'on' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM question_attachments WHERE question_id = NEW.id AND scan_status <> 'clean') THEN
    RAISE EXCEPTION 'Question % cannot be % while an attachment has not passed the virus scan', NEW.id, NEW.question_status;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_require_clean_attachments ON questions;
CREATE TRIGGER trg_require_clean_attachments AFTER UPDATE ON questions FOR EACH ROW
  WHEN (OLD.question_status IS DISTINCT FROM NEW.question_status AND NEW.question_status IN ('SUBMITTED', 'RESUBMITTED'))
  EXECUTE FUNCTION require_clean_attachments();

-- E5. Attachment guard (038 section 13) with the question row share-locked: an upload committing concurrently with
--     a submit either lands before it (and the submit sees the unscanned file) or waits and is refused.
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
    SELECT question_status INTO v_status FROM questions WHERE id = OLD.question_id FOR SHARE;
    IF FOUND AND v_status NOT IN ('DRAFT', 'CHANGES_REQUESTED') THEN
      RAISE EXCEPTION 'Question attachments can only change while the question is DRAFT or CHANGES_REQUESTED (it is %)', v_status;
    END IF;
  END IF;
  SELECT question_status INTO v_status FROM questions
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.question_id ELSE NEW.question_id END FOR SHARE;
  IF FOUND AND v_status NOT IN ('DRAFT', 'CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'Question attachments can only change while the question is DRAFT or CHANGES_REQUESTED (it is %)', v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------------------------
-- F. Review follow-ups
-- ---------------------------------------------------------------------------------------------------------------
-- F1. An HOD heads a whole department. Every HOD check matches campus + department only, so a program- or
--     offering-limited HOD scope would silently grant the whole department. Such active rows are revoked (with
--     history and a NOTICE: the admin re-grants a department-level scope if that HOD should keep access), and a
--     CHECK refuses new ones. POST /api/admin/scopes refuses them too.
DO $$
DECLARE n INT;
BEGIN
  WITH r AS (
    UPDATE user_scopes SET is_active = FALSE, revoked_at = now(), revoke_reason = 'hod_scope_must_be_department_level', updated_at = now()
     WHERE role = 'hod' AND is_active AND (program_id IS NOT NULL OR course_offering_id IS NOT NULL)
    RETURNING id)
  SELECT COUNT(*) INTO n FROM r;
  IF n > 0 THEN
    RAISE NOTICE '040: % program- or offering-limited HOD scope(s) revoked (HOD scopes cover a whole department); re-grant a department-level scope through /api/admin/scopes where intended', n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_scopes_hod_department_level') THEN
    ALTER TABLE user_scopes ADD CONSTRAINT chk_user_scopes_hod_department_level
      CHECK (role <> 'hod' OR NOT is_active OR (program_id IS NULL AND course_offering_id IS NULL));
  END IF;
END $$;

-- F2. HOD routes authorize only through user_scopes; the backfill (section B) cannot place an HOD with no home
--     department, or whose department has no campus. Report them instead of leaving every HOD route at 403 silently.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM users u
   WHERE u.role = 'hod' AND u.is_active
     AND NOT EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = u.id AND s.role = 'hod' AND s.is_active);
  IF n > 0 THEN
    RAISE NOTICE '040: % active HOD account(s) hold no active HOD scope (no home department with a campus, or an admin revoked it); they are refused on every HOD route until an admin grants one through /api/admin/scopes', n;
  END IF;
END $$;

-- F3. Automatic IP blocks expire (src/security.js); a block an admin adds by hand (expires_at NULL) does not.
--     Existing automatic blocks get the same one-hour lifetime from now, so a shared campus address that tripped
--     the old permanent block is released without manual cleanup.
ALTER TABLE blocked_ips ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE blocked_ips SET expires_at = now() + interval '1 hour' WHERE auto_blocked AND expires_at IS NULL;
