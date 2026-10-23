-- Schema spot checks after `npm run migrate` (run twice). Used by run-checks.sh (step 06) and CI; any SQL error fails the step.
SELECT count(*) AS migrations_applied FROM schema_migrations;
SELECT tgname AS exam_papers_triggers FROM pg_trigger WHERE tgrelid = 'exam_papers'::regclass AND NOT tgisinternal ORDER BY 1;
SELECT column_name AS new_columns FROM information_schema.columns
 WHERE table_name = 'exam_papers' AND column_name IN ('required_approvals','archived_at','archived_by','archive_reason') ORDER BY 1;
SELECT key, value FROM system_state WHERE key = 'required_validator_approvals';
SELECT proname AS functions FROM pg_proc
 WHERE proname IN ('enforce_paper_lifecycle','enforce_paper_immutability','validate_question_for_active') ORDER BY 1;
SELECT tgname AS users_triggers FROM pg_trigger WHERE tgrelid = 'users'::regclass AND NOT tgisinternal ORDER BY 1;
SELECT pg_get_constraintdef(oid) AS bloom_check FROM pg_constraint WHERE conrelid = 'questions'::regclass AND conname = 'questions_bloom_level_check';
SELECT pg_get_constraintdef(oid) AS question_type_check FROM pg_constraint WHERE conrelid = 'questions'::regclass AND conname = 'questions_question_type_check';
SELECT to_regclass('question_reservations') AS reservations_table, to_regclass('syllabus_subtopics') AS subtopics_table;
SELECT tgname AS reservation_trigger FROM pg_trigger WHERE tgname = 'trg_release_question_reservations';
SELECT tgname AS questions_triggers FROM pg_trigger WHERE tgrelid = 'questions'::regclass AND NOT tgisinternal ORDER BY 1;
SELECT tgname AS attachment_triggers FROM pg_trigger WHERE tgrelid = 'question_attachments'::regclass AND NOT tgisinternal ORDER BY 1;
SELECT pg_get_function_identity_arguments(oid) AS gate_args FROM pg_proc WHERE proname = 'validate_question_for_active';
SELECT table_name || '.' || column_name AS new_038_columns FROM information_schema.columns
 WHERE (table_name = 'questions' AND column_name IN ('ai_reviewed_at','ai_review_dispute','ai_review_disputed_at','change_request_reason','change_requested_by','change_requested_at'))
    OR (table_name = 'question_versions' AND column_name IN ('answer_data','subtopic'))
    OR (table_name = 'review_batch_items' AND column_name IN ('outcome','decided_by','decided_at')) ORDER BY 1;
SELECT indexname AS new_038_indexes FROM pg_indexes
 WHERE indexname IN ('uq_question_versions_current','uq_canonical_answers_current','uq_review_batch_items_open_round','idx_questions_ai_dispute') ORDER BY 1;
SELECT pg_get_constraintdef(oid) AS qco_source_check FROM pg_constraint WHERE conname = 'question_course_outcomes_source_check';
SELECT indexname AS new_039_indexes FROM pg_indexes
 WHERE indexname IN ('uq_exam_papers_examination_version','uq_paper_blueprints_examination_version','uq_paper_blueprints_active_per_examination') ORDER BY 1;
SELECT tgname AS new_039_triggers FROM pg_trigger
 WHERE tgname IN ('trg_one_live_paper_per_examination','trg_one_live_paper_per_examination_status','trg_protect_used_blueprint','trg_protect_constraint_override_records') ORDER BY 1;
SELECT table_name || '.' || column_name AS new_040_columns FROM information_schema.columns
 WHERE (table_name = 'users' AND column_name IN ('totp_last_used_step','totp_pending_secret','totp_reenroll_required','deactivated_at','created_by'))
    OR (table_name = 'user_scopes' AND column_name IN ('granted_by','revoked_at','revoked_by','revoke_reason'))
    OR (table_name = 'step_up_auth_log' AND column_name IN ('user_id','failure_reason'))
    OR (table_name = 'question_attachments' AND column_name IN ('scan_attempts','last_scanned_at','scan_detail')) ORDER BY 1;
SELECT tgname AS new_040_triggers FROM pg_trigger
 WHERE tgname IN ('trg_users_session_epoch','trg_users_access_revoked','trg_guard_user_scope','trg_require_clean_attachments') ORDER BY 1;
SELECT conname AS new_040_constraints FROM pg_constraint
 WHERE conname IN ('users_totp_secret_sealed','users_totp_enabled_has_secret','otp_codes_purpose_check','question_attachments_scan_storage_check','tca_section_same_offering_fk') ORDER BY 1;
SELECT indexname AS new_040_indexes FROM pg_indexes WHERE indexname IN ('uq_user_scopes_active','uq_users_email_lower','idx_step_up_user_time') ORDER BY 1;
SELECT count(*) AS user_scopes_table_unique_constraints_left FROM pg_constraint WHERE conrelid = 'user_scopes'::regclass AND contype = 'u';
SELECT conname AS new_040f_constraints FROM pg_constraint WHERE conname = 'chk_user_scopes_hod_department_level';
SELECT table_name || '.' || column_name AS new_040f_columns FROM information_schema.columns WHERE table_name = 'blocked_ips' AND column_name = 'expires_at';
SELECT position('''attachments''' in prosrc) > 0 AS snapshot_records_attachments_041 FROM pg_proc WHERE proname = 'create_paper_question_snapshot';
SELECT position('PNG or JPEG' in prosrc) > 0 AS gate_requires_printable_diagram_041 FROM pg_proc WHERE proname = 'validate_question_for_active';
SELECT pg_get_constraintdef(oid) AS syllabus_status_check_042 FROM pg_constraint WHERE conname = 'syllabus_versions_status_check';
SELECT tgname AS new_042_triggers FROM pg_trigger
 WHERE tgname IN ('trg_guard_syllabus_version','trg_guard_offering_syllabus_pointer','trg_guard_syllabus_units','trg_guard_syllabus_topics',
                  'trg_guard_syllabus_subtopics','trg_guard_course_outcomes','trg_protect_question_syllabus_remaps','trg_check_question_subtopic_version') ORDER BY 1;
SELECT table_name || '.' || column_name AS new_042_columns FROM information_schema.columns
 WHERE (table_name = 'syllabus_versions' AND column_name IN ('status','based_on_version_id','superseded_by_version_id','rejection_reason'))
    OR (table_name = 'questions' AND column_name = 'subtopic_id')
    OR (table_name = 'canonical_questions' AND column_name IN ('verified_syllabus_subtopic_id','verified_by_reviewer_ids'))
    OR (table_name = 'affected_questions' AND column_name IN ('question_id','action_taken')) ORDER BY 1;
SELECT proname AS new_042_functions FROM pg_proc
 WHERE proname IN ('question_has_verified_mapping','syllabus_version_content_problems','guard_syllabus_version','guard_syllabus_content') ORDER BY 1;
SELECT to_regclass('question_syllabus_remaps') AS remaps_table_042, position('app.syllabus_remap' in prosrc) > 0 AS content_lock_remap_hatch_042
  FROM pg_proc WHERE proname = 'protect_locked_question_content';
SELECT position('Missing reviewer-verified topic' in prosrc) > 0 AS gate_requires_verified_mapping_042 FROM pg_proc WHERE proname = 'validate_question_for_active';
