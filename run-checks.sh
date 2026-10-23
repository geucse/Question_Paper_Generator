#!/usr/bin/env bash
# Runs every check in order and writes logs/summary.txt. Run from the exam-portal folder:
#   ./run-checks.sh                          # fresh-database checks only
#   ./run-checks.sh ~/db-backups/xxx.dump    # also upgrade a COPY of your real data and compare
# Optional extras: SKIP_E2E=1 skips the browser e2e step (it is skipped anyway, with a note, while Playwright's chromium
# is not installed: cd frontend && npx playwright install chromium); DOCKER_BUILD=1 also builds both Docker images.
# .github/workflows/ci.yml runs the same steps (minus the copy-of-real-data upgrade); keep the two in step.
# Uses its own throwaway Postgres container (exam-portal-testdb, port 5433); never touches
# exam-portal-postgres or any other database. Needs backend/.env with DATABASE_URL on port 5433.
cd "$(dirname "$0")" || exit 1
DUMP="$1"
mkdir -p logs && : > logs/results.txt
if ! grep -q '^DATABASE_URL=.*:5433/' backend/.env 2>/dev/null; then
  echo "STOP: backend/.env must point DATABASE_URL at the test database on port 5433 (see the setup step)."; exit 1
fi
if ss -ltn 2>/dev/null | grep -q ':4000 '; then echo "STOP: port 4000 is busy - stop your other server first."; exit 1; fi

step() {   # step <name> <command...>  -> logs/<name>.txt and a PASS/FAIL line
  local name="$1"; shift
  echo ">>> $name ..."
  if "$@" > "logs/$name.txt" 2>&1; then echo "PASS $name" | tee -a logs/results.txt
  else echo "FAIL $name  (details: logs/$name.txt)" | tee -a logs/results.txt; fi
}

# Separate throwaway test database on port 5433. Your existing exam-portal-postgres (port 5432) is never touched.
docker rm -f exam-portal-testdb > /dev/null 2>&1
step 01-database docker run -d --name exam-portal-testdb -e POSTGRES_USER=examportal -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=examportal -p 5433:5432 pgvector/pgvector:pg16
for _ in $(seq 1 30); do docker exec exam-portal-testdb pg_isready -U examportal -d examportal > /dev/null 2>&1 && break; sleep 1; done
sleep 3   # the Postgres image restarts once after first-time init
for _ in $(seq 1 30); do docker exec exam-portal-testdb pg_isready -U examportal -d examportal > /dev/null 2>&1 && break; sleep 1; done

step 02-backend-install bash -c 'cd backend && npm ci'
step 02b-backend-audit  bash -c 'cd backend && npm audit --omit=dev --audit-level=high'
step 03-unit-tests      bash -c 'cd backend && npm run test:unit'
step 04-route-tests     bash -c 'cd backend && npm run test:routes'
step 05-migrate         bash -c 'cd backend && npm run migrate && npm run migrate'

step 06-schema-check bash -c 'docker exec -i exam-portal-testdb psql -U examportal -d examportal -v ON_ERROR_STOP=1 < backend/test/schema-check.sql'
step 07-seed bash -c 'cd backend && npm run seed'

echo ">>> starting server ..."
# Throwaway-run settings (development mode): codes go to the server log MASKED (the smoke test overwrites the stored
# hashes, so it never needs them); no Redis in this run (per-process limits, chosen explicitly); limits raised for
# the scripted smoke test. Production refuses every one of these dev-only settings.
# ClamAV: the server is pointed at SMOKE_CLAMD_PORT, where nothing listens at first (uploads are quarantined,
# fail-closed); the smoke test later starts a fake clamd there to exercise the real clean-rescan path. The background
# rescan sweeper is off so it cannot race the smoke test's own rescan.
SMOKE_CLAMD_PORT=${SMOKE_CLAMD_PORT:-3399}
( cd backend && AUTH_RATE_MAX=500 GLOBAL_RATE_MAX=5000 RATE_LIMIT_STORE=memory OTP_DELIVERY_PROVIDER=console DEV_OTP_CONSOLE=masked \
    CLAMD_HOST=127.0.0.1 CLAMD_PORT="$SMOKE_CLAMD_PORT" CLAMD_SOCKET='' ATTACHMENT_RESCAN_INTERVAL_MS=0 \
    exec node src/server.js ) > logs/08-server.txt 2>&1 &
SERVER_PID=$!
UP=0
for _ in $(seq 1 30); do
  node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && { UP=1; break; }
  sleep 1
done
if [ "$UP" = 1 ]; then echo "PASS 08-server-start" | tee -a logs/results.txt
else echo "FAIL 08-server-start  (details: logs/08-server.txt)" | tee -a logs/results.txt; fi
# Readiness as the server itself reports it (development: 200, 'ready' or 'degraded'; no ClamAV in this run).
node -e "fetch('http://localhost:4000/api/health/ready').then(async r=>{console.log('READINESS', r.status, await r.text()); process.exit(r.status===200?0:1)}).catch(e=>{console.log('READINESS unreachable'); process.exit(1)})" > logs/08b-readiness.txt 2>&1 \
  && echo "PASS 08b-readiness" | tee -a logs/results.txt || echo "FAIL 08b-readiness  (details: logs/08b-readiness.txt)" | tee -a logs/results.txt
step 09-smoke-test bash -c "cd backend && SMOKE_FAKE_CLAMD_PORT=$SMOKE_CLAMD_PORT npm run smoke:pivot"
kill "$SERVER_PID" 2> /dev/null

# ---- Upgrade a COPY of real data (spec §38): restore the backup, migrate it, compare row counts ----
if [ -n "$DUMP" ]; then
  COPY_URL=postgres://examportal:devpassword@localhost:5433/examportal_copy
  COUNTS="SELECT 'users', count(*) FROM users UNION ALL SELECT 'questions', count(*) FROM questions
    UNION ALL SELECT 'canonical_questions (excl. 038 bulk backfill)', count(*) FROM canonical_questions cq WHERE NOT EXISTS (SELECT 1 FROM question_canonicalization_events e WHERE e.canonical_question_id = cq.id AND e.reason LIKE 'Backfilled by 038:%')
    UNION ALL SELECT 'exam_papers', count(*) FROM exam_papers
    UNION ALL SELECT 'paper_questions', count(*) FROM paper_questions UNION ALL SELECT 'audit_log', count(*) FROM audit_log
    UNION ALL SELECT 'questions in ACTIVE status (no migration changes a status)', count(*) FROM questions WHERE question_status = 'ACTIVE' ORDER BY 1;"
  psqlc() { docker exec -i exam-portal-testdb psql -U examportal -d examportal_copy -v ON_ERROR_STOP=1 -At "$@"; }
  step 13-copy-restore bash -c "docker exec exam-portal-testdb createdb -U examportal examportal_copy && docker exec -i exam-portal-testdb pg_restore -U examportal -d examportal_copy --no-owner < '$DUMP'"
  echo "$COUNTS" | psqlc > logs/13-counts-before.txt 2>&1
  step 14-copy-migrate bash -c "cd backend && DATABASE_URL=$COPY_URL npm run migrate"
  echo "$COUNTS" | psqlc > logs/14-counts-after.txt 2>&1
  step 15-copy-rows-unchanged diff logs/13-counts-before.txt logs/14-counts-after.txt
  cat > logs/copy-check.sql <<'SQL'
SELECT 'migrations applied', count(*)::text FROM schema_migrations;
SELECT 'users with status/is_active mismatch', count(*)::text FROM users WHERE (status = 'ACTIVE') IS DISTINCT FROM is_active;
SELECT 'questions with non-lowercase bloom_level', count(*)::text FROM questions WHERE bloom_level <> lower(bloom_level);
SELECT 'COE_APPROVED papers without COE approver', count(*)::text FROM exam_papers WHERE paper_status = 'COE_APPROVED' AND coe_approved_by IS NULL;
SELECT 'quality gate evaluated on every question (no runtime error)', count(*)::text FROM questions q, LATERAL validate_question_for_active(q.id) v;
SELECT 'paper_status distribution', string_agg(paper_status || '=' || n, ', ') FROM (SELECT paper_status, count(*) n FROM exam_papers GROUP BY 1 ORDER BY 1) x;
SELECT 'question_status distribution', string_agg(question_status || '=' || n, ', ') FROM (SELECT question_status, count(*) n FROM questions GROUP BY 1 ORDER BY 1) x;
SELECT 'question_type distribution', string_agg(question_type || '=' || n, ', ') FROM (SELECT question_type, count(*) n FROM questions GROUP BY 1 ORDER BY 1) x;
SELECT 'questions still using objective/subjective', count(*)::text FROM questions WHERE question_type IN ('objective', 'subjective');
SELECT 'active reservations (in-flight papers)', count(*)::text FROM question_reservations WHERE released_at IS NULL;
SELECT 'ACTIVE/RETIRED questions with legacy status <> approved (expect 0)', count(*)::text FROM questions WHERE question_status IN ('ACTIVE','RETIRED') AND status <> 'approved';
SELECT 'non-draft bulk-imported questions without a canonical question (expect 0)', count(*)::text FROM questions WHERE bulk_batch_id IS NOT NULL AND canonical_question_id IS NULL AND question_status NOT IN ('DRAFT','REJECTED');
SELECT 'canonical questions created by the 038 bulk backfill', count(*)::text FROM question_canonicalization_events WHERE reason LIKE 'Backfilled by 038:%';
SELECT 'open review rounds per question > 1 (expect 0)', count(*)::text FROM (SELECT question_id FROM review_batch_items WHERE outcome IS NULL GROUP BY 1 HAVING count(*) > 1) x;
SELECT 'open review rounds in closed batches (expect 0)', count(*)::text FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id WHERE rbi.outcome IS NULL AND rb.status = 'closed';
SELECT 'open review rounds older than the question''s latest edit, submission or decision (expect 0)', count(*)::text FROM review_batch_items rbi JOIN questions q ON q.id = rbi.question_id
 WHERE rbi.outcome IS NULL AND (q.last_edited_at > rbi.created_at OR EXISTS (SELECT 1 FROM audit_log a WHERE a.entity_id = q.id::text AND a.created_at > rbi.created_at
   AND a.action IN ('question_transition_changes_requested','question_transition_approved','question_transition_rejected','question_transition_draft','question_transition_submitted',
                    'question_transition_resubmitted','question_final_submit','question_resubmitted','draft_updated','question_approved','question_rejected')));
SELECT 'CHANGES_REQUESTED questions without a change request reason', count(*)::text FROM questions WHERE question_status = 'CHANGES_REQUESTED' AND change_request_reason IS NULL;
SELECT 'examinations with more than one paper in progress (grandfathered by 039)', count(*)::text FROM (SELECT examination_id FROM exam_papers WHERE examination_id IS NOT NULL
   AND paper_status IN ('GENERATING','GENERATED','VALIDATION_PENDING','CHANGES_REQUIRED','VALIDATED','COE_APPROVED') GROUP BY 1 HAVING count(*) > 1) x;
SELECT 'examinations with more than one PRINT_READY paper (expect 0)', count(*)::text FROM (SELECT examination_id FROM exam_papers WHERE examination_id IS NOT NULL
   AND paper_status = 'PRINT_READY' GROUP BY 1 HAVING count(*) > 1) x;
SELECT 'CHANGES_REQUIRED papers (the technical reset no longer applies to them)', count(*)::text FROM exam_papers WHERE paper_status = 'CHANGES_REQUIRED';
SELECT 'examinations with more than one active blueprint (expect 0)', count(*)::text FROM (SELECT examination_id FROM paper_blueprints WHERE is_active AND examination_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;
SELECT 'accounts that must set up their authenticator again (plaintext secret revoked by 040)', count(*)::text FROM users WHERE totp_reenroll_required;
SELECT 'non-sealed TOTP secrets (expect 0)', count(*)::text FROM users WHERE totp_secret IS NOT NULL AND totp_secret !~ '^v1\.';
SELECT 'active scopes of inactive accounts or of another role (expect 0)', count(*)::text FROM user_scopes s JOIN users u ON u.id = s.user_id WHERE s.is_active AND (NOT u.is_active OR s.role <> u.role);
SELECT 'scopes revoked by 040 (inactive account / role mismatch / duplicate)', count(*)::text FROM user_scopes WHERE revoke_reason LIKE '%(040)';
SELECT 'attachments not scanned clean (quarantined until a rescan)', count(*)::text FROM question_attachments WHERE scan_status <> 'clean';
SELECT 'program/offering-limited HOD scopes revoked by 040 F1', count(*)::text FROM user_scopes WHERE revoke_reason = 'hod_scope_must_be_department_level';
SELECT 'active HODs without an active HOD scope (expect 0; 040 F2 reports them)', count(*)::text FROM users u WHERE u.role = 'hod' AND u.is_active AND NOT EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = u.id AND s.role = 'hod' AND s.is_active);
SELECT 'automatic IP blocks without an expiry (expect 0)', count(*)::text FROM blocked_ips WHERE auto_blocked AND expires_at IS NULL;
SELECT 'ACTIVE diagram questions without a clean PNG/JPEG diagram (stay ACTIVE; 041 reports them)', count(*)::text FROM questions q WHERE q.question_type = 'diagram' AND q.question_status = 'ACTIVE'
   AND NOT EXISTS (SELECT 1 FROM question_attachments a WHERE a.question_id = q.id AND a.scan_status = 'clean' AND a.file_type IN ('image/png', 'image/jpeg'));
SELECT 'syllabus versions by status (042 backfill)', string_agg(status || '=' || n, ', ') FROM (SELECT status, count(*) n FROM syllabus_versions GROUP BY 1 ORDER BY 1) x;
SELECT 'offerings with more than one ACTIVE syllabus version (expect 0)', count(*)::text FROM (SELECT course_offering_id FROM syllabus_versions WHERE status = 'ACTIVE' GROUP BY 1 HAVING count(*) > 1) x;
SELECT 'offerings whose current syllabus pointer is not their ACTIVE version (042 reports them)', count(*)::text FROM course_offerings co
 WHERE co.syllabus_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM syllabus_versions sv WHERE sv.id = co.syllabus_version_id AND sv.status = 'ACTIVE');
SELECT 'ACTIVE questions not generation-eligible under 042 (no reviewer-verified topic/CO/Bloom in their version; status unchanged)', count(*)::text || ' of ' || (SELECT count(*) FROM questions WHERE question_status = 'ACTIVE')::text
  FROM questions q WHERE q.question_status = 'ACTIVE' AND NOT question_has_verified_mapping(q.id);
SELECT 'ACTIVE questions failing the 042 quality gate if re-checked (they stay ACTIVE)', count(*)::text FROM questions q, LATERAL validate_question_for_active(q.id, 'APPROVED') v
 WHERE q.question_status = 'ACTIVE' AND NOT v.valid;
SELECT 'questions with a subtopic title but no subtopic_id (legacy; verified on the next review)', count(*)::text FROM questions WHERE subtopic IS NOT NULL AND trim(subtopic) <> '' AND subtopic_id IS NULL;
SQL
  step 16-copy-integrity bash -c "docker exec -i exam-portal-testdb psql -U examportal -d examportal_copy -v ON_ERROR_STOP=1 -At -F ': ' < logs/copy-check.sql"
fi

step 10-frontend-install bash -c 'cd frontend && npm ci'
step 10b-frontend-audit  bash -c 'cd frontend && npm audit --omit=dev --audit-level=high'
step 11-frontend-lint    bash -c 'cd frontend && npm run lint'      # oxlint --deny-warnings: any warning fails
step 12-frontend-build   bash -c 'cd frontend && npm run build'
# Browser checks of the UI against a mocked API (frontend/e2e/mock-ui.cjs); needs Playwright's chromium.
if [ "$SKIP_E2E" = 1 ]; then echo "SKIP 12b-frontend-e2e (SKIP_E2E=1)" | tee -a logs/results.txt
elif ! (cd frontend && node -e "process.exit(require('fs').existsSync(require('playwright').chromium.executablePath()) ? 0 : 1)") 2> /dev/null; then
  echo "SKIP 12b-frontend-e2e (chromium not installed: cd frontend && npx playwright install chromium)" | tee -a logs/results.txt
else step 12b-frontend-e2e bash -c 'cd frontend && npm run test:e2e'; fi
if [ "$DOCKER_BUILD" = 1 ]; then
  step 12c-docker-backend  docker build -t exam-portal-backend:checks backend
  step 12d-docker-frontend docker build -t exam-portal-frontend:checks frontend
fi

# Summary to send back. The seed log is left out on purpose (it prints demo passwords).
{
  echo "=== RESULTS"; cat logs/results.txt
  for f in 02b-backend-audit 03-unit-tests 04-route-tests 05-migrate 06-schema-check 08b-readiness 09-smoke-test 10b-frontend-audit 11-frontend-lint 12-frontend-build 12b-frontend-e2e 12c-docker-backend 12d-docker-frontend 13-copy-restore 14-copy-migrate 15-copy-rows-unchanged 16-copy-integrity; do
    [ -f "logs/$f.txt" ] && { echo; echo "=== $f (last 40 lines)"; tail -n 40 "logs/$f.txt"; }
  done
  for f in 02-backend-install 07-seed 10-frontend-install; do
    grep -q "^FAIL $f" logs/results.txt && { echo; echo "=== $f errors"; grep -iE "err|fail" "logs/$f.txt" | grep -viE "password" | tail -n 30; }
  done
  [ -f logs/13-counts-before.txt ] && { echo; echo "=== row counts before -> after"; paste logs/13-counts-before.txt logs/14-counts-after.txt; }
  echo; echo "=== server errors"; grep -iE "error|exception" logs/08-server.txt | tail -n 30
  echo; echo "=== unmasked codes in the server log (expect none)"; grep -cE "code=[0-9]{6}([^0-9*]|$)" logs/08-server.txt
} > logs/summary.txt
echo; echo "Done. Send me: $(pwd)/logs/summary.txt"
