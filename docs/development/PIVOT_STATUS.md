# PIVOT_SPEC_V2 — implementation status

Format follows `brain.md` §20–21. Phases 1–5 have been run against PostgreSQL 16 (pgvector) in a throwaway container, together with
an upgrade of a copy of real data (`./run-checks.sh <dump>`, all steps PASS on 2026-10-22). The sections from "Verified in the authoring
environment" downwards are the history of earlier passes; the current state is the phase sections and the acceptance report below.

## Phase 5 — reproducible installs, CI, Docker, lint, browser e2e (no migration)

| Gap | Change | Verified |
|---|---|---|
| `xlsx` 0.18.5 (npm) parses untrusted uploads and has prototype-pollution / ReDoS advisories | SheetJS 0.20.3 from the SheetJS CDN tarball (latest published; pinned with its integrity hash in the lockfile); ESM `import * as XLSX` in `routes/bulk.js`, `routes/analytics.js`, tests and smoke test; parse options unchanged | unit/route tests (template, export, round trip, bulk upload), smoke (bulk upload of all 13 types, export = SQL truth) |
| `npm audit --omit=dev` reported 1 high (nodemailer) and 3 moderate | nodemailer 6 → 10.2 (same `createTransport`/`sendMail` API), file-type 19 → 22 (`fileTypeFromBuffer` unchanged), unused `uuid` and `csv-parse` removed. Both lockfiles regenerated from the manifests; `npm ci` used everywhere | `npm audit`: 0 vulnerabilities (backend and frontend, prod and dev); `npm ci` from both lockfiles |
| Node 20 left support (April 2026); file-type 22 needs Node 22 | Node 22 in CI and in both Dockerfiles | CI steps run locally on Node 22.23; both images built |
| CI lacked `JWT_SECRET` for seed/smoke, ran migrations once, no audit, no e2e, no image build | `.github/workflows/ci.yml` mirrors `run-checks.sh`: job-level env (JWT_SECRET ≥ 32 chars, AUTH/GLOBAL rate limits, `RATE_LIMIT_STORE=memory`, `DEV_OTP_CONSOLE=masked`, fake clamd port 3399, rescan sweeper off), npm ci → audit (high fails) → tests → migrate twice → schema check (`backend/test/schema-check.sql`, shared with run-checks) → seed → server → health + readiness → smoke → no unmasked codes; frontend npm ci → audit → lint → build; e2e job; docker job (build both, non-root check) | actionlint 1.7.12 + shellcheck 0.10.0: clean. Every `run:` step executed locally in order with the job env against a fresh database on port 5433 (backend/.env ignored, as in CI): all PASS. **Not yet run on GitHub's runners.** |
| A unit test depended on the caller's environment | `test-antivirus.mjs` clears `CLAMD_*` before its first check (CI sets them for its server) | found by the local CI run; unit 120/120 under both environments |
| Dockerfiles: `npm install`, root user, no health check, no .dockerignore | backend: `npm ci --omit=dev`, runs as `node` (uid 1000), only `uploads/` writable, HEALTHCHECK on `/api/health/live`; frontend: multi-stage `npm ci` (then loads Vite, so a native binding that npm silently skipped after a failed download fails the step instead of caching a broken layer — seen once here on a flaky network) + build, served by `nginxinc/nginx-unprivileged` (uid 101, port **8080**), `/healthz`, HEALTHCHECK; `.dockerignore` for both (node_modules, `.env*`, uploads, dist, dist-e2e, logs, e2e artifacts, test files, DB files/dumps) | `docker build` of both: success (270 MB / 49 MB). Both containers started: backend in production mode against the throwaway DB → healthy, `/api/health/live` 200, `/ready` 200 "degraded" (no clamd), uid 1000, uploads writable, source read-only; frontend → healthy, `/` and `/healthz` 200 |
| compose / k8s drifted from the images | compose: frontend `FRONTEND_PORT:8080`; k8s: frontend containerPort/Service targetPort 8080 with `/healthz` readiness + liveness, pod `securityContext` (non-root, fsGroup 1000 for the uploads volume, no privilege escalation, capabilities dropped), migrate Job non-root, backend gets `AUTO_BLOCK_MINUTES` and optional `TOTP_KEY_ROTATE` from the ConfigMap | YAML parse of every file; `docker compose -f docker-compose.prod.yml config`; the stack itself was not brought up (ClamAV signatures, SMTP, TLS) |
| 47 oxlint warnings; 17 unjustified `eslint-disable` comments hid more | loaders are `useCallback` promise chains with full deps; `useAsync().run` is stable (`useCallback`), so every effect lists it; reset-on-change effects moved into the event handler or derived during render; `onReviseOpened` read through a ref so the revise effect fires once per id; `QUESTION_STATES` and `useAsync` moved to `src/lib/`; no disable comments left. `npm run lint` is `oxlint --deny-warnings` | 0 warnings, 0 errors (35 files); build; e2e |
| `frontend/e2e/mock-ui.cjs` was never run (no Playwright) and had gone stale | Playwright 1.64 devDependency; `npm run test:e2e` builds with `vite build --mode e2e` (API base `http://mock.local/api`, output `dist-e2e/`) and runs the suite; stale checks updated to the current UI (rejection only in review batches; revise-and-resubmit; archive/campus/override field ids); new checks: validator session (queue, review, PDF preview/close, checklist gating, issue report, decision payload), syllabus versions screen in every state and content shape + change report, HOD question mapping (filters, gating, payload), admin sweep of every tab for academic action buttons, teacher revise opens the right section once | **87/87 pass** (chromium headless; `--with-deps` not needed on this machine) |

Behaviour changes: the frontend container listens on 8080 (compose maps `FRONTEND_PORT` to it; k8s Service still exposes 80);
both containers run as non-root; Node 22 is required; `npm run lint` fails on any warning; `run-checks.sh` uses `npm ci` and adds
audit, e2e (skipped with a note if chromium is missing, or with `SKIP_E2E=1`) and optional `DOCKER_BUILD=1` steps.

Remaining audit findings: none (`npm audit` and `npm audit --omit=dev`: 0 in backend and frontend). `npm ci` prints a deprecation
notice for `crypto-js` 4.2.0 (a pdfkit dependency; not an advisory). The smoke test prints one pg `DeprecationWarning` (concurrent
`client.query` in its own concurrency fixture; pre-existing).

## Acceptance report — spec §5 criteria 1–10 (2026-10-22)

Backend suites: unit 120/120, route 367/367 (`npm test`; route tests run the real handlers against a scripted fake database, so they
verify logic and the SQL issued, not its execution). Smoke on PostgreSQL 16: 348/348. Browser e2e against a mocked API: 87/87.
Copy of real data (dump of 2026-10-21) upgraded through 042: row counts unchanged, integrity checks as expected.

| # | Criterion | Covered by | Status |
|---|---|---|---|
| 1 | All 13 types: create, validate, review, edit, import/export, generate, PDF | unit `test-question-types.mjs` (13 types, CHECK drift, validation, activation rules), `test-paper-output.mjs` (PDF of each of the 13 with its key line, export/import round trip, template); route `test/question-output.test.mjs` (draft create/edit/refusal per type, export, round trip); smoke (bulk upload of one row of each type, typed questions through the gate, a generated paper and its PDF); e2e (type selector, type fields reach the API) | **Partially verified**: every step is tested per type except generation on PostgreSQL, which ran with six of the 13 types (mcq, programming, case study, A/R, diagram, numerical); the generator does not branch on type (unit tests), but the other seven were not generated into a real paper. Reviewer screens per type are covered by route tests of the response shape, not by a browser check of each type |
| 2 | Sections and section constraints persist and are enforced in generation and output | unit `test-paper-sections.mjs`, `test-generator-v2.mjs`; route `test/examinations.test.mjs`; smoke (sectioned blueprint, types/marks per section, decoy not used, PDF headings/choice rule/instructions); e2e (blueprint sections reach the API) | **Verified** |
| 3 | Feasible CO/Bloom targets met exactly; infeasible fail clearly, nothing written | unit `test-generator-v2.mjs`; route examinations tests; smoke (unmeetable CO and Bloom targets → 422 naming them, no rows; target naming no CO refused; recorded override); e2e (targets and override payload, reasons shown) | **Verified** |
| 4 | Validator decisions, 4-validator aggregation, conflicts, reassignment, transitions | unit `test-validator-eligibility.mjs`, `test-paper-policy.mjs`; route examinations tests; smoke (38 validator checks: exactly 4, rounds, replacement, revoked scope, decision/replacement race, archive ends assignments); e2e (validator session, checklist gating, decision payload) | **Verified** |
| 5 | Concurrent generation: no duplicate/reserved-question conflicts or invalid papers | smoke on PostgreSQL (two concurrent generations complete and share no question; same examination twice → one paper + 409; reservation conflict mid-generation rolled back and retried; persistent conflict → 422 with no rows; concurrent blueprint saves); route tests (lock/409 paths) | **Verified** functionally on a real database; no load or soak testing |
| 6 | Role and campus/department access control, legacy routes, IDOR | route `test/idor.test.mjs`, `test/academic-scope.test.mjs`, `test/accounts-auth.test.mjs`, `test/other.test.mjs` (legacy routes); smoke (cross-campus/department denials on Postgres, scope SQL); e2e (admin sees no academic actions; validator sees no authoring/COE/admin actions) | **Verified** for the enumerated routes and roles; no automated fuzzing |
| 7 | Lifecycle transitions and audit events | route `test/lifecycle.test.mjs`, `test/resubmit.test.mjs`, `test/review-batches.test.mjs`, `test/syllabus.test.mjs`; smoke (transitions, DB triggers, audit hash chain verified after concurrent work); e2e (withdraw, request changes, retire payloads and reasons) | **Verified** |
| 8 | Analytics match database truth; PDF access and watermark follow paper status | smoke (analytics status/type/CO/unit/topic/Bloom/usage/readiness = SQL truth per offering; DRAFT banner on every page of a draft PDF; PRINT_READY PDF from snapshots; replaced validators lose PDF access); unit `test-paper-output.mjs` (inline vs attachment); e2e (PDF preview/print buttons, inline request) | **Verified** |
| 9 | Clean install, lint/build, tests, migrations, smoke in an isolated environment | `./run-checks.sh <dump>` with `DOCKER_BUILD=1`: every step PASS (npm ci ×2, audits, unit, routes, migrate twice, schema check, seed, server, readiness, smoke, copy restore/migrate/rows/integrity, lint, build, e2e, both images); CI workflow steps executed locally | **Verified locally**; the GitHub Actions workflow is lint-clean and its commands pass locally but **has not run on GitHub** |
| 10 | Existing features remain functional | all suites above (487 backend tests, 348 smoke checks, 87 browser checks) after phase 5; upgrade of a copy of real data with row counts unchanged | **Partially verified**: regression suites only; no manual browser session against the real backend in this phase, and the e2e suite uses a mocked API |

Post-upgrade tasks for an existing database (found on the copy of real data): one examination has more than one paper in progress
(grandfathered by 039; archive the extra ones, COE → paper → Archive), and 27 of 27 ACTIVE questions are not generation-eligible until
the HOD maps them (Review workspace → Manage academics → Question mapping) or a reviewer re-reviews them; 1 account must set up its
authenticator again (040). See docs/development/GETTING_STARTED.md "Upgrading an existing database".

## Phase 4b — syllabus versioning, change detection, question re-mapping, verified-only generation (migration 042)

| Gap | Change | Verified |
|---|---|---|
| Syllabus versions had two loose columns (verification / approval) and approval re-approved anything pending | `syllabus_versions.status` DRAFT → TEACHER_VERIFIED → HOD_REVIEW → ACTIVE → SUPERSEDED, REJECTED (with reason, never from ACTIVE); CHECK + `trg_guard_syllabus_version` (transitions, verifier, an active HOD as approver, complete content: ≥1 active unit with a topic and ≥1 active CO, one ACTIVE per offering, decided versions immutable and never deleted); `approval_status` / `verification_status` are mirrors; `trg_guard_offering_syllabus_pointer` keeps the offering pointing at its ACTIVE version; routes verify / submit-review / return (reason) / approve / reject (reason); a concurrent create is 409; backfill: pointer + approved = ACTIVE, other approved = SUPERSEDED, verified pending = HOD_REVIEW | unit (diff), route tests (every transition, scope, 409 race), smoke (DB guards and the API flow) |
| Approved syllabus content could be edited or deactivated | units, topics, subtopics and COs change only in a DRAFT version (409 in the API, `trg_guard_syllabus_*` in the DB); "New version from current" copies the ACTIVE version's content into a DRAFT (`based_on_version_id`) | route tests (every content route × every non-draft state), smoke (route + DB) |
| Approval sent every APPROVED question back and never compared versions | activation diffs the previous and new version (`src/syllabus-versioning.js`; rule below) into `syllabus_changes`; each question of the previous version: every item unchanged → re-mapped (version, verified unit/topic/subtopic, CO rows copied with their verifier, `question_syllabus_remaps` 'auto_unchanged', audited); affected APPROVED → CHANGES_REQUESTED with a reason naming the change (lifecycle transition, audited); affected ACTIVE / RETIRED / in-review → flagged (`affected_questions`, audited), status unchanged; in an open review round, sharing a canonical record or with no identifiable topic → left for the HOD's mapping | unit (diff, classification), route tests (one approval covering every case, SQL order), smoke (real activation: changes, moves, audits) |
| No follow-up for affected or legacy questions | change report per version / per offering (HOD and assigned reviewers) with the affected questions; HOD "Question mapping": legacy (no version), superseded-version and unverified ACTIVE questions; `POST /academic/questions/:id/syllabus-mapping` sets version + verified unit/topic/subtopic/COs (+ Bloom) of the ACTIVE version, reason ≥ 10, audited, history row, flags resolved; a narrow DB hatch (`app.syllabus_remap`) moves a locked question only onto the ACTIVE version and opens no other column | route tests (validation, states, cross-department and cross-campus denial), smoke (mapping, cross-department HOD 403, a mapped legacy question passes the gate and enters the pool) |
| Subtopic was free text; topic free text satisfied the gate | `questions.subtopic_id` (title kept for legacy rows) checked against the question's version (`trg_check_question_subtopic_version`); `/questions/draft` and bulk upload validate topic + subtopic against the current version (ids or titles, stored with the syllabus spelling); a superseded-version question moves to the current version when its author edits or resubmits it; the teacher form uses unit › topic › subtopic selects of the ACTIVE version; reviewers verify the subtopic (verdict, consensus, HOD resolution) against the question's own version | unit (placement), route tests (draft, edit move, bulk confirm, verdict), smoke |
| Generation, the gate and analytics accepted unverified mappings | `question_has_verified_mapping()`: reviewer-verified Bloom, topic (and unit/subtopic) and a CO with a recorded verifier, all in the question's own version; the gate requires them; the pool requires them and uses only verified COs and Bloom for targets; an examination created before a change keeps its re-mapped questions; consensus of several reviewers records every verifier (`verified_by_reviewer_ids`) and the first as `verified_by`; analytics: subtopic coverage, topic unverified counts, CO verified = verifier recorded, CO rows of the question's own version, generation readiness (eligible / unverified / left on an older version) | route tests (pool SQL, analytics SQL, consensus ids), smoke (pool with and without a verifier, readiness = SQL truth) |

**Matching rule** (case-, width- and whitespace-insensitive; ordering never counts; a key that is not unique on both sides never matches): unit = same code (title changed → RENAMED) else same title (code changed → RENAMED); CO = same code (description changed → MODIFIED) else same description (renumbered → RENAMED); topic = same title under the matched unit, else same title under another unit → MODIFIED (moved); subtopic likewise under the matched topic; anything else REMOVED / ADDED. Topics and subtopics have no code, so a retitled topic is REMOVED + ADDED (never guessed). A question is unchanged only if its unit, topic, subtopic and every CO are UNCHANGED.

**ACTIVE questions on changed items** stay ACTIVE on the superseded version (flagged): their content is locked, examinations already created on that version may still need them, and nothing changes status silently. They are not eligible for any examination on the new version until the HOD maps them (or retires them), or a reviewer requests changes (the author then re-maps by editing).

Behaviour changes: approving a syllabus no longer sends every APPROVED question back; units/topics/subtopics/COs of a non-draft version can no longer be added or removed (start a new version); a draft's topic must exist in the current syllabus; ACTIVE questions without a reviewer-verified topic, CO (with verifier) and Bloom level are no longer generation-eligible and fail the gate if re-activated (status unchanged; the copy check reports the count); new examinations need the offering's ACTIVE version.

Known limitations of 4b: there is no route to edit a unit/topic/CO in place inside a draft (deactivate and add again; a CO code cannot be reused inside one version); multi-reviewer consensus results recorded before 042 have no verifier and count as unverified until re-reviewed; legacy subtopic titles are not converted to ids (the reviewer verifies the subtopic on the next review).

## Phase 4a — every question type in review screens, papers, PDF and export (migration 041)

| Gap | Change | Verified |
|---|---|---|
| Syllabus versions screen crashed (`JSON.parse` on JSONB `extracted_units`); any render error blanked the app | content shown whatever its form; `ErrorBoundary` around the app and around the main area (top bar stays usable); unhandled promise rejections shown as a dismissible message | lint/build; manual; since phase 5 the e2e suite renders the screen with every state and content shape (null, JSON text, object, plain text) |
| Reviewers / HOD saw only the question text | lifecycle list, HOD attention list and review-batch detail return the full question (options, key, `answer_data`, model answer, subtopic) and its clean attachments (`paper-attachments.js` `QUESTION_ATTACHMENTS_SQL`); `QuestionView` shows the type, a case study's case first, code in monospace, the per-type body with the key highlighted (letter- or text-stored MCQ keys), the model answer and images inline; canonical record viewable from the lifecycle and batch screens | route tests (SQL shape), smoke (lifecycle attachments on Postgres) |
| Validator / COE paper views showed text only; no diagrams | per-type body and answer key from the snapshot; 041 snapshots record each question's clean attachments (id, name, type, hash); `GET /examinations/papers/:id/attachments/:attId` serves only files of that paper's questions, only while the stored file is the recorded one, under `paperAccess` (COE in scope, eligible assigned validator while under validation), `Cache-Control: no-store`; pre-041 snapshots refer only to files older than the paper (`legacy_reference`), never rewritten | route tests (access matrix, hash/quarantine/legacy), smoke (real generation, snapshot, COE 200, validator/HOD/author 403) |
| Teacher form: fill-blank answers re-split on each keystroke; stale data after a type change; no diagram before the first save; `JSON.parse` could throw; MCQ key stored as a letter not highlighted | raw fill-blank text kept separately; `withQuestionType` clears options / key / unused `answer_data` keys; choosing a file saves the draft first, then attaches; guarded parse; letter-aware highlight; diagram input accepts PNG/JPEG only | lint/build; route tests for the server side |
| Draft save stored whatever the client sent | `normalizeQuestionData` (shared with bulk import): MCQ letter → option text, True/False and A/R keys upper-cased, numbers as numbers, fill-blank answers as a trimmed list, unused options / key / `answer_data` keys dropped; validation judges the normal form | unit tests; route tests: create + edit of all 13 types valid and invalid; smoke |
| Notification bell polled with the token from first render; a password change signed the user out | the poll restarts with the current token; `api.js` signs out only when the refused token is still the stored one | lint/build |
| Loading / error states: blank screens and unhandled rejections | `useAsync` has `loading`; `Pending` / `Loading` helpers; every loader and handler in Teacher, Reviewer/HOD, COE, Validator, Admin and Analytics screens reports failures on screen | lint/build |
| Endpoints without UI | added: review-batch disagreements panel (HOD), subtopic management, legacy papers (HOD, read-only, PDF), admin "Sign out everywhere" (`/auth/users/:id/force-logout`), admin override history (`/admin/overrides`), reviewer's offerings (`/academic/my-reviewer-assignments`), canonical record, question-bank export, PDF preview/print. Already present before 4a: batch reassign, COE validator replacement, issue resolve/refer, blueprint detail | lint/build; e2e mock check updated |
| Analytics merged equal CO / unit codes of different offerings; verified and suggested Bloom/CO mixed; no topics; no offering filter | CO, unit, topic and both matrices grouped by offering; Bloom and CO split verified / unverified; by-topic breakdown; offering filter (scope still enforced server-side) | route test; smoke: CO, unit, topic, Unit×Difficulty, CO×Bloom per offering with two offerings sharing CO1/Unit 1/Trees, Bloom verified/unverified and usage, all equal SQL truth |
| Mistake detection checked only MCQ answers; AI review ignored type data | incomplete = `validateQuestionByType(forActivation)` for every type (+ invalid marks, bounded); AI prompt includes each type's data (options + key, A/R statements and choice, value/unit/tolerance, every blank, language/constraints/reference solution, case text); fallback checks per type; the type rules are reported with or without the model | unit tests (`ai-review-content.js`), route test |
| PDF: no diagrams, case after the question, code reflowed, raw MCQ keys, download only | PNG/JPEG diagrams embedded (others named "supplied separately", missing ones reported); case text before the question; programming and fenced code in Courier with indentation kept; answer key per type ("(B) option text", True/False, A/R choice text, value ± tolerance, "Blank n: …"); `?inline=1` (audited `inline: true`) with Preview and Print buttons | unit tests for all 13 types (pdf-text helper), route test, smoke (embedded image, order, key, Courier) |
| Diagram files the PDF cannot print | upload of a non-PNG/JPEG file to a diagram question refused with the reason (audited); 041 quality gate requires a clean PNG/JPEG diagram; ACTIVE diagrams without one are reported by 041 (NOTICE) and the copy-integrity check, not changed | route test, smoke (API 400, gate) |
| No question-bank export | `GET /api/question-bank/export` (teacher: own; reviewer: assigned offerings in scope, never own; HOD: scope; admin/COE/validator 403), `?course_offering_id` checked with `view_analytics`, `?status`, 2000-row cap, audited; same columns as the import template; template has one example per type (13) | unit round trip (13 types), route tests (roles, scope, re-import of the exported file through `/bulk-upload` for all 13 types, template), smoke (row count = SQL truth, teacher own only, out-of-scope 403) |

Behaviour changes: diagram questions accept only PNG/JPEG diagrams (upload and quality gate); stored MCQ keys are option text and stray fields of other types are removed on every save; the lifecycle list returns the full question text (no 300-character cut); analytics CO/unit/topic rows carry `offering_id` / `offering_code`.

Known limitations of 4a: the PDF names (does not embed) WEBP/PDF attachments of non-diagram questions; an export cell holding an answer that itself contains `|` re-imports as two answers; syllabus versioning / remapping is not part of 4a.

## Phase 3 — accounts, authentication and infrastructure security (migration 040 sections D–E, implementer 2)

| Gap | Change | Verified |
|---|---|---|
| Accounts only for admin/hod/reviewer/teacher, no scopes, temp password in the response ("Demo mode") | `routes/users.js`: every role (HOD: teacher/reviewer in its scope), identity (employee_id, full_name), scopes granted in the same transaction, one-time setup code emailed (`account_setup`, redeemed at /auth/password-reset/confirm); `DEV_EXPOSE_ACCOUNT_SETUP_TOKEN` dev-only | route tests (accounts-auth), smoke |
| Deactivation left scopes and sessions alive | route revokes scopes (revoked_by, reason), bumps token_version, burns codes; DB backstop triggers `trg_users_session_epoch`, `trg_users_access_revoked`, `trg_guard_user_scope`; reactivation and admin role change | route tests, smoke (direct SQL deactivation) |
| Login state revealed before the password, `!==` hash compare, dead reset-attempt counter, flat 8h token | generic 401 (unknown / wrong / locked), atomic lock counter, atomic OTP attempts + timingSafeEqual, per-user code caps, reset attempts counted, session ≤ access_deadline everywhere | route + unit tests, smoke |
| TOTP: plaintext secret, re-enrol with a bearer token only, global otplib mutation, no replay protection, step_up_auth_log unused, no limiter | AES-256-GCM sealed secrets (plaintext ones revoked by 040, users re-enrol), re-auth before enrolment with a pending secret, replay-safe step, per-user lockout, step_up_auth_log per user, auth limiter on /totp and /change-password | unit, route tests, smoke |
| OTP delivery defaulted to console and logged plaintext codes | smtp in production (startup refusal otherwise); console only with `DEV_OTP_CONSOLE=masked|reveal` outside production; 503 instead of silent failure | unit, spawned-process tests |
| /api/health/ready unmounted and untruthful; prod fail-safes partial | `routes/health.js` (live/ready/legacy), `runtime-config.js` startup refusals (CORS, SMTP, TOTP key, ClamAV, TRUST_PROXY, Redis, placeholder JWT secret), Redis fail-closed at runtime | unit, route, spawned-process tests, smoke |
| clamdscan CLI, failed files in the main upload dir, no rescan, gate ignored scan status | native clamd protocol, quarantine dir, rescans (author / admin batch / sweeper), gate + submit trigger require clean attachments, download clean-only | unit (fake clamd), route tests, smoke |
| lockdownGate never mounted; 404 scans could trigger lockdown | lockdown enforced in requireAuth (non-admin writes 503, 1h expiry), 404-scan blocks excluded (§37.4), loopback never auto-blocked | route tests |
| Raw errors/pg details in logs, CORS denial = 500 | `errors.js` request ids + generic responses + redacted JSON log lines; CORS denial = no headers | unit, route, spawned-process tests |

## Phase 3 — review fixes (still migration 040, section F)

| Gap | Change | Verified |
|---|---|---|
| A program-limited HOD scope silently covered the whole department | refused by `POST /admin/scopes` and by `chk_user_scopes_hod_department_level`; 040 F1 revokes existing ones (NOTICE). Reviewer checks now pass the program (`authorizeQuestionReview`, academic reads, analytics, `reviewerSeat`, `scopeSql`), so a program-limited reviewer scope is honoured | route tests (program-limited reviewer, admin refusal), smoke (route + CHECK) |
| Revoking a teacher scope replied ok but changed nothing | `DELETE /admin/scopes/:id` refuses teacher scopes (409, points to the HOD's assignment / deactivation); the admin UI shows no Revoke button for them | route test, smoke |
| `/transition`, the batch verdict/complete routes and COE approval told outsiders the question/batch/paper state before authorizing | visibility (`view_question_workflow`, 404 like an unknown id), reviewer scope + seat, COE scope checked first; denials logged | IDOR tests (other department and other campus), route tests |
| HOD reviewer list counted work in other departments | workload subqueries limited to offerings the calling HOD covers | route test (SQL shape) |
| Login lockout raced (stale row, a correct guess cleared a concurrent lock); change-password and authenticator setup had no per-account limit | `password-attempts.js`: one per-account budget, the attempt reserved and the lock decided atomically before verifying; a correct password clears only its own lock; a session that exhausts the budget is signed out everywhere and the owner notified | route tests incl. 30 concurrent guesses |
| Lockdown could be triggered by anyone; auto-blocks were permanent | lockdown only from authenticated attacks (`invalid_totp`, `invalid_dual_control`); auto-blocks expire (`blocked_ips.expires_at`, `AUTO_BLOCK_MINUTES`, default 60; 040 F3 gives existing ones an expiry) | route tests |
| An enabled authenticator could be replaced with the password alone | a current code is required; password enrolment only when `totp_reenroll_required` (040 upgrade, damaged secret, key rotation, or the new audited admin "Reset authenticator" — `POST /academic/users/:id/reset-authenticator`) | route tests |
| Step-up lockout was check-then-insert | lockout check, verification, step consumption and log row in one transaction under a per-user advisory lock (also for enrolment confirm) | route test (lock order) |
| A wrong `TOTP_ENCRYPTION_KEY` of valid length went unnoticed | key check value in `system_state` (`totp-key-check.js`): production refuses to start on a mismatch, readiness reports `mismatch`, step-up/enrolment answer 503 (never a downgrade); `TOTP_KEY_ROTATE=yes` rotates on purpose (audited, secrets cleared) | route tests, spawned-process test |
| Password-reset request timing revealed accounts | the generic answer is sent before any lookup; the work runs after the response | route test |
| A superseded syllabus version could be re-approved and block examinations | only a `pending` version is approved (re-checked under the offering lock) | route tests |
| Assignment-ended scope revocations had no history | `revokeAssignmentScope` records `revoked_at/by` and `revoke_reason = 'assignment_ended'` | route test |
| Production crash-looped when Redis was down at startup | starts fail-closed and not ready, reconnects by itself (`redis.js`); docs and k8s/compose comments aligned | unit test with a fake Redis, spawned-process test |
| Public readiness disclosed degraded protections | production: anonymous callers get only `{status}`; details on the admin System tab | route test, spawned-process test |
| Reactivation, role change and the clean rescan were only mock-tested | smoke steps on Postgres; run-checks points the server at a fake clamd port the smoke test opens after the quarantine checks | smoke |

## Phase 2 — validator workflow and issues (migration 039, implementer 1)

| Gap | Change | Verified so far |
|---|---|---|
| One decision per validator only in route code | `trg_guard_validator_assignment`: a recorded decision never changes, decisions only while VALIDATION_PENDING, assignments are ended (`is_active = FALSE` + `deactivation_reason`), never deleted or reactivated; `paper_validation_reviews` is append-only and keyed by `assignment_id` | route tests; smoke on a throwaway DB |
| Reset left validators unable to decide again | rounds (`validation_round`); the admin reset ends the round (`paper_reset`, kept in `admin_overrides.old_value`) and re-checks the status under the row lock | route tests; smoke (decide → reset → same four → VALIDATED) |
| No single-validator replacement | `POST /examinations/papers/:id/validators/:n/replace` (undecided slots only, reason ≥ 10, every conflict rule re-run in the transaction, other decisions kept); partial unique indexes WHERE is_active | route tests; smoke incl. a decision racing a replacement |
| Conflicts not re-checked at decision time; weak reviewer set | `src/validator-eligibility.js` + SQL `paper_question_authors()` / `paper_question_reviewers()` used at assignment, replacement, listing (`GET /validators?paper_id=`) and inside the decision transaction (403 + audit + COE notification) | unit + route tests; smoke (scope revoked, independence policy) |
| Superseded revisions kept active validators | `trg_end_validator_assignments` ends them on REGENERATED / ARCHIVED (not PRINT_READY → ARCHIVED, which keeps the approval record) | smoke |
| Paper/PDF/answer key visible to validators in any status | `paperAccessFor` (paper-policy.js): validators only while VALIDATION_PENDING or VALIDATED (decide only in VALIDATION_PENDING); COE in scope always | unit matrix; route + smoke |
| Issues reportable in any status, closable twice; VALIDATED dead end | issues reported only in VALIDATION_PENDING/VALIDATED, closed once (resolved/wont_fix, carried_forward by regeneration), never edited/deleted (`trg_enforce_paper_issue_rules`); COE send-back VALIDATED → CHANGES_REQUIRED (`POST /coe/papers/:id/send-back`, needs a `paper_send_backs` row in the same transaction); open issues block COE_APPROVED in the DB | drift test; route tests; smoke |
| Regeneration ignored issues | regenerate runs supersede + issue carry + revision rows inside the generation transaction; flagged questions left out by default (`exclude_flagged_questions`); `issue_resolution` revision row | route tests; smoke |
| No way to ask for the source question to be fixed | `POST /examinations/issues/:id/refer` notifies the offering's reviewers (else HODs) with the COE's note only; never writes the question bank | route tests; smoke |
| No notifications in the validator workflow | assignment, replacement, outcome, new issue, closed issue, send-back, supersession, reset, validator deactivated / lost scope | route tests |

Known limitation: two accounts of one person cannot be linked (employee_id is unique per account), so the independence rule compares user ids.

## Phase 2 — review fixes (still migration 039)

| Gap | Change | Verified |
|---|---|---|
| COE checks were campus-only, so a program-limited COE could read answer keys, assign, approve, send back, archive, print and save blueprints for another program's examination | `paper-access.js` `coeCovers` = `user_has_scope(coe, campus, department, program, offering)` for paper access, `approve_paper_coe`, `assign_validator`, generation, blueprint save/list/detail, print-ready; examination/paper/blueprint/offering lists filtered by the same rule; validator scope also checked against the whole context | route tests (other program of the same campus → 403, the full context passed); smoke (second COE scoped to another program: every action 403, lists exclude) |
| A validator who lost scope, was deactivated or became conflicted kept the paper, the answer key and issue reporting | `paperAccess` re-runs `validatorProblems` for validators (403 with the reason); the issue route re-checks under the paper row lock; `enforce_paper_issue_rules` requires an active validator with validator scope for the examination; `my-validations.can_open` includes the scope | route tests; smoke (scope revoked → paper, answer key, API and raw-SQL issue all refused) |
| Regenerate read the flagged questions before the lock | `prepare(txn)` reads them after the parent row lock and returns `{ excludeQuestionIds }`; revision and audit rows record that list | route test (order); smoke (issue closed while the regenerate waits on the lock → nothing excluded) |
| No path to revise a PRINT_READY paper (§28) | `POST /examinations/papers/:id/revise` (PRINT_READY, reason ≥ 10): new revision with the printed paper as parent + `paper_revisions` row; the printed paper stays PRINT_READY until the revision is printed, when print-ready archives it in the same transaction. Per examination: ≤ 1 paper in progress (`LIVE_PAPER_STATUSES` no longer includes PRINT_READY) and ≤ 1 PRINT_READY paper (deferred trigger also on status updates). `/generate` refuses while a printed paper exists (use Revise) | unit drift tests; route tests; smoke (revise → validate → approve → print archives v2; second revision 409) |
| Admin reset could overturn a CHANGES_REQUIRED verdict | `OVERRIDE_RESET_FROM` drops CHANGES_REQUIRED; the reset also refuses a VALIDATION_PENDING round holding a CHANGES_REQUIRED decision (route, lifecycle trigger and assignment guard) | unit + route tests; smoke (API 409 and both DB paths) |
| A recorded decision could be ended by a replacement if the route lock were removed | `guard_validator_assignment`: a decided assignment ends only as paper_reset/paper_regenerated/paper_archived | smoke (raw replaced/reassigned refused; deterministic non-final decision vs replacement race) |
| Send-back, issue report/resolve/refer audited after commit | audit row written inside each transaction as its last statement; notifications after commit | route tests (order; failed audit → no notification) |
| DRAFT banner missing on answer-key and overflow pages | stamped on every buffered page before `doc.end()` | unit (every page of a 9-page draft incl. answer key; none on PRINT_READY/archived print); smoke (sectioned draft with answer key) |
| Recency ignored archived printed papers | `loadRecentlyUsed` counts papers with `locked_at` that are PRINT_READY or ARCHIVED | route test; smoke (both printed papers archived, still recent) |
| Bloom targets only tested in memory | smoke: verified Bloom level differs from the submitted one; 50/50 apply/analyze met exactly; unmeetable analyze 100% → 422, nothing written | smoke |

## Phase 2 — generation concurrency, targets and blueprint integrity, sections in output (migration 039, implementer 2)

| Gap | Change | Verified so far |
|---|---|---|
| paper_version read outside any lock; regenerate superseded its parent after commit; two live papers per exam (the second silently took the first's reservations) | `generatePaper` computes the version under the per-offering advisory lock (`UNIQUE (examination_id, paper_version)`, earlier duplicates exempted by id); **one live paper per examination** (GENERATING…PRINT_READY): `/generate` answers 409 listing it, a second candidate is a regeneration; DB backstop `trg_one_live_paper_per_examination` (deferred, same advisory key; legacy duplicates grandfathered with NOTICE) | route tests (order, 409); smoke (double generate, DB backstops, double regenerate) |
| Retry only once and only on one constraint; reservation races gave 422 | ≤ 3 attempts, same seed, jittered back-off, on 40001/40P01/reservation or version unique violations; lock_timeout 20 s → 409; exhausted retries → 409 (transient), not 422 | route tests (deadlock, bounded, not retried); smoke (forced reservation conflict: retry succeeds; persistent conflict: 422 and no rows left) |
| Regenerate accepted another examination's blueprint (IDOR) | blueprint looked up by id AND the paper's examination (400 otherwise); any version of the same exam may be chosen (UI selector) | route + smoke |
| Audit chain could fork under concurrent writers; generation audit after commit | `logAudit(entry, txn?)` takes `pg_advisory_xact_lock('audit_log:chain')` before reading the last hash; generation, regeneration (`paper_superseded`, `paper_issues_carried`), blueprint save, validator assignment/replacement/decision and the admin reset write their audit rows as the last statements of their transaction | route tests (lock before read, in-transaction order); smoke (`/review/audit-log/verify` valid after the concurrent section) |
| Blueprint versions could collide; several active versions | save locks the examination row (`FOR NO KEY UPDATE`); `UNIQUE (examination_id, version_number)` and one active version per examination (data fixed by 039); 23505 → 409 | route tests; smoke (5 concurrent saves → v1..v5, one active) |
| Legacy blueprints stayed soft | a pre-037 (`hard_targets = FALSE`) version **with** CO/Bloom targets is refused (422 `LEGACY_BLUEPRINT`, "Copy into editor" and save a new version); without targets it still generates; `hard_targets` defaults to TRUE and never goes back to FALSE | unit + route + smoke |
| CO keys not checked; Bloom partial rounding could exceed n; weak section/marks checks | CO keys must be active COs of the exam's syllabus version (case-insensitive, stored canonical; re-checked at generate); largest-remainder Bloom counts (≤ n; `coe-gen-2.1`); per-section integer/sum/marks checks; total marks must equal the exam's maximum marks; non-blocking `target_notes` | unit + route tests |
| Overrides self-approved, unrecorded, accepted when not needed | the **generating COE is the approver** (spec §29; authorization action `override_generation_targets`; admin/HOD take no part); accepted only when strict generation fails (`OVERRIDE_NOT_NEEDED`) and minimal (`OVERRIDE_NOT_MINIMAL`); recorded on the paper with original targets, achieved counts and the strict failure, in `paper_constraint_overrides` (insert-only, only while GENERATING) and audited in the generation transaction; shown to validators | unit + route + smoke |
| Used blueprints only partly immutable | `protect_used_blueprint` is a whitelist: only `is_active`/`updated_at` may change on a used blueprint; deleting it is refused | smoke |
| Generation results editable after generation | `format_config`, `candidate_metrics` (incl. resolved targets), `constraint_overrides`, `bloom_realized` join the frozen generation columns | drift test; smoke |
| No feasibility check | `POST /examinations/:id/feasibility` (saved version or draft): verdict, reasons, target vs achieved, minimal override options, seed; never writes, locks or reserves | route test (no writes); smoke (row counts unchanged) |
| Sections in output read the live blueprint; previews showed names only; no internal choice | previews, the validation summary and the PDF are built from the frozen `format_config.sections` (`src/paper-sections.js`, per-section check = the generator's `checkSections` re-run on the snapshot); **internal choice "attempt any k of n"** per section (needs marks each; totals count k); named reasons for per-section shortfalls, sections competing for the same questions and unreachable section totals | unit (incl. PDF text extraction); route test; smoke "Multi-section paper" (order, splits, preview, PDF text) |
| Blueprint editor gaps | version list labels (exact/legacy, usage), detail view, copy into editor, client sum checks, feasibility for a version or a draft, override and blueprint selectors on regenerate | lint + build |

Decisions: one live paper per examination; REGENERATED = a superseded revision (a deliberate reading of §26 "CHANGES_REQUIRED ↔ REGENERATED");
the CPU-bound search stays inside the generation transaction (2–3 s worst case, same-offering requests only; a worker thread is phase 3+).
Not implemented: OR-pairs as internal choices; CO/Bloom/difficulty targets count printed questions (a candidate who skips questions may not cover every CO).

## Phase 1 — question workflow hardening (migration 038)

| Gap | Change | Verified so far |
|---|---|---|
| Legacy HOD 'Approve anyway' / reviewer queue + verdict | `POST /questions/:id/review`, `GET /questions/reviewer-queue`, `POST /questions/:id/reviewer-verdict` return 410; UI removed. `GET /questions/queue` is a read-only, HOD-only, `user_scopes`-scoped attention list (author disputes, historical reviewer flags) | route tests; smoke (pending real run) |
| AI review / appeal changed status (§39 inv. 10) | AI review writes `ai_review_notes`/`ai_reviewed_at` only, runs only in DRAFT/SUBMITTED/CHANGES_REQUESTED/RESUBMITTED; the appeal is a dispute note + notification of in-scope HODs, no status change | route tests; smoke (pending) |
| DB transition guard skipped by bridge-derived changes | `trg_question_transition_guard` (AFTER UPDATE, no column list) checks every `question_status` change, requires a reviewer approver (≠ author), retirement fields, the gate on ACTIVE, and a recorded review-round decision for leaving UNDER_REVIEW; the bridge refuses legacy writes on ACTIVE/RETIRED/REJECTED | migration-table sync test; smoke (pending) |
| APPROVED/ACTIVE/RETIRED/REJECTED editable in place | `trg_question_content_lock` + attachment guard (attachments change only in DRAFT/CHANGES_REQUESTED); edits keyed on `question_status` | route tests; smoke (pending) |
| /transition skipped the submit pipeline | SUBMITTED/RESUBMITTED only via `/questions/:id/submit` (one pipeline for submit and resubmit) | route tests |
| Review-batch verdicts did not drive approval | UNDER_REVIEW → APPROVED/CHANGES_REQUESTED/REJECTED only from the question's open review round, once every reviewer completed; derived from the verdicts (split decisions are never averaged); recorded on `review_batch_items.outcome`; batch creation is the HOD's send-to-review; independent review (others' verdicts hidden until you complete) | route tests; smoke (pending) |
| Restore always failed | `validate_question_for_active(id, from)` accepts RETIRED; restore needs a reason, audited as `question_transition_restore`, records `activated_by` | route tests; smoke (pending) |
| Edit after CHANGES_REQUESTED forked the canonical question | edits keep CHANGES_REQUESTED; resubmit appends a version (with `answer_data`, `subtopic`) to the same canonical question and keeps the CO mapping; the change request is stored on the question | route + unit tests; smoke (pending) |
| Bulk import had no canonical/CO; diagrams impossible | confirm creates canonical + unverified `bulk` CO mapping; diagram rows and likely duplicates are imported as DRAFT; subtopics validated; 038 backfills earlier imports | route tests; smoke (pending) |
| Lifecycle history incomplete | `GET /:id/lifecycle` adds create/edit/submit/resubmit/bulk/duplicate/CO-mapping/AI events with a normalised `event` | route test |

## Implementation-prompt pass (migration 037, v5) — `exam-portal-v4-complete-implementation-prompt.md`

| Requirement | Implemented | Verified so far |
|---|---|---|
| 13 question types (spec §8) with type-specific data and rules (§10) | `src/question-types.js` (shared by API, bulk upload, generator, PDF); `questions.answer_data`; DB CHECK + quality gate per type; old `objective`/`subjective` data migrated to `mcq`/`descriptive`, old names still accepted on input; teacher form type picker + type-specific fields; bulk template sheet listing every type | `test-question-types.mjs` 6/6 (incl. drift check vs 037); browser checks |
| Paper sections | `paper_blueprints.sections` (count, marks each, section total, allowed types, difficulty split, instructions; internal choice since 039); validated on save; enforced by the generator; `paper_questions.section_name`; previews and the PDF from the frozen `format_config` (039) | `test-generator-v2.mjs`, `test-paper-sections.mjs`; smoke |
| Hard CO/Bloom targets | Blueprints must meet CO counts and Bloom counts exactly (percentages → exact counts by largest remainder). Exact search proves impossibility for small/tight banks; seeded local search for large ones; deterministic for a seed. Inventory shortfalls are named before searching. Since 039 legacy soft-target versions with targets are refused. | generator tests incl. infeasible-joint and large-bank cases |
| Constraint override recording | COE may relax CO and/or Bloom for one generation with a 10–1000-char reason, only when needed and minimal (039); stored on the paper and in `paper_constraint_overrides`, audited in the generation transaction, shown to validators. Sections, marks and difficulty can't be relaxed. | generator + route tests; smoke |
| Validator rules | Optional policy “validator ≠ reviewer of a question in the paper” (admin toggle, audited); existing: 4 distinct, ≠ COE, ≠ author, one decision per validator | route test |
| Concurrency / reservations (§15) | Generation runs in one transaction with a per-offering advisory lock; in-flight papers reserve their questions (`question_reservations`, unique partial index); other examinations can't pick them; released on PRINT_READY / REGENERATED / ARCHIVED, handed over to another in-flight paper of the same exam if one still uses the question | route test (lock order, reservations); smoke runs two generations concurrently |
| Subtopics | `syllabus_subtopics`, HOD routes, `questions.subtopic`, quality-gate check | smoke (pending) |
| Legacy/academic routes secured | Syllabus unit/topic deactivation had **no scope check** (any HOD could change another department's syllabus) — fixed; syllabus writes are HOD-only (Admin removed) | route tests |
| Security fail-safe | Production never runs without shared rate limiting unless `RATE_LIMIT_STORE=memory` is set deliberately: while Redis is unreachable (at startup too) the backend is not ready and rate-limited requests get 503, and it reconnects by itself; `/api/health/ready` reports the protections actually active (status only to anonymous callers in production). ClamAV already fails closed (unscanned uploads can't be used). | code review only |
| Analytics vs database | Smoke compares status and type counts with SQL | smoke (pending) |
| Lockfiles | **Blocked here** (no network in the build sandbox). `npm install` already created them in the owner's working copy: commit `backend/package-lock.json` and `frontend/package-lock.json`. | — |

Not changed: Phase 6 AI modules. (Internal choices: added in phase 2 as "attempt any k of n"; OR-pairs are not implemented.)

## Third pass — first run on real PostgreSQL (user's machine, Docker pgvector:pg16)
Result of `./run-checks.sh` before this pass: migrations 001–031 + the lifecycle migration applied cleanly, schema check exact,
16/16 unit tests, 60/60 route tests, frontend lint (0 errors, 54 warnings) and build passed. Two failures, both pre-existing:

| Failure | Root cause | Fix |
|---|---|---|
| `npm run seed`: null value in column "is_active" of relation "users" | 025 made `users.status` NOT NULL without a default; its trigger set `is_active` from it. Also broke HOD/admin user creation. | `035_fix_runtime_defaults.sql`: status derived from is_active on insert, two-way sync on update |
| (next in line) users/departments/programs hierarchy columns NOT NULL without defaults | 023/025; the academic routes don't send them | 035: BEFORE INSERT triggers fill them from the parent row, else the default hierarchy |
| (next in line) `questions.bloom_level` CHECK allowed only 'Apply'… | 027; all app code, `canonical_questions` and review batches use lowercase | 035: constraint replaced with the lowercase list, existing values lowercased |
| smoke test: Cannot access 'setup' before initialization | a `const setup` shadowed the `setup()` function (first pivot pass) | renamed; a TypeScript check now confirms no use-before-declaration anywhere |

**Migration numbering.** The user's own database already contains `032_fix_user_status_and_hierarchy_defaults`,
`033_fix_bloom_level_case` and `034_fix_paper_snapshot_trigger` from another working copy (not in this repository).
So this repository's new migrations are numbered after them: `035_fix_runtime_defaults.sql` and
`036_paper_lifecycle_enforcement.sql` (previously 032). Both are idempotent, so they are safe whether or not a database
already has those other fixes. 036 replaces the paper snapshot function with a version that does not have the
variable/alias name clash that 029's version had (the likely subject of `034_fix_paper_snapshot_trigger`).
A fresh database ends with **37** applied migrations; the user's existing database with 40.

**Second real run (v3):** 15/16 steps passed — seed, real-data copy restore + upgrade (no rows lost, quality gate
evaluated on every question), tests, lint, build. Smoke test 45/47. The two failures and their fixes (v4):
- *Admin cannot take academic decisions → 400*: the transition route validated the transition before checking the role,
  so a non-question-bank user got 400/404 and could learn a question's state or existence. Admin, COE and validators
  are now refused (403) before the question is looked up; route test added.
- *Bulk upload → 403*: a teacher assigned to a section of an offering was refused unless the request named that
  section (the UI always sends it, the API test didn't). Without a section the teacher's own assignment is now used.

`run-checks.sh` (repository root) runs everything against a throwaway container on port 5433, and with a backup
argument also restores a copy of real data, upgrades it, and checks that no rows were lost.

## Second pass (migration 032, now 036) — what changed and why
A post-pivot review compared the code against PIVOT_SPEC_V2 and found these gaps. All are addressed in code; none has been executed against Postgres.

| Gap found | Fix |
|---|---|
| A PRINT_READY paper could be unlocked by any `UPDATE` that changed `paper_status` (old trigger only blocked PRINT_READY→PRINT_READY) | `enforce_paper_lifecycle` (036): PRINT_READY may only become ARCHIVED, touching archive fields only; ARCHIVED is frozen |
| Paper states were enforced only in route handlers (§26 "no skipping") | Same trigger enforces the transition table; `src/paper-policy.js` holds the JS copy and `test-paper-policy.mjs` fails if they drift |
| Generation metadata and the question list could change after generation | Trigger freezes seed/version/blueprint/etc.; `paper_questions` writable only while DRAFT/GENERATING; generator now inserts GENERATING → GENERATED in one transaction |
| "All 4 must approve" hard-coded (§27 asks for configurable) | `system_state.required_validator_approvals` (default 4, allowed 3–4), set by admin with reason; frozen onto each paper at validator assignment (`exam_papers.required_approvals`) and enforced by route, `authorize()` and trigger |
| ARCHIVED unreachable | `POST /api/coe/papers/:id/archive` (COE, scope, reason ≥ 10 chars) from GENERATED / CHANGES_REQUIRED / REGENERATED / PRINT_READY |
| COE had no TOTP setup screen; approval impossible from the UI | Shared `components/TotpSetup.jsx`; COE Authenticator tab, banner, and approval card that explains blockers |
| COE could approve with validator issues still open | Approval blocked (409 with reasons) until every issue is resolved/won't-fix — **a design choice beyond the spec** |
| `GET /api/coe/papers/:id/coe-status` readable by any COE/validator/admin (IDOR) | Uses the same `canSeePaper` as the paper itself (`src/paper-access.js`) |
| Legacy `/api/review/papers/:id/hod-approve`, `admin-approve`, `lock` still approved/locked papers via the old `status` column | 410 Gone |
| Legacy `GET /api/papers/:id` had no scope check (any HOD/admin could read any paper, answers included); `PATCH /api/papers/:id` let a HOD edit examination papers | Legacy paper API is read-only, HOD-only, own department, pre-pivot papers only; all legacy writes return 410 |
| Question lifecycle not reachable from the UI (nothing could make a question ACTIVE) | `GET /api/question-bank/lifecycle` (scoped list) + `components/LifecyclePanel.jsx` for teacher/reviewer/HOD; `QuestionStatusBadge` fixed (it used states the DB rejects) |
| Quality gate accepted any non-empty free-text topic (§11) | Topic must be the reviewer-verified topic or match an active topic title in the question's syllabus version |
| Reviewer metadata resolutions didn't record old values (§12) | Audit stores `{field, old_value, new_value}`; reason required when overwriting a verified value; admin removed from review-batch writes |
| No reviewer workload view for HOD (§12) | `/api/academic/reviewers` returns pending/awaiting-activation counts; shown in the assignment dropdown |
| No PDF for new-workflow papers | `GET /api/examinations/papers/:id/pdf` from snapshots (COE in scope, assigned validators); DRAFT watermark until PRINT_READY |
| Legacy `admin_approved` papers were mapped straight to COE_APPROVED by 028 (§38 requires revalidation) | 036 returns them to GENERATED |
| `paper_questions.question_version_id` stored the canonical id | Snapshot stores `current_version_id`; canonical id moved into `metadata_snapshot` (old rows unchanged) |
| CI ran the legacy smoke test and `npm ci` without lockfiles (`package-lock.json` was gitignored) | CI: `npm test` → migrate → seed → `smoke:pivot` → lint → build; lockfiles un-ignored (commit them after `npm install`) |
| Stale scripts | Removed `backend/smoketest.mjs` (legacy flow, now 410), `backend/test-pivot.mjs`, `backend/src/smoke-tests-pivot.mjs` |

## Verified in the authoring environment (no database available) — historical, first passes
| Check | Result |
|---|---|
| Server module graph imports cleanly | pass (was a boot-time crash before) |
| First pass: `npm test` — generator unit tests (6) + HTTP route tests against a scripted fake DB (47) | 53/53 pass (first pass) |
| Second pass: `test-paper-policy.mjs` (10, pure logic + JS/SQL drift check) | 10/10 pass; drift check proven to catch an injected change |
| Second pass: route tests updated + 13 new (60 total) | **written, not run** — the second sandbox had no npm packages |
| Second pass: backend syntax + import graph (esbuild) + unused/undefined identifiers (tsc) | pass, no new warnings |
| Second pass: frontend bundle (esbuild) + server-side render of every changed screen | pass |
| Second pass: browser checks of the new screens against a mocked API (`frontend/e2e/mock-ui.cjs`, Chromium) | 24/24 pass — UI wiring only, not authorization |
| Migration chain simulation, all 35 files in order (tables, columns, indexes, triggers, trigger-function columns, duplicates) | 0 problems; the checker was proven to catch 6 injected faults |
| Static SQL-vs-schema column check on live code | no mismatches (remaining hits are in 3 unwired legacy modules) |
| Backend lint for real-bug rules (undefined names etc.) | 0 |
| Frontend `vite build` / `oxlint` | pass / 0 errors, 56 pre-existing warnings |
| Server-side render of COE, Validator, Admin, Analytics screens | pass |

The route tests cover: question transitions (roles, scope, reviewer≠author, gate, retirement reasons, no IDOR), examination creation,
versioned blueprints, generation (reproducible, fail-with-reasons, never substituting ineligible questions), validator assignment rules,
validator decisions, issues, regeneration, COE approval/TOTP, PRINT_READY, admin, analytics, bulk upload and confirm.
They verify handler logic and which SQL is issued; they do NOT execute SQL.

## NOT yet verified at the time (historical — all of these have since been run: see the phase sections and the acceptance report)
- `npm run migrate` applying `031_pivot_completion.sql` (and 023–030 on a clean DB — never executed by the previous author either)
- `npm run seed`
- `node smoketest-pivot.mjs` (47 checks: every item in spec §40 plus the 036 rules) — first real run pending after the 035 fixes
- Migrations 035/036 trigger behaviour (lifecycle, lock, quality gate, status bridge, usage tracking) — reasoned through, not executed
- The 60 route tests (`npm run test:routes`)
- Real `vite build` and `oxlint` (the bundle and identifier checks above are stand-ins)
- In-browser testing against the real backend

## IMPLEMENTED
- **Boot fix:** `db.js` exports `query`.
- **Migration 031:** `course_offerings.campus_id` / `questions.campus_id` with consistency triggers; `question_usage` + `times_used`/`last_used_at`
  (written by a DB trigger on PRINT_READY); versioned blueprints (+ immutability trigger once used); `slot_number`/`selection_reason`;
  paper revision columns; `admin_overrides`; inactive reviewer releases assignments; legacy `status`⇄`question_status` bridge;
  default syllabus version + reviewer-verified Bloom mirrored onto questions; corrected quality gate; bulk-upload staging.
- **Authorization:** Admin technical-only; reviewer≠author, campus scope and offering assignment derived from DB; submit/assign/activate/retire/restore actions.
- **Lifecycle route** rewritten to the real state machine; reasons required for reject/changes/retire; retirement records who/when/why; history endpoint access-checked.
- **COE generator** (`exam-generator.js`): ACTIVE-only, campus/program/subject/offering/syllabus hard filters, previous-year exclusion,
  exact total marks, difficulty counts, no duplicate canonical question, seeded + reproducible, selection reasons, automated validation (§25),
  fails with explicit reasons and creates nothing.
- **Examination routes:** create (context derived from offering), versioned blueprints, generate, regenerate-as-new-revision,
  list/detail (campus-scoped), validator assignment (exactly 4, conflict rules, no re-assignment after decisions), validator decision with
  checklist (row-locked), issues (report/resolve), `my-validations`.
- **Admin router** (`/api/admin`): system overview, scope grant/revoke, emergency reset-paper override (reason ≥ 10 chars, audited, never approves, cannot touch PRINT_READY).
- **Analytics** (`/api/question-bank/analytics`): status/difficulty/Bloom/CO/unit/type, usage, duplicate candidates, Unit×Difficulty and CO×Bloom gap matrices.
- **Bulk upload:** validate → preview with row-level errors (CO, Bloom, topic-in-syllabus, MCQ fields, duplicates) → confirm → `SUBMITTED`.
- **Namespaces:** `/api/question-bank`, `/api/reviews`, `/api/validators`, `/api/admin` added as aliases; old paths kept.
- **Scopes** auto-granted on teacher/reviewer assignment; reviewer assignment is HOD-only, requires an active reviewer; optional `REVIEWER_CANNOT_TEACH_OFFERING=true`.
- **Seed:** works with the NOT NULL campus hierarchy; creates COE + 5 validators with real passwords and scopes.
- **Frontend:** role routing in `App.jsx`; COE, Validator, Admin dashboards; HOD/reviewer Analytics tab; bulk-upload confirm step.
- **Security hygiene:** legacy HOD/admin/reviewer generator removed (410); placeholder-hash test accounts from migration 030 deactivated;
  auth rate limit configurable via `AUTH_RATE_MAX` (default unchanged, 15).

## CONFIGURATION REQUIRED
- Production refuses to start without: `JWT_SECRET` (≥ 32 chars, not the placeholder), `CORS_ALLOWED_ORIGINS`, `OTP_DELIVERY_PROVIDER=smtp` + `SMTP_HOST/PORT/FROM`, `TOTP_ENCRYPTION_KEY` (32 bytes), `CLAMD_HOST`/`CLAMD_SOCKET`, `REDIS_URL` (or `RATE_LIMIT_STORE=memory`); a `TOTP_ENCRYPTION_KEY` that differs from the key check stored in the database (unless `TOTP_KEY_ROTATE=yes` for one start). A Redis or database that is merely down is reported as not-ready instead. See README "Security configuration and readiness".
- After migration 040 every account that had TOTP enabled must set it up again (plaintext secrets are revoked; the user is notified).
- The COE must enable TOTP before final approval (COE dashboard → Authenticator tab).
- Validation threshold: Admin → Validation policy (default 4 of 4).
- Syllabus versions need units **and topics** before their questions can become ACTIVE (036 topic check); since 042 a version needs at least one unit with a topic and one CO before it can be verified or approved, and ACTIVE questions need a reviewer-verified topic, CO and Bloom level to be generation-eligible (HOD: Manage academics → Question mapping).
- Install with `npm ci` in `backend/` and `frontend/` (Node 22+); keep both `package-lock.json` files with the code — CI and the Docker builds use `npm ci`. The backend's `xlsx` comes from `cdn.sheetjs.com`, so installs need HTTPS access to it as well as to the npm registry.
- In production, create real accounts under Admin → Accounts (COE/validator with their scopes); the seed accounts are dev-only and `seed.js` refuses `NODE_ENV=production`.
- When this folder is put under git: do not commit `node_modules/`, `dist*/` or `.env` (already in `.gitignore`).

## INFRASTRUCTURE REQUIRED
- PostgreSQL 14+ with pgvector; Redis for multi-instance rate limiting; ClamAV for uploads (unchanged from before).

## NOT IMPLEMENTED / KNOWN LIMITATIONS
- (Resolved: the 13 question types (037) are now reviewed, printed and exported per type (041); subtopics exist (037) and are managed by the HOD.)
- `RESERVED` / `BANK_INTERNAL` / `EXAM_ELIGIBLE` flags (§15, "recommended"): not added as flags; reservations (037) and the per-offering lock prevent concurrent papers from sharing a question.
- Optional "validator ≠ reviewer of a question in the paper" rule (§27) not implemented.
- Internal choices are "attempt any k of n" per section only (no OR-pairs); CO/Bloom/difficulty targets count printed questions.
- The CPU-bound generation search runs on the event loop (2–3 s worst case on a 3000-question bank); a worker thread is phase 3+.
- coe-approve and archive still write their audit row after commit (fork-free since 039, but not atomic with the change); print-ready, send-back and the issue routes write it in the transaction.
- CO×Bloom analytics rely on reviewer-verified canonical data; legacy questions without it appear as "unmapped".
- Legacy questions are intentionally NOT auto-promoted to ACTIVE or given a syllabus version (spec §11/§38); the HOD maps them under Question mapping (042).
- Phase 3 removed the unwired legacy modules (`jobs.js`, `duplicate-detection.js`, `syllabus-changes.js`, `ai-provider.js`, `enhanced-security.js`): none was imported by the server, `jobs.js` could not even load (its queue/OCR dependencies are not installed), and each is superseded (`dedup.js`, `errors.js`; syllabus change detection belongs to the syllabus phase). Their tables are kept (spec §38).
- The legacy admin console is still reachable from the Admin "Accounts & structure" tab (department/session/user creation); several `/api/academic` routes still allow admin.
- Teachers submit and resubmit only through Preview → `/questions/:id/submit` (scan, duplicates, canonical, CO); the lifecycle screen offers "withdraw to draft" and "Revise & resubmit" (opens the question in the form).
- Canonical questions orphaned by the pre-038 edit/resubmit bug are not repaired automatically (which submission they belonged to can't be decided reliably).
- Reviewer-verified classification on `canonical_questions` / `question_course_outcomes` is not yet locked once a linked question is ACTIVE.
- `REGENERATED` is used for "superseded revision" (history), not the spec's CHANGES_REQUIRED ↔ REGENERATED loop; the new revision restarts at GENERATED.
- Validator decisions are evaluated once all 4 have decided (no early CHANGES_REQUIRED).
- No load testing or IDOR fuzzing; browser checks run against a mocked API only.
- Pre-pivot papers without a department are no longer readable through the legacy API (data unchanged).

## Verify
Easiest: `./run-checks.sh [path/to/backup.dump]` from the repository root (see docs/development/GETTING_STARTED.md; `DOCKER_BUILD=1` also builds both images). Manually:
```
cd backend && npm ci && npm test        # 120 unit + 367 route tests, no database needed
npm audit --omit=dev --audit-level=high
# migrate on a CLEAN database (twice: the second run is a no-op), and separately on a COPY of real data (spec §38)
npm run migrate && npm run migrate && npm run seed
AUTH_RATE_MAX=500 RATE_LIMIT_STORE=memory DEV_OTP_CONSOLE=masked npm run dev   # terminal 1
npm run smoke:pivot                      # terminal 2 — 348 checks
cd ../frontend && npm ci && npm run lint && npm run build   # lint fails on any warning
npx playwright install chromium && npm run test:e2e         # 87 browser checks against a mocked API
docker build -t exam-portal-backend backend && docker build -t exam-portal-frontend frontend
```
