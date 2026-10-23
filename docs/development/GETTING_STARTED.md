> **Superseded** by [Installation](../getting-started/installation.md) and the [guided demo](../getting-started/demo-walkthrough.md). Kept for history.

# Running the Exam Portal — Quick Guide

This is the short version: just what you need to get it running and demo it. The
main `README.md` covers a lot of deployment/infrastructure material (Docker,
Kubernetes, CI) that you can ignore entirely — none of it is required to run or
demo the actual product.

## What you actually need installed

- **Node.js 22** or newer (the backend's file-type 22 needs it; Vite 8 needs 20.19+; Node 20 is out of support)
- **PostgreSQL** (v14 or newer) with the **pgvector** extension available

That's it. Redis and ClamAV are both optional (see "Optional extras" below) —
everything works without them except one small piece (file attachments on
questions).

## 1. Set up the database

```bash
# Create the database and role (adjust password as you like)
sudo -u postgres psql -c "CREATE ROLE examportal WITH LOGIN PASSWORD 'devpassword' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE examportal OWNER examportal;"

# Enable the pgvector extension (needs superuser once)
sudo -u postgres psql -d examportal -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS vector;"
```

If your Postgres doesn't have pgvector installed at all:
```bash
sudo apt install postgresql-16-pgvector   # adjust "16" to your Postgres version
```

## 2. Backend

```bash
cd backend
npm ci                                     # installs exactly what package-lock.json lists
cp .env.example .env
echo "DEV_OTP_CONSOLE=reveal" >> .env      # local only: sign-in codes are printed in this terminal
echo "RATE_LIMIT_STORE=memory" >> .env     # local only: no Redis needed
npm run migrate
npm run seed
npm run dev
```

Without `DEV_OTP_CONSOLE` (or real SMTP settings) sign-in answers "could not send your sign-in code": codes are
never shown in the browser or returned by the API. Both settings are development-only; production refuses them.

Leave this running. It prints login credentials for the demo accounts (admin, HOD,
reviewer, teachers, COE and validator1–5) — keep that terminal output visible.

### Checking everything in one go
`./run-checks.sh` (in the repository root) installs dependencies with `npm ci`, audits them, runs the unit and route
tests (120 + 367), migrates (twice) and seeds a **throwaway** database container on port 5433, starts the server, runs
the end-to-end smoke test (348 checks), then audits, lints (any warning fails) and builds the frontend and runs the
browser checks (87, against a mocked API). Point `backend/.env` at that database first
(`DATABASE_URL=postgres://examportal:devpassword@localhost:5433/examportal`) and put it back afterwards. Pass a
`pg_dump -Fc` backup as the first argument to also upgrade a copy of your real data and compare row counts. Results go
to `logs/summary.txt`. Options: `DOCKER_BUILD=1` also builds both Docker images; `SKIP_E2E=1` skips the browser checks
(they are skipped with a note anyway until Playwright's browser is installed: `cd frontend && npx playwright install chromium`).
The GitHub Actions workflow (`.github/workflows/ci.yml`) runs the same steps on every push and pull request to `main`.

## 3. Frontend (new terminal)

```bash
cd frontend
npm ci
npm run dev
```

Frontend checks: `npm run lint` (oxlint, fails on any warning), `npm run build`, and `npm run test:e2e` (builds a
copy with `--mode e2e` into `dist-e2e/` and drives it in headless Chromium against a mocked API; run
`npx playwright install chromium` once first).

Open the URL it prints (usually `http://localhost:5173`).

## What to show your mentor — a walkthrough

The portal has two domains (PIVOT_SPEC_V2): the **Question Bank** (Teacher → HOD →
Reviewer) and **Examination** (COE → 4 Validators). The HOD and Admin do not
generate or approve papers any more.

**1. Teacher submits a question** — log in as `teacher1@portal.edu` (password from
the seed output; the sign-in code appears in the backend terminal as `[otp-delivery:console] ... code=123456`). Write a question, preview it,
submit it. Try to break it (negative marks, an answer matching no option) and show
the duplicate-detection card. The **Question status** tab shows where each
question is in its lifecycle.

**2. Prepare the syllabus** — as `hod@portal.edu`, under *Review workspace → Manage
academics*, make sure the course offering has an approved syllabus version with
units **and topics**, and a reviewer assigned. A question can only become Active
if its topic exists in that syllabus version.

**3. Reviewer classifies and decides, then activates** — as `hod@portal.edu`, create a
review batch for the offering in *Review workspace → Review batches* (this sends its
submitted questions to review) and assign the reviewer. As `reviewer@portal.edu`, open
the batch and give each question a verdict; an accept must verify difficulty, Bloom, CO
and unit/topic and approve the answer. Then complete your review and apply the decision
on each question card; with several reviewers, all of them must complete and agree.
Finally, in **Question lifecycle**, click *Activate (quality gate)*. If anything is
missing, the gate lists exactly what (e.g. missing CO mapping). Show that a reviewer
cannot act on their own question. Repeat until the offering has enough Active questions
for a paper.

**4. COE creates and generates a paper** — as `coe@portal.edu`: first set up the
authenticator (the dashboard prompts you). Create an examination for the offering,
create a blueprint (easy/medium/hard counts), generate. Show the per-question
"why selected" reason, then regenerate with too few Active questions to show it
fails with a reason instead of substituting anything.

**5. Four validators** — assign validator1–4. Show that the COE, a question author,
or the same person twice are refused. Log in as each validator (validator5 is not
assigned and is refused), work through the checklist and approve. Have one
validator report an issue: the COE cannot approve until it is resolved.

**6. COE final approval and lock** — resolve the issue, approve with the 6-digit
authenticator code, then *Mark PRINT_READY*. Download the PDF before and after
locking (the DRAFT watermark disappears). The paper is now immutable; archive it at
the end with a reason.

**7. Admin is technical-only** — as `admin@portal.edu`: system overview with the active protections, accounts
(create a COE or validator with its scope; the person receives a setup code by email, printed in the backend
terminal with `DEV_OTP_CONSOLE=reveal`), access scopes, the validation policy (4 of 4 by default) and the
audited emergency reset.
Nothing on that screen approves academic content.

## Optional extras (skip these for the demo — everything else still works)

- **Redis**: only affects rate-limiting behavior across multiple server
  instances, which doesn't matter for a single local demo. Skip it.
- **ClamAV**: only affects file attachments on questions. Without it an uploaded file is quarantined and
  cannot be used (that is the fail-closed design, not a bug). To demo attachments, run a clamd and point the
  backend at it (the first start downloads virus signatures, which takes a few minutes):
  ```bash
  docker run -d --name exam-portal-clamav -p 3310:3310 clamav/clamav:1.3
  echo "CLAMD_HOST=localhost" >> backend/.env
  ```
  Files uploaded before the scanner was up are rescanned automatically (or use "Scan again").

## Settings you need to know

Local development (in `backend/.env`; `backend/.env.example` documents every key):

| Setting | Local value | Why |
|---|---|---|
| `JWT_SECRET` | any random string of 32+ characters | the backend refuses a shorter one |
| `DEV_OTP_CONSOLE` | `reveal` (or `masked`) | sign-in, reset and invitation codes go to the backend log; without it (or SMTP) sign-in answers 503. Development only |
| `RATE_LIMIT_STORE` | `memory` | no Redis needed for one local server |
| `CORS_ALLOWED_ORIGINS` | empty | allowed outside production; the Vite dev server works without it |
| `TOTP_ENCRYPTION_KEY` | empty | a development key is derived from `JWT_SECRET` (with a warning) |
| `CLAMD_HOST` / `CLAMD_PORT` | empty, or a local clamd | without a scanner uploads stay quarantined (fail-closed) |

Production (`NODE_ENV=production`) refuses to start unless these are valid: `JWT_SECRET` (32+ characters, not the
example), `CORS_ALLOWED_ORIGINS` (bare origins), `OTP_DELIVERY_PROVIDER=smtp` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`
(`SMTP_USER`/`SMTP_PASS` together or both empty; `SMTP_SECURE`, `SMTP_REQUIRE_TLS`), `TOTP_ENCRYPTION_KEY`
(`openssl rand -hex 32`, and it must match the key check stored in the database; `TOTP_KEY_ROTATE=yes` for one start to
rotate it on purpose), `CLAMD_HOST`/`CLAMD_PORT` or `CLAMD_SOCKET`, `REDIS_URL` (or `RATE_LIMIT_STORE=memory` for a
single replica) and `TRUST_PROXY` as a hop count. `DEV_OTP_CONSOLE` and `DEV_EXPOSE_ACCOUNT_SETUP_TOKEN` must be unset.
Optional: `AUTO_BLOCK_MINUTES` (how long an automatic IP block lasts, default 60), `ATTACHMENT_RESCAN_INTERVAL_MS`
(default 10 minutes, `0` turns the sweeper off), `ACCOUNT_INVITE_TTL_HOURS` (72), `PORTAL_URL`, `INSTITUTION_NAME`,
`APP_DATABASE_URL` (least-privilege role). Templates: `.env.prod.example` (Docker Compose) and `k8s/02-configmap.yaml` +
`k8s/01-secret.example.yaml`.

## Upgrading an existing database

Migrations are applied in order and recorded in `schema_migrations`; running `npm run migrate` again is a no-op.

1. **Back up first**: `pg_dump -Fc -d examportal -f ~/db-backups/examportal-$(date +%F).dump` (for the Docker
   database: `docker exec exam-portal-postgres pg_dump -U examportal -Fc examportal > ~/db-backups/examportal-$(date +%F).dump`).
2. Optional but recommended: rehearse on a copy with `./run-checks.sh ~/db-backups/<that file>.dump` (it restores the
   copy into the throwaway container on port 5433 and compares row counts and integrity checks).
3. Stop the backend, then `cd backend && npm ci && npm run migrate` against the real `DATABASE_URL`, then start it again.
4. After the upgrade:
   - **Several papers in progress on one examination**: migration 039 grandfathers them, but only one may continue. As the
     COE, open each extra paper and archive it with a reason (Papers → Open → Archive). The copy check
     ("examinations with more than one paper in progress") shows how many there are.
   - **ACTIVE questions without a reviewer-verified mapping** (042) stay ACTIVE but are not used in new papers until the
     HOD maps them: Review workspace → Manage academics → **Question mapping** (filter "Mapping not reviewer-verified"),
     or a reviewer requests changes so the author re-maps the question.
   - Accounts whose authenticator secret was stored in plain text (040) must set up their authenticator again; the COE
     needs it before final approval.
   - Production needs the settings listed above (in particular `TOTP_ENCRYPTION_KEY`, `SMTP_*` and `CORS_ALLOWED_ORIGINS`).

## If something goes wrong

- **"password authentication failed"**: your `.env` password doesn't match what
  you created the Postgres role with. Check `backend/.env`'s `DATABASE_URL`.
- **"connect ECONNREFUSED" on port 5432**: Postgres isn't running —
  `sudo service postgresql start`.
- **`npm ci` fails with "npm ci can only install packages when your package.json and package-lock.json are in sync"**:
  someone edited `package.json` without updating the lockfile; run `npm install` once and keep the updated lockfile.
  It also needs HTTPS access to `cdn.sheetjs.com` (the spreadsheet parser is installed from there).
- **Migrations fail with "permission denied to create extension"**: run the
  `CREATE EXTENSION` commands from Step 1 as the `postgres` superuser first —
  your app role doesn't have that privilege by default, and shouldn't.
