# Troubleshooting and FAQ

## Setup

### "Migration run failed: SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"
`backend/.env` is missing, or has no `DATABASE_URL`. Create it as in [Installation, step 4](getting-started/installation.md#4-configure-the-backend).

### "JWT_SECRET is missing or too short"
Same cause: create `backend/.env` with a `JWT_SECRET` of at least 32 characters. If you have an older copy of the project
using the same database, copy its `.env` (the secret must stay the same).

### "The container name /exam-portal-postgres is already in use"
The database container exists from an earlier setup: `docker start exam-portal-postgres`. To find which folder created
it: `docker inspect exam-portal-postgres --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'`.

### "port 5432 already in use"
A local PostgreSQL is running: `sudo systemctl stop postgresql`, or use it instead (see Installation).

### The backend starts but warns about Redis
Add `RATE_LIMIT_STORE=memory` to `backend/.env` for a single-machine setup, or run Redis.

### The backend refuses to start mentioning the authenticator key
The database's authenticator secrets were encrypted with a different `JWT_SECRET`/`TOTP_ENCRYPTION_KEY`. Restore the
original `.env`, or start with a fresh database.

## Signing in

### "We could not send your sign-in code"
Development code delivery is not enabled. In `backend/.env` set `OTP_DELIVERY_PROVIDER=console` and
`DEV_OTP_CONSOLE=reveal`, then **restart** the backend. At start-up it should print
`[otp-delivery] development console delivery (reveal)`. The code then appears in the backend terminal after **Continue**.

### "Invalid email or password"
Check the password in [Demo accounts](getting-started/demo-credentials.md) (for example `Teach@123` has 9 characters).
If the account's password was changed in this database, use **Forgot password?**. After 5 failures, wait 15 minutes.

### The code is rejected
Codes last 5 minutes and allow 3 attempts. Use the newest code printed in the backend terminal, or sign in again.

### "Failed to fetch" / network or CORS errors on the sign-in page
The backend is not running, or the frontend runs on an unexpected port. Check that `npm run dev` in `backend/` shows
`Exam portal API running on http://localhost:4000`. A line `[cors] CORS_ALLOWED_ORIGINS is not set: allowing every
origin` is only a development notice.

### The COE cannot approve: "set up your authenticator"
Open **Authenticator** as the COE and link an app (see [Demo accounts](getting-started/demo-credentials.md#the-coes-authenticator-required-before-final-approval)).

## Demo data

### `npm run seed:demo` stops with an error
It prints the failing request and the reason. Common causes: `npm run seed` was not run first, or the backend `.env`
is incomplete. It is safe to run again after fixing the cause. `npm run seed:demo -- --check` validates the data without
a database.

### I want to start again with clean demo data
`docker compose down -v`, `docker compose up -d`, then `npm run migrate`, `npm run seed`, `npm run seed:demo`. This
deletes all data.

## Working with the portal

### A teacher cannot see a subject
The HOD must assign the teacher to the course offering (**Manage academics → Assign people → Assign teacher**). Also
check the teacher's **Access until** deadline.

### A teacher cannot pick a topic or a CO
The offering has no **Active** syllabus version yet. The HOD must upload or enter it and approve it.

### The syllabus upload says the PDF does not contain the course
The course is found by the subject code (e.g. *TCS 571*). Check that the subject's code matches the code printed in the
PDF; the message lists the courses the PDF does contain.

### The syllabus upload says the PDF has no text layer
It is a scanned document. Upload the text PDF, or enter the syllabus by hand.

### Generation is refused
Read the reason: it names the target that cannot be met (a CO, a Bloom level, a difficulty count or the exact marks).
Check **Analytics & coverage** for gaps; revise the blueprint, ask for questions, or record an override with a reason.

### Questions do not appear in generated papers
Only **Active** questions of the examination's syllabus version are eligible, and recently used questions are avoided
(the blueprint's reuse look-back).

### The printed paper shows "DRAFT — NOT FOR DISTRIBUTION"
Every page carries it until the paper is locked for printing (**PRINT_READY**).

### The paper has no logo
No approved logo file is configured; see [Configuration → Branding](reference/configuration.md#branding).
