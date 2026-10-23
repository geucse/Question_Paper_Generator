# Configuration

The backend reads its settings from environment variables (`backend/.env` in development; secrets or a ConfigMap in
production). Templates: `backend/.env.example` (development) and `.env.prod.example` (production with Docker Compose).
The frontend takes a few settings at **build** time (`VITE_*`).

## Backend

### Core

| Variable | Required | Meaning |
|---|---|---|
| `JWT_SECRET` | yes | Signs sessions; at least 32 random characters (`openssl rand -hex 32`). Keep it unchanged for an existing database. |
| `PORT` | no | API port (default 4000). |
| `DATABASE_URL` | yes | PostgreSQL connection (owner role; used for migrations). |
| `APP_DATABASE_URL` | production | A least-privilege role for the running app (`backend/deploy/create-app-role.sql`). Unset: `DATABASE_URL` is used. |
| `NODE_ENV` | production | `production` enables the strict checks below and **refuses the seed scripts**. |
| `CORS_ALLOWED_ORIGINS` | production | Comma-separated frontend origins. Unset allows every origin (development only); production refuses to start without it. |

### Sign-in codes and email

| Variable | Meaning |
|---|---|
| `OTP_DELIVERY_PROVIDER` | `smtp` (real email) or `console` (development: codes in the backend log). |
| `DEV_OTP_CONSOLE` | With `console`: `reveal` prints the code, `masked` hides it. Sign-in answers 503 while console delivery is not enabled. Refused in production. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Mail server for codes, password resets and invitations. |
| `PORTAL_URL` | Address of the portal, used in invitation emails. |
| `ACCOUNT_INVITE_TTL_HOURS` | How long an invitation's setup code stays valid (default 72). |
| `DEV_EXPOSE_ACCOUNT_SETUP_TOKEN` | Development only: also returns the setup code when an account is created. |

### Security

| Variable | Meaning |
|---|---|
| `TOTP_ENCRYPTION_KEY` | 32-byte hex key encrypting authenticator secrets. In development it is derived from `JWT_SECRET` (a warning is shown); set it explicitly for real use. Changing it invalidates every authenticator unless rotated on purpose (`TOTP_KEY_ROTATE=yes` once, audited). |
| `REDIS_URL` | Shared store for rate limits across processes. |
| `RATE_LIMIT_STORE` | `memory` runs without Redis (single process, development). |
| `GLOBAL_RATE_MAX` | Requests per IP per window before throttling. |
| `AUTO_BLOCK_MINUTES` | How long automatic IP blocks last (default 60). |
| `CLAMD_HOST`, `CLAMD_PORT` | ClamAV for scanning uploaded diagrams. Without it, uploads stay quarantined (not printable) until scanned. |
| `REVIEWER_CANNOT_TEACH_OFFERING` | `true` forbids assigning a reviewer to an offering they teach. |

### Institution and papers

| Variable | Meaning |
|---|---|
| `INSTITUTION_NAME` | Printed at the top of every paper, e.g. `Graphic Era (Deemed to be University)`. |
| `INSTITUTION_LOGO_PATH` | Approved PNG or JPEG logo for printed papers. Default `backend/assets/brand/institution-logo.png` if present; otherwise no logo is printed. |
| `PAPER_GENERAL_INSTRUCTIONS` | Institution-wide lines added to every paper's "Note", separated by `\|`. |

### Optional

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Enables language-quality checks in the advisory automated review. Without it, the deterministic checks (duplicates, topic balance, formatting) still run. |

## Frontend (build time)

| Variable | Meaning |
|---|---|
| `VITE_API_BASE_URL` | API address. Default `http://localhost:4000/api`; production builds use `/api` behind the same host. |
| `VITE_INSTITUTION_NAME` | Name in the header and on the sign-in screen (default `Graphic Era`). |
| `VITE_BRAND_LOGO_URL` | URL of the approved logo (e.g. `/brand/graphic-era-logo.svg`). Unset: the name is shown as text. |

## Branding

No official logo is included. To add it:

1. Portal: save the official file as `frontend/public/brand/graphic-era-logo.svg` (or `.png`) and build with
   `VITE_BRAND_LOGO_URL=/brand/graphic-era-logo.svg`.
2. Papers: save a PNG or JPEG copy as `backend/assets/brand/institution-logo.png` (PDF printing cannot embed SVG).

Details: `frontend/BRANDING.md` and `backend/assets/brand/README.md`. Colours are the `--ge-*` variables at the top of
`frontend/src/index.css`.

## Production checklist

- `NODE_ENV=production`, strong `JWT_SECRET` and `TOTP_ENCRYPTION_KEY`, separate `APP_DATABASE_URL`.
- Real SMTP (`OTP_DELIVERY_PROVIDER=smtp`), `CORS_ALLOWED_ORIGINS`, HTTPS in front of the app.
- Redis and ClamAV running; `INSTITUTION_NAME` and the logo set.
- Never run `npm run seed` or `npm run seed:demo`; create accounts under **Accounts**.
