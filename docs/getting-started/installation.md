# Installation and setup

This guide sets up the portal on a single computer for development, evaluation or a demonstration. It takes about
15 minutes. Commands are for Linux or macOS (bash); Windows users can run them in WSL.

## 1. What you need

| Software | Version | Check with |
|---|---|---|
| Node.js | 22 or newer | `node --version` |
| npm | comes with Node.js | `npm --version` |
| Docker with Docker Compose | any recent version | `docker compose version` |
| A modern browser | Chrome, Edge, Firefox or Safari | |

Docker runs the PostgreSQL database (with the `pgvector` extension). If you prefer a PostgreSQL 16 installation of
your own, it must have `pgvector`; see [Using your own PostgreSQL](#using-your-own-postgresql).

The portal has two parts that run side by side:

| Part | Folder | Address |
|---|---|---|
| Backend API (Node.js, Express) | `backend/` | http://localhost:4000 |
| Frontend (React, Vite) | `frontend/` | http://localhost:5173 |

## 2. Get the code

Unzip the project (or clone the repository) and move into it:

```bash
cd ~/exam-portal-v5
```

## 3. Start the database

```bash
docker compose up -d
docker ps          # "exam-portal-postgres" should be listed with status "Up"
```

> **"The container name /exam-portal-postgres is already in use"** means the database container already exists from an
> earlier setup. Start that one instead: `docker start exam-portal-postgres`. It keeps your existing data.

## 4. Configure the backend

```bash
cd backend
npm ci
```

Create the configuration file **once**. If you already have a `backend/.env` from an earlier copy of the project, copy
that file instead: its `JWT_SECRET` must stay the same for an existing database.

```bash
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i '/^OTP_DELIVERY_PROVIDER=/d; /^DEV_OTP_CONSOLE=/d; /^RATE_LIMIT_STORE=/d' .env
cat >> .env <<'EOF'
OTP_DELIVERY_PROVIDER=console
DEV_OTP_CONSOLE=reveal
RATE_LIMIT_STORE=memory
INSTITUTION_NAME="Graphic Era (Deemed to be University)"
EOF
```

What these settings do:

| Setting | Why |
|---|---|
| `JWT_SECRET` | Signs sign-in sessions; at least 32 random characters. Keep it unchanged once the database is in use. |
| `OTP_DELIVERY_PROVIDER=console` + `DEV_OTP_CONSOLE=reveal` | Shows sign-in codes in the backend terminal instead of emailing them (development only; refused in production). |
| `RATE_LIMIT_STORE=memory` | Runs without Redis on a single machine. |
| `INSTITUTION_NAME` | Printed at the top of every examination paper. |

The database address in `.env.example` already matches the Docker database. All settings are explained in
[Configuration](../reference/configuration.md).

## 5. Create the database tables and demo data

```bash
npm run migrate      # creates or updates all tables (safe to run again)
npm run seed         # base accounts, CSE department, B.Tech program, 2026-2027 session; prints the passwords
npm run seed:demo    # 14 subjects of the 2023 CSE syllabus and 280 sample questions (optional, recommended)
```

`npm run seed:demo` takes a few minutes. It works through the real application as each role (HOD, teachers, reviewers),
so every rule of the portal is applied to the demo data. It prints one line per subject, for example:

```
[seed:demo] TCS 571  Big Data Visualization: ACTIVE 16, APPROVED 1, CHANGES_REQUESTED 1, SUBMITTED 1, DRAFT 1
```

It is safe to run again: it only completes what is missing. To check the demo data without touching the database:
`npm run seed:demo -- --check`.

> Run `npm run seed` only on a new, empty database. On an existing database the accounts already exist.

## 6. Start the backend

```bash
npm run dev
```

Leave this terminal open. You should see `Exam portal API running on http://localhost:4000`. **Sign-in codes appear
here**, on lines like:

```
[otp-delivery:console] ... code=482913
```

## 7. Start the frontend

In a **second terminal**:

```bash
cd ~/exam-portal-v5/frontend
npm ci
npm run dev
```

Open the address it prints (normally **http://localhost:5173**) and sign in with a
[demo account](demo-credentials.md).

## 8. Stopping and restarting

| Task | Command |
|---|---|
| Stop the backend or frontend | `Ctrl+C` in its terminal |
| Stop the database (data is kept) | `docker compose down` |
| Start everything again | `docker compose up -d` (or `docker start exam-portal-postgres`), then `npm run dev` in `backend/` and `frontend/` |
| Start over with an empty database | `docker compose down -v`, then steps 3, 5, 6 and 7 (this deletes all data) |

## Using your own PostgreSQL

1. Install PostgreSQL 16 and the `pgvector` extension.
2. Create a database and a user, and enable the extension: `CREATE EXTENSION IF NOT EXISTS vector;`
3. Set `DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/DATABASE` in `backend/.env`.
4. Continue from step 5.

If port 5432 is already used by a local PostgreSQL and you want the Docker one, stop the local service
(`sudo systemctl stop postgresql`) or change the port mapping in `docker-compose.yml` and in `DATABASE_URL`.

## Optional components

| Component | Purpose | How to enable |
|---|---|---|
| ClamAV virus scanner | Scans uploaded question diagrams | `docker run -d --name clamav -p 3310:3310 clamav/clamav`, then `CLAMD_HOST=localhost` in `.env` |
| Redis | Shared rate limits when running more than one backend | `REDIS_URL=redis://localhost:6379` and remove `RATE_LIMIT_STORE=memory` |
| SMTP email | Real delivery of sign-in codes and invitations | `OTP_DELIVERY_PROVIDER=smtp` and the `SMTP_*` settings |
| Institution logo | Logo on the portal and on printed papers | See [Configuration → Branding](../reference/configuration.md#branding) |

## Production deployment

Production uses `docker-compose.prod.yml` (or the manifests in `k8s/`), real SMTP email, a separate least-privilege
database user, HTTPS and a configured `CORS_ALLOWED_ORIGINS`. Start from `.env.prod.example`, follow the [production checklist](../reference/configuration.md#production-checklist), and read
[`SECURITY.md`](../../SECURITY.md) and the detailed security notes in [DEVELOPMENT_HISTORY.md](../development/DEVELOPMENT_HISTORY.md). **Never run the seed scripts in production**; create real
accounts as the administrator under **Accounts**.

## Problems?

See [Troubleshooting and FAQ](../troubleshooting.md). The most common first-run problems are covered there:
"client password must be a string", "JWT_SECRET is missing", "We could not send your sign-in code", and
"Invalid email or password".
