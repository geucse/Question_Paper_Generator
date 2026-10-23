> **History.** This was the developer README of the project through its development phases. The current overview is the
> repository [README](../../README.md) and the [documentation](../README.md). Kept for its phase history and detailed security notes.

> **Note (PIVOT_SPEC_V2):** parts of this README describe the original workflow, where the HOD generated papers and the
> Admin approved them. That workflow is retired: the COE generates papers, 4 validators review them, and the COE gives
> final approval with TOTP. For the current flow see `docs/development/GETTING_STARTED.md`; for implementation status see `docs/development/PIVOT_STATUS.md`.


# Exam Portal — Phases 1–16: core model, canonical-question architecture, syllabus units/topics, CO/Bloom/Unit-aware reviewer workflow (backend + frontend), reviewer-led candidate generation with real comparison metrics and recommendations, tiered deduplication classification, transaction-safe multi-step writes, real JWT revocation + hardened tokens, pluggable OTP/email delivery, CORS allowlisting, paper blueprints, deployment scaffolding, shared rate limiting, printable papers, password reset, user account management, previous-year paper management, interactive duplicate resolution, least-privilege database access

## Documentation

Complete documentation is in [`docs/`](../README.md):

- **Getting started:** [installation](../getting-started/installation.md), [demo accounts and sign-in](../getting-started/demo-credentials.md), [45-minute guided demo](../getting-started/demo-walkthrough.md)
- **User guides:** [basics](../user-guide/README.md), [Teacher](../user-guide/teacher.md), [HOD](../user-guide/hod.md), [Reviewer](../user-guide/reviewer.md), [COE](../user-guide/coe.md), [Validator](../user-guide/validator.md), [Administrator](../user-guide/admin.md)
- **Reference:** [workflows](../reference/workflows.md), [question types](../reference/question-types.md), [taxonomy](../reference/taxonomy.md), [architecture and security](../reference/architecture.md), [configuration](../reference/configuration.md), [API](../reference/api.md), [testing](../reference/testing.md), [glossary](../reference/glossary.md), [troubleshooting](../troubleshooting.md)
- **Sample syllabus and questions:** [demo data](../demo-data/README.md) (14 subjects, 280 sample questions with answers)

**Just want to run the product and demo it? Read [`docs/development/GETTING_STARTED.md`](GETTING_STARTED.md) instead — this file covers a lot of deployment/infrastructure material (Docker, Kubernetes, CI) that isn't needed to run or demo the app itself.**

This is a working full-stack exam question-bank / paper-authoring portal, being built
out against a much larger specification in phases.

- **Phase 1**: migrated the backend off SQLite onto PostgreSQL and introduced the real
  academic hierarchy (departments → programs → subjects → course offerings → sections
  → teacher assignments).
- **Phase 2**: a real workflow for the Reviewer role, near-duplicate question
  detection beyond exact-text matching, in-app notifications, and an admin/HOD screen
  to build out the academic hierarchy and assign teachers/reviewers.
- **Phase 3**: reusable paper "blueprints" (saved easy/medium/hard distributions),
  multi-candidate paper generation with side-by-side comparison before picking one,
  and syllabus versioning. *(Superseded: the phase 3 rule that approving a syllabus
  sent every approved question back for re-review was replaced in pivot phase 4b by
  targeted change detection — see "Syllabus versioning" below and docs/development/PIVOT_STATUS.md.)*
- **Phase 4**: real ClamAV virus scanning (replacing the earlier dev
  stub), and deployment scaffolding — Dockerfiles, a production docker-compose file,
  Kubernetes manifests, and a CI pipeline.
- **Phase 5** (this update): shared rate-limit state via Redis, fixing the one real
  gap found after Phase 4 — closing out the infrastructure work with something that
  could actually be verified end-to-end in this build environment.

## What's tested vs not — please read this before deploying

Current state (2026-10-22, pivot phase 5; details and the acceptance report in `docs/development/PIVOT_STATUS.md`):

- **Backend**: `npm test` — 120 unit tests and 367 route tests (the route tests run the real handlers against a scripted
  fake database: they check logic and the SQL issued, not its execution). Migrations 001–042 apply on a fresh
  PostgreSQL 16 + pgvector database and are a no-op on a second run. `npm run smoke:pivot` — 348 end-to-end checks
  against a real database and a running server (logins through the real password + OTP flow, papers, validators,
  PDFs, concurrency, database guards). A copy of real data is upgraded and compared by `./run-checks.sh <dump>`.
- **Frontend**: `npm run lint` (oxlint, 0 warnings; any warning fails), `npm run build`, and `npm run test:e2e` —
  87 Playwright checks in headless Chromium against a **mocked** API (UI wiring and request payloads; authorization
  is covered by the backend tests).
- **Dependencies**: installed with `npm ci` from the committed lockfiles; `npm audit` reports 0 vulnerabilities in
  both packages.
- **Docker**: both images (`backend/Dockerfile`, `frontend/Dockerfile`) are built locally and in CI, run as non-root
  users and report healthy when started. The full `docker-compose.prod.yml` stack and the `k8s/` manifests are
  validated as YAML (and with `docker compose config`) but have **not been brought up end-to-end** (real ClamAV
  signatures, SMTP, TLS and a cluster were not available).
- **CI**: `.github/workflows/ci.yml` mirrors `run-checks.sh`; it passes actionlint (with shellcheck) and each of its
  steps was executed locally with the same environment, but it **has not yet run on GitHub's runners**.
- **ClamAV**: the clamd protocol client is tested against a fake clamd (PING, INSTREAM, infected/clean/error replies,
  timeouts) and the fail-closed quarantine path on a real server; detection by a real ClamAV with real signatures
  (e.g. EICAR) has not been exercised here.

Treat everything under "Deploying with Docker Compose" / "Deploying to Kubernetes" below as a carefully-written
starting point to validate on your own server, not as proven-working infrastructure the way the application logic is.

## What's new in Phase 3

- **Paper blueprints**: admin/HOD can save a named easy/medium/hard distribution
  (e.g. "Mid-Sem Standard: 20/20/10") and reuse it instead of retyping counts every
  exam cycle. Admin blueprints are global; HOD blueprints are scoped to their
  department.
- **Multi-candidate paper generation**: request more than one candidate paper (up to
  5) from the same format in one go. Each candidate is drawn independently from the
  approved bank. A side-by-side comparison screen shows every candidate's question
  list; picking one promotes it to the normal draft → HOD approval → Admin approval →
  lock pipeline, and the unpicked candidates are discarded.
- **Syllabus versioning**: the HOD uploads the official syllabus PDF (text extraction, no OCR or AI; see
  "Graphic Era syllabus, HOD workflow and demo data" below) or enters the content directly; only the HOD creates,
  verifies, submits and approves a version. *Current behaviour (pivot phase 4b, migration 042, replacing the original
  "send every approved question back to pending" rule):* a version moves Draft →
  Teacher-verified → In HOD review → Active, and its content is edited only while it is a
  draft. Approving a version supersedes the previous one and compares the two: questions on
  unchanged units/topics/subtopics/COs move to the new version automatically; affected
  APPROVED questions go back to their authors with the change named; affected ACTIVE ones
  stay ACTIVE but are flagged and are not used in new papers until the HOD maps them
  (Manage academics → Question mapping) or a reviewer requests changes. Details in
  `docs/development/PIVOT_STATUS.md` (phase 4b).

## Stack

- **Backend**: Node.js + Express + PostgreSQL (`pg`) with `pgvector`, argon2id
  password hashing, JWT sessions, OTP for login, RFC 6238 TOTP (`otplib`) for
  HOD/Admin's authenticator app.
- **Frontend**: React + Vite, no UI framework beyond the app's own CSS.

## Quick start

```bash
# 1. Start Postgres (local Docker, includes pgvector)
docker compose up -d

# If port 5432 is already taken by a local Postgres install, either:
#   sudo systemctl stop postgresql          (stop the local one), or
#   edit docker-compose.yml's "5432:5432" -> "5433:5432" and update
#   DATABASE_URL in backend/.env to match.

# 2. Backend (Node.js 22+)
cd backend
npm ci                       # exact versions from package-lock.json
cp .env.example .env        # defaults already point at the docker-compose Postgres
npm run migrate              # applies backend/migrations/*.sql (001-042) in order; a re-run is a no-op
npm run seed                 # creates the academic hierarchy + demo users, prints credentials
npm run seed:demo            # optional: 14 subjects of the 2023 CSE syllabus + 280 SAMPLE questions (docs/demo-data/CATALOG.md)
npm run dev                  # http://localhost:4000

# 3. Frontend (separate terminal)
cd frontend
npm ci
npm run dev                  # http://localhost:5173
```

**Local development settings (phase 3)**: the backend no longer pretends to deliver codes or scan files.
Add these to `backend/.env` for a working local setup (all are development-only; production refuses them):
```bash
DEV_OTP_CONSOLE=reveal      # login/reset/setup codes are printed in the backend log (masked with =masked)
RATE_LIMIT_STORE=memory     # optional: skip Redis locally (per-process rate limits)
```
Without `DEV_OTP_CONSOLE` (or real `SMTP_*`), sign-in answers 503 "could not send your sign-in code" by design.
`TOTP_ENCRYPTION_KEY` is optional locally (a development key is derived from `JWT_SECRET`, with a warning).
`JWT_SECRET` must be at least 32 characters in every environment. The full list of settings, and the steps for
upgrading an existing database (back up, then `npm run migrate`, then the post-upgrade tasks), are in
`docs/development/GETTING_STARTED.md` ("Settings you need to know", "Upgrading an existing database").

**About virus scanning in local dev**: uploads are scanned through the clamd protocol
(`backend/src/antivirus.js`, `CLAMD_HOST`/`CLAMD_PORT`). Without a clamd, every upload is stored in
`backend/uploads/quarantine/` with `scan_status: 'failed'` and cannot be opened, submitted or activated
until a rescan clears it (fail-closed, by design). To scan locally:
```bash
docker run -d --name exam-portal-clamav -p 3310:3310 clamav/clamav:1.3   # first start downloads signatures
# then in backend/.env: CLAMD_HOST=localhost
```
Quarantined files are rescanned automatically every 10 minutes (`ATTACHMENT_RESCAN_INTERVAL_MS`), by the
teacher ("Scan again") or by the admin (System -> Upload scanning).

**About Redis in local dev**: optional for one local instance. Outside production an unreachable Redis falls
back to in-process rate limiting with a warning (`RATE_LIMIT_STORE=memory` skips the attempt). In production
the backend still starts when Redis is not up yet, but reports not-ready and answers rate-limited requests
with 503 until Redis is reachable (it reconnects by itself, so there is no crash loop and no start ordering
to get right); `RATE_LIMIT_STORE=memory` is the explicit single-replica opt-out.

**About the least-privilege database role**: also optional for local dev — by
default the app uses the same role that owns the schema for everything. To try the
hardened setup:
```bash
psql -d examportal -f backend/deploy/create-app-role.sql   # as a superuser
# then set in backend/.env:
APP_DATABASE_URL=postgres://examportal_app:change-this-password@localhost:5432/examportal
```
`npm run migrate` keeps using `DATABASE_URL` (the owner role) regardless — only the
running app (`npm run dev`/`npm start`) picks up `APP_DATABASE_URL` when set.

## Graphic Era syllabus, HOD workflow and demo data

- **The official syllabus is the HOD's.** The HOD uploads the department's syllabus PDF for a course offering
  (Review workspace → Manage academics → Syllabus versions → "Upload the official syllabus (PDF)"). The server reads
  the text (`src/pdf-text-extract.js`; no OCR, scanned PDFs are refused with a message), finds the course by its subject
  code (`src/syllabus-parse.js`) and creates a **draft** version with the course outcomes, units, contact hours and
  topics exactly as printed, plus any warnings. The HOD reviews and corrects it, then confirms, submits and approves it;
  nothing is published by the upload. Teachers and reviewers can read the syllabus and open the official PDF but cannot
  create, replace, verify or approve it (the API refuses them; the route tests check it).
- **Questions** are written against the active version: each on a syllabus topic, mapped to that subject's own COs.
  Reviewers confirm a checklist (syllabus alignment, correctness, clarity, CO, Bloom, difficulty, answer key, marks)
  before accepting.
- **Papers** print in the institution's format; the internal copy adds a CO / Bloom / unit / difficulty analysis page.
- **Demo data:** `npm run seed:demo` builds 14 theory subjects from the official 2023 CSE syllabus with 20 sample
  questions each, through the normal API as each role. Everything about it (sources, counts, recorded HOD decisions,
  scenarios A-F) is in [docs/demo-data/CATALOG.md](../demo-data/CATALOG.md). All generated questions are DEMO / SAMPLE content.
- Upload API: `POST /api/academic/course-offerings/:id/syllabus-upload` (multipart field `file`, PDF up to 25 MB, HOD in
  scope); `GET /api/academic/syllabus-versions/:id/extraction` and `/source` for the extraction record and the PDF.

## Demo credentials (created by `npm run seed`)

`npm run seed:demo` adds `reviewer2@portal.edu`, `reviewer3@portal.edu` and `reviewer.ece@portal.edu` (ECE department,
for out-of-scope checks), password `Review@123`.

| Role | Email | Password |
|---|---|---|
| Admin | admin@portal.edu | Admin@12345 |
| HOD | hod@portal.edu | Hod@12345 |
| Reviewer | reviewer@portal.edu | Review@123 |
| Teacher | teacher1@portal.edu | Teach@123 |
| Teacher | teacher2@portal.edu | Teach@123 |
| Teacher | teacher3@portal.edu | Teach@123 |
| Teacher | teacher4@portal.edu | Teach@123 |

All logins require password **and** a one-time code, emailed through `OTP_DELIVERY_PROVIDER=smtp`. For local
development set `DEV_OTP_CONSOLE=reveal` and read the code from the backend log (it is never in an API
response). Production refuses console delivery. See `backend/src/otp-delivery.js` and `backend/.env.example`.

New accounts are created under **Accounts** (admin: every role with its scopes; HOD: teachers and reviewers of
its department). The person receives a one-time setup code by email and chooses a password on the sign-in page
under **Set up a new account**; no password is ever shown to the administrator.

**Before COE approval will work**: sign in as `coe@portal.edu`, open the authenticator setup, enter the current
password, link an authenticator app and confirm a code. Secrets are stored encrypted (`TOTP_ENCRYPTION_KEY`), each
code works once, and 5 wrong codes lock step-up for 15 minutes.

Seeded academic data: one department (CSE) → one program (B.Tech CSE) → two subjects
(DSA101, OS201) → two course offerings (2026-2027) → two sections (A, B) under
DSA101. `teacher1` is deliberately assigned to **both** offerings so the
frontend's course-offering picker (not just the single-offering banner) actually
has something to pick between. `reviewer@portal.edu` is assigned to review the
DSA101 offering.

## Security configuration and readiness (phase 3)

Production (`NODE_ENV=production`) **refuses to start** (exit 1, naming the variable, never its value) when:

| Setting | Rule |
|---|---|
| `CORS_ALLOWED_ORIGINS` | required; bare origins only (no `*`, paths or trailing slash) |
| `OTP_DELIVERY_PROVIDER` / `SMTP_*` | must be `smtp` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` (user/pass together or both empty); `DEV_OTP_CONSOLE` and `DEV_EXPOSE_ACCOUNT_SETUP_TOKEN` must be unset |
| `TOTP_ENCRYPTION_KEY` | required, 32 bytes as hex or base64 (`openssl rand -hex 32`) |
| `CLAMD_HOST`/`CLAMD_PORT` or `CLAMD_SOCKET` | required (`CLAMD_CONFIG_PATH` is no longer used) |
| `TRUST_PROXY` | must not be `true` (hop count, default 1) |
| `RATE_LIMIT_STORE` / `REDIS_URL` | `REDIS_URL` required unless `RATE_LIMIT_STORE=memory` (single replica). An *unreachable* Redis is not a refusal: the backend starts not-ready, answers rate-limited requests with 503 and reconnects by itself (no crash loop) |
| `JWT_SECRET` | at least 32 characters and not the example placeholder |
| `TOTP_ENCRYPTION_KEY` vs. the database | the key must match the key check stored in `system_state` on first start (a regenerated or mistyped key of valid length would make every stored authenticator unreadable). To rotate deliberately, start once with `TOTP_KEY_ROTATE=yes` (audited; every authenticator must be set up again), then remove it. A database that is down at startup only defers this check |

`GET /api/health/ready` reports what actually protects the system and answers **503** only when a required check
fails (production: database, rate-limit store, SMTP delivery configured, TOTP key present and matching the stored key
check, ClamAV configured; development: database). In production an anonymous caller gets only `{"status": ...}` with
the status code (probes need nothing more); the full report (`checks`, `protections`, `failing`) is on the admin's
System tab (`GET /api/admin/system`). A ClamAV *outage* is reported as `degraded` with 200, because uploads stay quarantined (fail-closed)
and a 503 would pull every pod out of service on a scanner restart. `GET /api/health/live` is process-only (k8s
liveness); `GET /api/health` keeps its `{ok, db}` answer. Bodies contain fixed tokens only, never error text.

Other phase 3 rules: login answers the same generic 401 for an unknown email, a wrong password and a locked account;
every password check of an account (sign-in, change-password, authenticator setup) spends one budget of 5 attempts
per 15 minutes, reserved atomically before the password is verified, so concurrent guesses from many addresses
cannot exceed it; when a signed-in session uses up the budget, every session of the account ends and the owner is
notified. Replacing an enabled authenticator needs a current code from it (the password alone never removes the
second factor); someone who lost it asks the admin to "Reset authenticator" (audited, ends their sessions, notifies
them), after which the password is enough to enrol a new one. Sessions never outlive `access_deadline`; deactivation
and role changes revoke scopes and end sessions (also enforced by database triggers, migration 040). Automatic IP
blocks expire after `AUTO_BLOCK_MINUTES` (default 60). The lockdown mode pauses non-admin changes for up to an hour
and is triggered only by attacks from signed-in sessions (wrong authenticator codes, failed dual-control
approvals), never by failed logins, OTP/reset-code guessing or 404 scans, which anyone can produce. HOD scopes cover
a whole department (a program-limited HOD scope is refused); teacher scopes follow the HOD's course assignments
and cannot be revoked by the admin. Errors reach clients as generic messages with a `request_id`, and logs never
carry pg row details, request bodies or codes. `seed.js` refuses `NODE_ENV=production`.

Removed legacy modules (never imported by the server; their tables are kept): `jobs.js` (could not even load:
bullmq, pdf-parse, mammoth and tesseract.js are not dependencies), `duplicate-detection.js` (superseded by
`dedup.js`), `ai-provider.js` (used only by those), `syllabus-changes.js` (diffed a JSON column nothing fills;
syllabus change detection belongs to the syllabus phase) and `enhanced-security.js` (unused; replaced by
`errors.js`).

## Project layout

```
docker-compose.yml         Local Postgres (with pgvector) for development
docker-compose.prod.yml    Production compose: Postgres, Redis, ClamAV, migrate step, backend, frontend
.env.prod.example          Template for docker-compose.prod.yml secrets
k8s/                       Kubernetes manifests (see "Deploying to Kubernetes" above)
.github/workflows/ci.yml   Same steps as run-checks.sh: npm ci, audit, tests, migrate x2, seed, smoke, lint, build, e2e, docker build
run-checks.sh              Every check against a throwaway Postgres on port 5433 (optionally a copy of real data)
backend/
  Dockerfile               Production image: npm ci --omit=dev, runs as `node`, HEALTHCHECK /api/health/live (clamd over TCP)
  deploy/create-app-role.sql   one-time DBA script for the least-privilege runtime role
  migrations/             Sequential, tracked SQL schema files
    001_extensions.sql              pgcrypto, vector
    002_academic_hierarchy.sql      departments, programs, subjects, sessions
    003_users_and_security.sql      users (admin/hod/reviewer/teacher), OTP, audit, blocklist
    004_course_offerings.sql        course_offerings, syllabus_versions, sections, teacher assignments
    005_questions_and_papers.sql    questions, attachments, papers, bulk upload batches
    006_reviewer_and_notifications.sql   reviewer_assignments, reviewer_verdicts, notifications, question embeddings
    007_paper_blueprints_and_candidates.sql   paper_blueprints, paper_generation_requests, candidate paper status
    008_paper_print_fields.sql                duration_minutes, instructions on exam_papers
  src/
    db.js                 Postgres connection pool + get/all/run/withTransaction helpers
    migrate.js             applies un-applied migrations, tracked in schema_migrations
    embeddings.js            local lexical embedding for near-duplicate detection
    antivirus.js              ClamAV over the native clamd protocol (PING / INSTREAM), fails closed
    attachment-scan.js        quarantine, rescans (author, admin batch, background sweeper)
    runtime-config.js         production configuration refusals + readiness evaluation
    errors.js / redact.js     request ids, central error handler, credential redaction for logs
    secret-box.js             AES-256-GCM sealing of TOTP secrets (TOTP_ENCRYPTION_KEY)
    totp.js                   TOTP step-up: replay protection, lockout, enrolment with re-authentication
    accounts.js               account provisioning helpers (identity, scope plans, invitations)
    paper-pdf.js               streams the actual printable exam paper PDF
    redis.js                   Redis-backed rate-limit store; production requires Redis and fails closed (503) during an outage
    notifications.js          in-app notification helper
    auth.js                 password/OTP/TOTP helpers (unchanged — DB-agnostic)
    audit.js                 hash-chained audit log
    middleware.js             auth + role + deadline enforcement
    security.js                rate limiting, IP auto-block, lockdown mode (enforced in requireAuth)
    routes/
      auth.js                login (password + OTP), TOTP setup
      academic.js              hierarchy CRUD (admin/HOD), teacher/reviewer assignment, my-assignments, syllabus versions
      questions.js              draft, preview, submit, review, reviewer queue/verdict, mistake detection
      attachments.js             file upload/validation/serving, real virus scan
      bulk.js                    Excel/CSV bulk import, offering-scoped
      papers.js                   blueprints, multi-candidate generation, comparison/selection, PDF export, independent approval hooks
      review.js                    independent HOD/Admin approval, lock, audit log endpoints
      notifications.js            list/mark-read in-app notifications
    seed.js                creates demo academic hierarchy + users
  smoketest-pivot.mjs     end-to-end test (run with `npm run smoke:pivot` while the server is running)
frontend/
  Dockerfile               Multi-stage build (npm ci) -> unprivileged nginx on port 8080, HEALTHCHECK /healthz
  nginx.conf                SPA routing + /api proxy to the backend container + /healthz
  e2e/mock-ui.cjs           Playwright browser checks against a mocked API (npm run test:e2e)
  src/
    Login.jsx                 two-step password+OTP login
    NotificationBell.jsx        bell icon + dropdown, polls unread count
    TeacherDashboard.jsx        question compose/preview/bulk-upload, offering-aware
    ReviewerDashboard.jsx        HOD attention list (read-only), review batches + decisions, manage academics, audit
    App.jsx, api.js, index.css
```

## Running the smoke test

With the backend running (`npm run dev` in `backend/`), from another terminal:

```bash
cd backend
npm run smoke:pivot
```

It needs `DATABASE_URL` (it signs in through the real password + OTP flow and overwrites
the stored OTP hashes with known codes) and the same `JWT_SECRET` as the server. It runs
348 checks of the current workflow (PIVOT_SPEC_V2 §40): question lifecycle and review
batches, the quality gate, syllabus versions and re-mapping, COE examinations,
blueprints with sections and CO/Bloom targets, generation (including concurrent runs),
four validators, COE approval with TOTP, PRINT_READY and PDFs, analytics against SQL
truth, scoping denials, database guards and the audit hash chain. `run-checks.sh` and CI
start the server with the settings it expects (`AUTH_RATE_MAX=500`, `GLOBAL_RATE_MAX=5000`,
`RATE_LIMIT_STORE=memory`, `DEV_OTP_CONSOLE=masked`, a clamd port where the test starts
a fake clamd); with the default auth limit (15 requests/15 min) repeated runs answer `429`.

## What's new in Phase 4

- **Real ClamAV virus scanning** (`backend/src/antivirus.js`), replacing the old
  stub that unconditionally marked every upload `clean`. (Phase 3 replaced the `clamdscan` CLI with the native
  clamd protocol over TCP/unix socket, `CLAMD_HOST`/`CLAMD_PORT`, and added quarantine and rescans.)
  **Fails closed**: if clamd is unreachable, times out, or isn't installed, the
  scan result is `failed`, never `clean` — and the existing submit-blocks-on-non-clean
  logic means a scanner outage blocks question submission rather than silently
  letting an unscanned file through.
- **Deployment scaffolding**:
  - `backend/Dockerfile`, `frontend/Dockerfile` (multi-stage, served by nginx)
  - `docker-compose.prod.yml` + `.env.prod.example` — Postgres, ClamAV, a one-shot
    migration step, backend, and frontend wired together
  - `k8s/` — namespace, secret/configmap templates, Postgres StatefulSet, ClamAV
    Deployment, a migration Job, backend Deployment+Service+HPA, frontend
    Deployment+Service, and an Ingress
  - `.github/workflows/ci.yml` — originally migrate, seed, smoke-test and build; since pivot phase 5 it mirrors
    `run-checks.sh` (see "Project layout")

### Deploying with Docker Compose

```bash
cp .env.prod.example .env.prod   # fill in real DB_PASSWORD and JWT_SECRET
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

The `clamav` container downloads its own virus definitions on first boot, which
needs outbound internet access to `database.clamav.net` — confirm your network
allows that (the ClamAV container itself has not been exercised by the automated
checks, which use a fake clamd). The frontend container runs nginx as a non-root
user on port 8080; `FRONTEND_PORT` (default 80) is mapped to it. The `migrate` service runs once and exits; rerun it after
adding new migration files with:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate
```

### Deploying to Kubernetes

```bash
kubectl apply -f k8s/00-namespace.yaml
# Copy k8s/01-secret.example.yaml to k8s/secret.yaml, fill in real base64 values, then:
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/02-configmap.yaml
kubectl apply -f k8s/03-postgres.yaml
kubectl apply -f k8s/04-clamav.yaml
kubectl apply -f k8s/04b-redis.yaml
kubectl apply -f k8s/05-migrate-job.yaml   # rerun after adding new migrations
kubectl apply -f k8s/06-backend.yaml
kubectl apply -f k8s/07-frontend.yaml
kubectl apply -f k8s/08-ingress.yaml
```

You'll need to build and push `exam-portal-backend` and `exam-portal-frontend`
images to a registry your cluster can pull from, then update the `image:` fields in
`06-backend.yaml` and `07-frontend.yaml` accordingly (the pods run as non-root: backend uid 1000 with
`fsGroup: 1000` for the uploads volume, frontend uid 101 on port 8080 behind a Service on port 80) — the CI
workflow builds both but does not currently push them anywhere (add a registry login + push step for
your specific registry, e.g. GHCR or Docker Hub, to close that gap).

## What's new in Phase 5

- **Shared rate-limit state via Redis**, fixing the one real gap identified after
  Phase 4: account lockout, suspicious-activity tracking, and lockdown mode were
  already Postgres-backed and correctly shared across replicas — but
  `express-rate-limit`'s default store is in-process memory, which is wrong once
  more than one backend replica is running (as the Kubernetes deployment's 2+
  replicas do). `backend/src/redis.js` now builds a Redis-backed store for both
  rate limiters at startup. **Fails soft, not closed, here on purpose** — unlike
  ClamAV (where "scanner down" should block the action), a Redis outage blocking
  every request would be worse than temporarily falling back to per-process
  limiting, so if Redis is unreachable within a 2-second timeout, the app logs a
  clear warning and falls back rather than refusing to boot. *(Superseded: in
  production the store now fails closed instead — see "About Redis in local dev"
  above; the per-process fallback remains for development only.)*
  This was verified for real in the build environment: killed Redis and confirmed
  the server still boots and serves traffic with the documented warning; started
  Redis and confirmed the connection message, then inspected Redis directly with
  `redis-cli` to confirm keys are actually being written with accurate counts and
  correct TTLs (not silently falling back while claiming to be connected); and
  confirmed enforcement still fires at the exact right threshold (a 16th rapid
  request correctly got `429` while the first 15 didn't). Wired into
  `docker-compose.prod.yml`, `k8s/04b-redis.yaml`, and the CI workflow.

## What's new in Phase 6

- **Actual printable exam paper PDFs** (`backend/src/paper-pdf.js`), addressing a
  real gap: every prior phase only produced the *question composition* (a JSON list
  of questions) with no way to get an actual document a teacher/invigilator could
  print or distribute. `GET /papers/:id/pdf` now streams a formatted PDF: header
  (institution/department/subject/program/session), max marks, duration and
  instructions (settable via `PATCH /papers/:id`, added this phase), numbered
  questions with marks and objective options, and an optional answer-key appendix
  (`?include_answers=1`, gated to admin/HOD by the same role check as everything
  else on this route — no separate weaker permission path).
  **A non-locked paper gets a visible diagonal "DRAFT — NOT FOR DISTRIBUTION"
  watermark on every page** — printing or handing out a draft as if it were final is
  exactly the kind of mistake this makes hard to do by accident. Once a paper is
  `locked`, the watermark is gone and duration/instructions can no longer be edited
  (`PATCH` returns 400).
  This was verified by actually generating PDFs end-to-end and inspecting the real
  output — not just checking that bytes came back. Used `pdftotext`/`pdfinfo`
  (already available in this environment) to confirm question text, marks,
  duration, and instructions all appear correctly, that the answer key only shows
  up when requested, and that the draft/locked versions differ correctly. Also
  **rasterized pages to images and visually inspected them**, which caught and let
  me fix a real layout bug (the draft watermark's rotated text was leaving a large
  blank gap before the header — pdfkit's `rotate()`/`text()` had shifted the
  document's internal cursor position, not just the watermark's own drawing).

## What's new in Phase 7

- **Password reset and change**, closing a real gap: there was previously no way
  for anyone — self-service or admin-assisted — to reset or change a password once
  the account existed. Now:
  - `POST /auth/password-reset/request` + `POST /auth/password-reset/confirm` — a
    self-service "forgot password" flow using the same single-use, hashed,
    expiring-token pattern as login OTP. Deliberately returns the same generic
    response whether or not the email exists, so the endpoint can't be used to
    enumerate accounts.
  - `POST /auth/change-password` — an authenticated user changing their own known
    password, requiring the current password to be provided.
  - New password strength rules (`validatePasswordStrength` in `auth.js`): at least
    10 characters, upper + lower case, a number, and not containing the account's
    email username. Applied to resets and changes, not to the existing demo seed
    data (which bypasses this check the same way it already bypasses login rate
    limits — it's fixture data, not something a real user typed).
  - **Completing a password reset clears any existing account lockout** — proving
    control of the reset channel is treated as sufficient to end a lockout rather
    than making someone wait out the timer afterward.
  - Frontend: a "Forgot password?" link on the login screen (with the same
    dev-mode token-in-response banner pattern as login OTP, clearly labeled as such)
    and a "Change password" option in the top bar for any logged-in user.
  This was verified with real end-to-end tests: wrong-token rejection, weak-password
  rejection, successful reset immediately allowing login with the new password (and
  rejecting the old one), reset tokens correctly single-use (rejected on reuse),
  wrong-current-password rejection on the authenticated change endpoint, and —
  tested in isolation to rule out cross-test rate-limit interference — a real
  account lockout being cleared by a successful reset. Also reconfirmed the full
  prior regression suite passes from a completely fresh `npm install`.

## What's new in Phase 8

- **User account management**, closing an even more fundamental gap than password
  reset: there was previously **no way to create or deactivate a user account
  anywhere in the application** — only by hand-editing `seed.js` and re-running it.
  That meant an admin couldn't actually onboard a new semester's teachers or
  offboard someone who'd left, through the product itself.
  - `POST /academic/users` — admin can create any role in any department; HOD can
    only create teacher/reviewer accounts, and only within their own department
    (enforced server-side, not taken from the request body). Generates a temporary
    password and flags the account `must_change_password`.
  - **Server-side enforcement, not just a frontend nag**: `middleware.js`'s
    `requireAuth` blocks every endpoint except `/auth/change-password` and
    `/auth/me` while that flag is set — a newly-provisioned account genuinely
    cannot touch anything else until it sets its own password, regardless of what
    the client does or doesn't show.
  - `POST /academic/users/:id/deactivate` / `/reactivate` — a deactivated account
    can't log in at all (checked in the password-login step); reactivating also
    clears any lingering lockout. A user can't deactivate their own account
    (guards against accidentally locking yourself out with no one else able to
    undo it).
  - `GET /academic/users` — admin sees everyone; HOD sees teacher/reviewer accounts
    in their own department only.
  - Frontend: a new "User accounts" tab under Manage academics, and the login flow
    now force-shows a non-dismissable change-password screen (no way to reach the
    rest of the app) whenever `must_change_password` is true — matching the
    backend enforcement rather than just hoping the user notices a prompt.
  Verified with 14 real end-to-end scenarios: role-scoping (HOD blocked from
  creating admin accounts), duplicate-email rejection, the temp-password login
  correctly carrying `must_change_password: true`, that account being genuinely
  blocked from an unrelated endpoint (not just told to change its password),
  `/auth/me` staying reachable throughout, the flag clearing correctly after a
  real password change, deactivated accounts being fully locked out of login,
  self-deactivation being blocked, and reactivation correctly restoring access.
  Then reconfirmed the entire prior regression suite from a completely fresh
  `npm install`.

## What's new in Phase 9

- **Previous-year paper management**, closing the same "no CRUD" gap pattern found
  twice already (academic hierarchy in Phase 2, user accounts in Phase 8) — this
  time on the table that actually powers the system's headline feature: "never
  repeat last year's question." There was no way to add real historical questions
  to it anywhere in the app; only `seed.js` could populate it, and even then it only
  stored an opaque hash with no visible text.
  - `POST /academic/previous-year-papers` — paste in a batch of questions (one per
    line) for a given course offering and year; each gets hashed and stored,
    duplicates within the same offering are silently skipped and reported back.
  - `GET /academic/previous-year-papers` / `DELETE .../:id` — list and remove
    entries, scoped by department the same way as everything else admin/HOD manage.
  - **The stored data is now actually useful, not just a hash**: added
    `question_text`, `added_by`, and `created_at` columns. Duplicate warnings shown
    to a teacher (both in the question preview and the mistake-detection report)
    now say *which year* and show the *actual matched text*, instead of a generic
    "this appeared in a previous year" with no way to verify or investigate it.
  - Frontend: a new "Previous-year papers" tab under Manage academics.
  Verified end-to-end: batch add with a blank line correctly skipped, re-submitting
  the same question for the same year correctly detected and skipped as a
  duplicate (not double-counted), the enriched warning correctly showing the real
  year and text on both the teacher's preview screen and the HOD's mistake-detection
  view, deletion working and reflected immediately, and non-admin/HOD roles
  correctly rejected. Then reconfirmed the full prior regression suite from a
  completely fresh `npm install` (all 10 migrations apply cleanly).

## What's new in Phase 10

- **Interactive duplicate resolution**, closing a gap found by comparing this build
  against the original specification rather than just inventing more features:
  the spec describes a full canonical-question architecture
  (`canonical_questions`/`question_versions`/`question_relationships`) with an
  explicit teacher-facing resolution flow — show both questions side by side with
  a similarity score, let the teacher choose **[Use Existing Question] / [This Is
  Different] / [Edit Submission]**. Phase 2 built duplicate *detection* but never
  gave anyone a way to *act* on it — a flagged near-duplicate just sat in the bank
  forever with an unresolvable warning attached.
  - New `question_relationships` table (matching the spec's shape: source/target
    question, relationship type, similarity score, method, reviewer, status).
  - `GET /questions/:id/preview` now returns a structured `possible_duplicate`
    object (target question, similarity, classification) instead of only a plain
    warning string, and `can_submit` is `false` while it's unresolved.
  - `POST /questions/:id/duplicate-decision` — **"Use Existing Question"** withdraws
    the teacher's own draft (new `withdrawn_duplicate` status, distinct from an
    HOD/admin `rejected` decision) and records the relationship as confirmed;
    **"This Is Different"** records it as dismissed and the question can now be
    submitted normally, without re-prompting on that same pair again.
  - **Enforced server-side in `/submit` too**, not just via the preview screen's
    `can_submit` flag — a teacher can't bypass the resolution step by calling
    `/submit` directly without ever loading `/preview`. Similarity is recomputed
    server-side rather than trusted from the client.
  - Frontend: the exact side-by-side card the spec describes, right in the
    question preview screen.
  This was verified with real, carefully-chosen test phrasings — an earlier draft
  of the test used two questions that were similar in *meaning* but not
  *wording* ("Describe how X works" vs. "Explain the working of X"), which
  correctly scored 0.56 similarity and did **not** trigger the flow. That's not a
  bug — the lexical embedding is honestly documented as catching reworded/reordered
  text, not deep semantic equivalence — but it meant the first test attempt was
  wrong, not the code. Recomputed real similarity scores with the embedding
  function directly, picked phrasing that genuinely lands just above the 0.85
  threshold, and confirmed: the resolution card appears, direct-submit is blocked
  server-side, "different" clears the flag and allows submission, "use existing"
  withdraws the draft and blocks further edits, and dismissed/confirmed decisions
  don't re-prompt on that same pair. Then reconfirmed the entire prior regression
  suite from a completely fresh `npm install` (all 11 migrations apply cleanly).

## What's new in Phase 11

- **PostgreSQL least privilege** (spec section 75.5), addressing something more
  cautious than another feature phase: the app has run as the same database role
  that owns the schema since Phase 1, meaning a SQL-injection bug or a compromised
  app process could, in principle, `DROP TABLE` anything. This was chosen
  deliberately *instead of* the much larger, riskier full canonical-question
  architecture restructuring — smaller in scope, genuinely testable here, and safe
  to ship without needing a live decision from you first.
  - `backend/deploy/create-app-role.sql` — a one-time DBA script creating a
    restricted `examportal_app` role with only `SELECT/INSERT/UPDATE/DELETE` on
    application tables (plus sequence usage for the few `BIGSERIAL` columns) —
    explicitly no `CREATE`/`ALTER`/`DROP` on anything, no role management, no
    cluster-wide administrative privileges. Uses `ALTER DEFAULT PRIVILEGES` so
    tables added by *future* migrations are automatically covered without
    re-running this script.
  - `db.js` now connects via `APP_DATABASE_URL` when set, falling back to
    `DATABASE_URL` (the schema-owning role) otherwise — **purely opt-in**;
    `npm run migrate` keeps using `DATABASE_URL` unconditionally, since DDL
    genuinely needs owner privileges. Nothing changes for anyone who doesn't set
    the new variable.
  - Wired into `docker-compose.prod.yml` and the Kubernetes backend deployment
    (optional secret keys — omitted entirely, the shell logic leaves
    `APP_DATABASE_URL` unset and everything runs exactly as before this phase).
  This was verified for real, not just configured: created the actual restricted
  role in this build's Postgres instance, then — as that role, with a live
  connection — confirmed `DROP TABLE users` and `CREATE TABLE` both genuinely
  fail with a permission error, while normal `SELECT`/`INSERT` work. Then ran
  `npm run seed` **and the entire application** (server + full smoke test —
  login, question workflow, AI review, paper generation, independent
  approval, locking, audit chain, account lockout) against that same
  zero-DDL-privilege connection, and it all worked identically to the
  unrestricted path. Also independently executed the exact shell logic used in
  the Kubernetes deployment YAML (not just checked that the YAML parses) to
  confirm it correctly constructs `APP_DATABASE_URL` only when the optional
  secret is present, and leaves it unset otherwise. Then reconfirmed the entire
  prior regression suite from a completely fresh `npm install`, including
  dropping the new role first to prove the setup works from absolute zero.

## What's new in Phase 16

A full pass through a "Reviewer Layer" spec covering the whole
assign→review→profile→generate→compare→recommend→handoff chain. Most of the
question-review half (batches, multi-reviewer disagreement, CO/Bloom/
difficulty) already existed from Phases 12-13; this phase fills in the
pieces that didn't: Units/Topics, reviewer-led candidate generation with
real comparison metrics, and reviewer recommendations on candidates.

- **Units and Topics** (migration `020`): the other half of the academic
  hierarchy that was named in the original architecture but never built —
  only Course Outcomes existed. `syllabus_units`/`syllabus_topics` follow
  the exact same pattern as COs (scoped to one syllabus version, never
  rewritten by a later one). `verified_syllabus_unit_id`/
  `verified_syllabus_topic_id` added to `canonical_questions`,
  `question_reviews`, and `review_resolutions` — wired into the reviewer
  verdict form, the disagreement detection, `recordResolution`, and the
  auto-consensus finalization exactly like Bloom/difficulty/CO already were.
  A new `validateUnitTopicPair()` helper in `academic.js` enforces "unit/
  topic must come from valid syllabus relationships" **server-side** — a
  topic can only be paired with the unit it actually belongs to, and both
  must belong to the question's own course offering's syllabus version.
- **Reject/request-revision now require a comment.** Previously optional;
  the spec calls this out explicitly and it's an easy, real omission to fix.
- **Reviewers can now generate candidates themselves** (`papers.js`'s
  `/generate` and `/blueprints` now accept the `reviewer` role, scoped to
  their actual active `reviewer_assignments` — not by department, since a
  reviewer typically isn't a department member). Found and fixed a real
  pre-existing bug in the process: `GET /academic/course-offerings`
  already listed `reviewer` in its allowed roles, but its department-based
  filter would have returned an empty list for every reviewer, since
  reviewers generally have no `department_id`. Now scoped by their
  `reviewer_assignments` instead.
- **Real, computed candidate comparison metrics** (migration `021` adds
  `exam_papers.candidate_metrics`): CO coverage % and unit coverage %
  (against the syllabus version's actual active CO/unit counts, honestly
  reporting 0% rather than a misleading 100%-of-nothing when none are
  defined yet), difficulty match % and Bloom match % (against the
  blueprint's requested counts), semantic conflicts (reusing the existing
  dedup pipeline's persisted `question_relationships` — a real signal, not
  a new heuristic invented for this screen), reuse conflicts (always 0 by
  construction, reported explicitly rather than omitted, since
  `pickQuestions` already excludes anything in `previous_year_papers`), and
  a quality score (averaged from each canonical question's own
  `quality_status`). Computed once at generation time, stored, and never
  recomputed differently for display vs. for a recommendation.
- **Reviewer recommendations** (new `candidate_recommendations` table,
  `POST /papers/generation-requests/:id/recommend`): one reviewer's
  advisory pick among a batch's candidates — score, reason, strengths,
  weaknesses. Multiple reviewers can each recommend independently (one row
  per reviewer per batch, same non-overwriting principle as question-level
  review) rather than being forced to agree.
- **HOD override reason enforced server-side**: `POST /candidates/:paperId/select`
  now checks whether the candidate being selected contradicts any existing
  recommendation for that batch, and rejects the request (with the
  recommended candidate IDs, so the frontend can prompt) unless an
  `override_reason` is supplied — stored on the generation request. The
  frontend's candidate-selection screen now shows a plain `window.prompt`
  for this when the backend signals a conflict.
- **Reviewer dashboard, for real** (new `GET /review/dashboard`, new
  `ReviewerHome` frontend component and default landing tab for the
  reviewer role): assigned batches with per-batch progress/conflict counts,
  pending questions, completed reviews, questions needing revision,
  unresolved conflicts, and candidate papers awaiting this reviewer's
  recommendation — one call, not five separate screens to remember to check.

**Deliberately not done in this pass, stated plainly:**
- **The full E2E test suite** the spec's section 21 describes (19-step
  integration path, IDOR tests, unit tests for every validator) — still not
  built, for the same reason as every earlier phase: this sandbox has never
  had a live database to run tests against. This remains the single
  largest gap against any of this project's "Definition of Done" sections.
- **Bloom/difficulty match as a hard generation constraint** — still
  reporting-only (see Phase 15's note), now also feeding the comparison
  table's percentages, but generation itself doesn't yet retry/reject to
  hit an exact Bloom count.
- **Semantic diversity detection** is exactly as strong as the existing
  dedup pipeline (lexical/trigram, not true semantic) — "semantic
  conflicts" in the comparison table means "confirmed via the existing
  classification tiers," not a new NLP model.
- Blueprint-level CO/unit/topic *targets* (e.g. "at least 2 questions from
  Unit 3") aren't modeled — coverage is measured and reported, but a
  blueprint can't yet declare a required minimum per unit/CO and have
  generation enforce it.

**What's verified vs not:** identical constraint to every phase before it —
no PostgreSQL, Docker, or network access this session. Every touched backend
file passes `node --check`, the frontend file was parsed clean with
`esbuild` after each incremental change (not just once at the end), and the
new SQL was checked by hand against the actual schema it extends. None of it
has run against a live database or a browser. Before relying on this: run
the migrations, then walk the chain by hand — assign a reviewer, have them
verify CO/Unit/Topic/Bloom/difficulty on a question with an intentionally
wrong value from a second reviewer to confirm the disagreement banner and
resolution flow, generate multiple candidates as that reviewer, confirm the
comparison table's numbers make sense for a known question set, submit a
recommendation, then as HOD select a *different* candidate and confirm the
override-reason prompt actually appears and blocks the request without one.

## What's new in Phase 15

Real classification tiers for deduplication (brain.md section 7), replacing
the single "similarity > 0.85 => flag it" threshold that existed since
Phase 2.

- **New module `backend/src/dedup.js`** implements the full pipeline:
  candidate retrieval (exact hash + top-5 nearest by embedding, in the same
  course offering) → multi-signal comparison → classification into
  `EXACT_DUPLICATE` / `LIKELY_DUPLICATE` / `RELATED` / `DISTINCT`. The
  classification is never based on text similarity alone — it also checks
  question type, marks, topic, difficulty, submitted Bloom level, and (when
  both sides have one) a separate similarity comparison of the model
  answers, and records its reasoning as plain-language strings, not just a
  label. `DISTINCT` candidates are computed but dropped before being
  returned/persisted — there's no value in telling a teacher their question
  is 20% similar to five unrelated ones.
- **Persisted at detection time, not just decision time**: every
  non-DISTINCT candidate becomes a `question_relationships` row (migration
  `019` adds `classification` and `signals` columns, plus a
  `UNIQUE(source_question_id, target_question_id)` constraint) as soon as
  `/preview` or `/submit` runs the pipeline — so there's a durable record of
  what the system found regardless of what a human later decides, matching
  brain.md's "every original submission remains auditable." Re-running
  detection on the same pair refreshes the computed fields in place; a pair
  that's already been decided (`status != 'pending'`) is left completely
  untouched, enforced by a `WHERE`-guarded `ON CONFLICT` clause, not just
  application logic.
- **Tier-appropriate actions, not one-size-fits-all**: `EXACT_DUPLICATE`/
  `LIKELY_DUPLICATE` candidates block submission and offer "Use Existing
  Question" (merges into one canonical question) or "This Is Different".
  `RELATED` candidates are informational — they don't block submission, and
  deliberately do NOT offer a merge option, since the system already
  determined these are two different questions; the teacher can only
  confirm "yes, related" (both stay independent, relationship recorded for
  future reference) or "not related" (dismissed).
- **`/duplicate-decision` now takes a `relationship_id`**, not a
  client-supplied `target_question_id`/similarity score — the server
  already computed and persisted the candidate at `/preview` time, so
  there's nothing left for the client to assert about the match itself,
  only which of the (now tier-appropriate) actions to take.
- **`ai-review.js`'s duplicate check now calls the same `classifyAgainstBank`
  pipeline** instead of its own separately-tuned threshold, so an AI-review
  finding and the preview screen's finding are always the same
  classification computed the same way, never two thresholds that could
  quietly disagree with each other.

**Known limits carried forward, stated plainly**: this is still built on
the same lexical (character-trigram) embedding as every earlier phase — a
genuine paraphrase in completely different words will not be caught by the
text-similarity signal, no matter how the tiers are defined on top of it
(see `embeddings.js`'s own long-standing note on this). The "intent"
comparison brain.md asks for is approximated here by comparing model-answer
text similarity, not a real semantic/NLU comparison — swapping in a real
embedding model or an LLM-based comparison call remains future work, and
would slot into `dedup.js`'s `computeSignals`/`classify` functions without
needing to touch anything that calls them.

**What's verified vs not, for this phase specifically:** same constraint as
every phase before it — no PostgreSQL, Docker, or network access in this
session. `dedup.js`, `embeddings.js`, and every route file that imports them
pass `node --check`; the SQL in `dedup.js` was traced by hand against the
actual `questions` table schema and pgvector's `<=>` operator semantics, and
the `ON CONFLICT ... WHERE` upsert idiom was checked against Postgres's
documented behavior (a skipped conflict update returns no row from
`RETURNING`, which the code handles with an explicit re-fetch). None of it
has run against a live database. Before relying on this: run the
migrations, then submit two near-identical questions and confirm they
classify `LIKELY_DUPLICATE`, submit two questions on the same topic with
different marks/type and confirm `RELATED` (not blocking), and confirm a
`RELATED` candidate's preview screen never offers a merge button.

## What's new in Phase 14

A brain.md-driven audit of the whole build (not just Phases 12-13) surfaced
several concrete production-hardening gaps. This phase fixes the two most
clear-cut ones: multi-step writes with no transaction safety, and a cluster
of real auth/session gaps (OTP echoed in the API response, no way to
actually revoke a JWT, wide-open CORS).

### Transaction safety
`withTransaction()` existed in `db.js` since early phases but was never
actually called anywhere — every multi-step write (create a canonical
question + its version + its answer + its audit event + link the
submission, in four separate statements; insert a resolution + update
canonical_questions + upsert a CO mapping; insert a generated paper + all
its paper_questions rows) could be left half-done by a crash or connection
drop between statements. Now wrapped in `withTransaction`, each as a single
atomic unit:
- `canonical.js`'s three write functions (`createCanonicalQuestion`,
  `linkToCanonical`, `setCourseOutcomes`) now take an optional trailing `db`
  handle — defaulting to plain auto-commit get/run, but accepting a
  transaction handle so a caller can make a whole sequence atomic.
- `questions.js`: `/submit` (mark submitted → canonicalize → CO mapping) and
  `/duplicate-decision`'s `use_existing` path (relationship record →
  withdraw → link to canonical) are each one transaction.
- `review-batches.js`: `recordResolution` (the one function allowed to write
  `canonical_questions.verified_*`), batch creation, reviewer assignment,
  reviewer reassignment, and verdict recording are each wrapped.
- `papers.js`: each generated candidate's paper row + all its
  `paper_questions` rows are inserted as one transaction, so a paper can
  never end up with only some of its questions attached.

**Not done**: this pass covers everything written in Phases 12-13 plus the
paper-generation loop. Some pre-existing multi-step flows this session
didn't touch (syllabus-version approval resetting previously-approved
questions to pending, the HOD/Admin paper-approval status transitions) have
the same theoretical gap and would benefit from the same treatment — flagged
here rather than silently left implying they were also checked.

### Auth & session hardening
- **OTP/reset-code delivery is now a real pluggable abstraction**
  (`backend/src/otp-delivery.js`) instead of being echoed back in the login/
  reset-request API response as `dev_otp_stub`/`dev_reset_token_stub`. Two
  providers: `console` (server-log only, default, clearly not real delivery)
  and `smtp` (real email via `nodemailer`, added to `package.json` — needs
  `npm install` plus real `SMTP_*` credentials in `.env` to actually send).
  Selected via `OTP_DELIVERY_PROVIDER`.
- **Password-reset no longer leaks account existence.** The old `/confirm`
  endpoint required a `userId` that was only ever present in the `/request`
  response when the account existed — meaning the field's mere
  presence/absence was itself the leak the generic response text was
  supposedly avoiding. `/confirm` now looks the pending reset up by its
  token's hash alone (the token is a 256-bit random value — safe to use as
  the sole lookup key), so no user-identifying field is ever returned by
  `/request` at all.
- **Real JWT revocation** via a `token_version` column (migration `018`):
  every token carries the `tv` claim it was issued with; every request
  compares it against the user's current `token_version`. Bumped on
  logout (`POST /auth/logout`, now actually called by the frontend's sign-out
  button instead of only clearing local state), password change,
  password-reset completion, and a new admin-only
  `POST /auth/users/:id/force-logout` for incident response. A password
  change now returns a fresh token in its response specifically so the
  request that changed the password doesn't immediately invalidate itself.
- **JWT hardening**: issuer/audience are now set on sign and enforced on
  verify, and the verify call restricts accepted algorithms to `HS256`.
- **CORS allowlist**: replaced the previous bare `cors()` (reflects/allows
  any origin) with an explicit `CORS_ALLOWED_ORIGINS` allowlist, read from
  the environment; unset falls back to permissive with a loud startup
  warning rather than silently staying open in a real deployment. No
  request in this app uses cookies (the JWT travels in an `Authorization`
  header), so `credentials: true` is deliberately not set.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` now stop accepting new
  connections, let in-flight requests finish, and close the DB pool before
  exiting, instead of the process dying mid-request under a container
  orchestrator's rolling restart.
- **Frontend updated to match**: `api.js` auto-clears the stored token and
  reloads to the login screen specifically when a response carries the new
  `session_invalid: true` flag — never on a bare 401 status, which several
  routes (wrong current password, wrong TOTP code during step-up approval)
  legitimately return with a perfectly valid token still attached. Getting
  this distinction wrong would have logged people out over a typo instead
  of just showing them the error.

**What's verified vs not, for this phase specifically:** same constraint as
every phase before it — no PostgreSQL, Docker, or network access in this
session. Every touched backend file passes `node --check`; every touched
frontend file was parsed with `esbuild`; the transaction-wrapping and
token-version logic were traced by hand against `db.js`'s actual
`withTransaction` implementation and `requireAuth`'s actual check, not
assumed. None of it has run against a live database, a live SMTP server, or
a browser. Before relying on this: run the migrations, set real `SMTP_*`
credentials (or deliberately leave `OTP_DELIVERY_PROVIDER=console` for a
closed pilot and treat the server log as the delivery channel), set
`CORS_ALLOWED_ORIGINS`, and specifically test that a password change/reset/
logout on one tab actually invalidates a token held in another.

## What's new in Phase 13

The frontend catch-up for Phase 12's backend work, plus one real backend bug
fix found while wiring the UI up against it.

- **Teacher submission form** (`TeacherDashboard.jsx`): a Bloom-level dropdown
  next to difficulty (optional — a teacher's best guess, confirmed later by a
  reviewer), and a Course Outcome picker (one primary + optional secondaries,
  loaded from the new `/academic/course-offerings/:id/course-outcomes`
  endpoint) shown at the preview step, wired into the final `/submit` call.
- **Review batches** (`ReviewerDashboard.jsx`, new "Review batches" tab for
  reviewer/HOD/admin): `ReviewBatches` → `BatchDetail` → `QuestionReviewCard`.
  HOD creates a batch against a course offering (defaults to every
  submitted-but-unbatched question), assigns one or more already-active
  reviewer assignments to it; each reviewer records decision +
  verified difficulty/Bloom/CO + ambiguous/duplicate/answer-approved flags
  per question. Multiple reviewers' verdicts render side by side in a table;
  a genuine conflict shows an explicit "REVIEWER DISAGREEMENT" banner — never
  averaged — with a resolve form for HOD/admin (final value + resolution
  method + reason) and a close-batch button once every disagreement has a
  recorded resolution.
- **Course Outcome management**: an inline expandable panel on each syllabus
  version card (under Manage Academics → Syllabus versions) to add/remove
  COs for that specific version.
- **Bloom-aware paper generation** (`PaperGeneration`): blueprint creation now
  has six Bloom-percentage inputs (with a running sum shown) and an overall-
  difficulty-target selector; generated candidates display their realized
  Bloom distribution and the heuristic difficulty estimate with its
  confidence, both explicitly labeled as estimates.
- **Backend bug fix found while building this**: the manual HOD `/resolve`
  endpoint was the *only* place that ever wrote
  `canonical_questions.verified_*` — meaning the common case (a single
  reviewer, or multiple reviewers who simply agree) would never actually get
  its classification recorded anywhere, silently defeating the point of
  collecting it. Fixed by extracting a shared `recordResolution()` helper in
  `review-batches.js` and adding `finalizeUnanimousQuestions()`, which runs
  automatically once a batch's last reviewer completes: any question where
  every completed reviewer agrees (including the trivial single-reviewer
  case) is auto-recorded as `single_reviewer_consensus`; genuine
  per-field disagreement is left untouched for the HOD's explicit
  `/resolve` call (now including a Course Outcome selector alongside
  difficulty/Bloom). A second, smaller bug (a wrong ID being used in the
  "mark reviewer in-progress" update inside the verdict endpoint) was also
  caught and fixed during Phase 12's own manual review, before this phase.

**What's verified vs not, for this phase specifically:** same constraint as
Phase 12 — no PostgreSQL, Docker, or network access in this session, so
nothing here was exercised end-to-end against a running app or a browser.
What *was* done: every new/changed `.jsx` file was parsed with `esbuild`
(pulled from an already-installed local npm package, since `npm install`
itself needs network) to catch syntax errors, and every field name used in
each `api.get`/`api.post` call was manually cross-checked against the exact
backend route/column names it calls. That catches typos and shape mismatches
but not runtime/browser behavior — treat this the same as Phase 12: written
and reviewed, not run. Before relying on it, `npm install` the frontend,
`npm run dev`, and walk through: teacher submits a question with a Bloom
level and CO picked → HOD creates a batch → assigns a reviewer → reviewer
records a verdict → (with a second reviewer giving a different verdict) HOD
sees the disagreement banner and resolves it → batch closes.

## What's new in Phase 12

The change Phase 11 explicitly deferred: the flat `questions` table is no
longer the institution's single source of truth for a question. A proper
canonical-question architecture sits on top of it, and the reviewer role goes
from a single accept/flag opinion to a real multi-reviewer academic workflow.

- **Canonical question architecture** (migrations `013`–`015`, `backend/src/canonical.js`):
  `questions` is now purely the **submission** layer — what one teacher
  actually typed, never rewritten. `canonical_questions` is the institution's
  one true question record, with its own versioned wording/marks
  (`question_versions`) and versioned model answer (`canonical_answers`,
  kept separate from any one teacher's own answer text). Every merge/link is
  logged in `question_canonicalization_events`. Every pre-existing `questions`
  row was backfilled 1:1 into this model (migration `015`) — nothing was
  deleted or rewritten, the split is purely additive.
  - New submissions get canonicalized automatically at final `/submit` (not
    at draft time).
  - Confirmed duplicates (the existing "Use Existing Question" flow) now
    actually **link** to the same canonical question instead of just marking
    the withdrawn submission — the teacher's own wording/answer still isn't
    touched, no redundant canonical question is created.
- **Course Outcomes and CO mapping** (migrations `012`, `014`;
  `academic.js`'s new `/syllabus-versions/:id/course-outcomes` and
  `/course-offerings/:id/course-outcomes` endpoints): COs belong to a specific
  syllabus version and are never rewritten by a later one. Questions map to
  COs at the canonical-question level (one PRIMARY, zero or more SECONDARY),
  starting as a teacher's own unverified suggestion and becoming
  reviewer-verified through the resolution flow below.
- **Bloom's taxonomy**: `questions.submitted_bloom_level` (teacher's own
  suggestion, optional) and `canonical_questions.verified_bloom_level`
  (reviewer-confirmed, authoritative) are now real columns, not absent
  entirely as in Phase 1–11.
- **Reviewer batches replace the single-verdict model** (migration `016`,
  new `backend/src/routes/review-batches.js`, mounted alongside the existing
  `review.js`): an HOD creates a `review_batch` against a course offering,
  assigns one or more reviewers to it, and each reviewer independently
  records accept/reject/request-revision **plus** verified difficulty/Bloom/CO
  per question. Multiple reviewers on the same question produce multiple
  rows — disagreement is surfaced explicitly (`GET .../disagreements`) and
  is **never averaged**; a separate, explicit `/questions/:id/resolve` call
  (HOD/admin only) records the authoritative final classification, which is
  the only thing that ever updates `canonical_questions.verified_*`. A
  reviewer literally cannot record a verdict on their own submitted question —
  enforced both in the route and as a hard Postgres trigger. Late/declined
  reviewers can be reassigned without deleting the original assignment
  record. A batch can only be closed once every disagreement has an explicit
  resolution.
- **Paper generation is Bloom-aware in its reporting** (migration `017`):
  blueprints can carry a Bloom percentage distribution and an
  `overall_difficulty_target`; each generated candidate now reports its
  realized Bloom distribution and a heuristic overall-difficulty estimate
  with an explicit confidence score (see the scope-limits note below — this
  is reporting/comparison, not yet a hard selection constraint).

**What's verified vs not, for this phase specifically:** unlike Phases 1–11,
this build environment for this session had **no PostgreSQL, no Docker, and
no outbound network access at all** (`bash_tool` network egress was disabled
throughout), so none of the migrations or route changes above could actually
be run against a live database this time — they're written and manually
reviewed, not executed and confirmed the way earlier phases were. Before
relying on this in a real deployment: run `npm run migrate` against a real
Postgres+pgvector instance and exercise at least one full submit →
duplicate-link → batch-create → assign → verdict → disagreement → resolve →
generate cycle by hand or via an extended `smoketest-pivot.mjs`.

## Known scope limits of this phase (by design, not oversight)

*(Historical, written for phase 12. Several items have since changed: Bloom and CO targets are exact hard
constraints in the COE generator (pivot phase 2); syllabus approval uses change detection (pivot phase 4b); both
Docker images are built and started in CI and locally (pivot phase 5). Current limits: `docs/development/PIVOT_STATUS.md`.)*

- **Bloom-targeted question selection is best-effort reporting, not a hard
  constraint yet.** Paper generation selects by difficulty and non-repetition
  (as before) and now also *reports* the realized Bloom distribution against
  a blueprint's target percentages — but it does not yet refuse/retry to hit
  an exact Bloom count the way it does for difficulty shortfalls. A genuinely
  Bloom-constrained selector (bucket the pool by difficulty × Bloom, not just
  difficulty) is the natural next step once real question banks have enough
  reviewer-verified Bloom classifications to make that meaningful.
- **The overall-paper-difficulty estimate is a documented heuristic**
  (`estimateOverallDifficulty` in `papers.js`) blending average question
  difficulty and average Bloom level — not the full factor list spec section
  26 lists (marks weighting, question-type, topic/unit complexity aren't
  modeled yet). Its confidence score explicitly drops when questions lack a
  reviewer-verified Bloom level, and it's never presented as exact.
- **Frontend scope limit carried over from Phase 13**: the "assign
  reviewers" picker only lists reviewers already actively assigned to that
  course offering (via the existing Manage Academics screen) — there's no
  shortcut to assign a brand-new reviewer to the offering from inside the
  batch view itself.
- **Near-duplicate detection is lexical, not semantic** (see `embeddings.js`) — it
  catches reworded/reordered text but not true paraphrases in different words.
- **Syllabus content entry is manual, not AI-extracted.** A teacher/HOD types or
  pastes the unit/topic breakdown directly — there's no PDF upload + AI-extraction
  pipeline. The `extraction_status` column exists for that future step but is
  unused; what's fully real is the version workflow and its change detection (originally
  "previously-approved questions reset to `pending`", replaced in pivot phase 4b).
- **Multi-candidate generation draws independently per candidate**, not by
  guaranteeing zero question overlap between candidates — with a small question bank,
  two candidates can and will share questions. This is disclosed in-app implicitly by
  letting the HOD compare the actual question lists side-by-side before choosing.
- **Notifications are polled, not pushed** — the bell checks for new ones every 15
  seconds rather than using websockets/SSE. Fine for a small deployment; would need
  a push mechanism at larger scale.
- **ClamAV's actual malware-detection accuracy is unverified** (see "What's tested
  vs not" at the top) — only the fail-safe/fail-closed behavior when the scanner is
  unreachable was confirmed. Run the standard EICAR test file against your own
  deployment once ClamAV has real virus definitions loaded.
- **The Kubernetes/Docker Compose deployment files are unverified end-to-end** (see
  "What's tested vs not") — both images are now built and started (pivot phase 5), but
  the full compose stack and the manifests have not been applied to a real cluster. The
  Redis integration's *application-level* behavior was verified directly against a
  real Redis instance (see above); what's unverified is that same behavior running
  inside the container/pod versions of these services.

