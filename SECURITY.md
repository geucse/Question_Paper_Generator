# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately to the project maintainers, using GitHub's
*Report a vulnerability* (private vulnerability reporting) on this repository if it is enabled, or by contacting the
maintainers directly. Include the affected version or commit, steps to reproduce and the impact. Do not include real
personal data or real examination content.

We aim to acknowledge reports within a few working days and to coordinate disclosure once a fix is available.

## Supported versions

Security fixes are made on the `main` branch.

## Important notes for deployers

- **Demo accounts and data are public.** The passwords in the documentation and the demo dataset are for development and
  demonstrations only. The seed scripts refuse to run with `NODE_ENV=production`; create real accounts under **Accounts**.
- Production requires `NODE_ENV=production`, strong `JWT_SECRET` and `TOTP_ENCRYPTION_KEY`, a least-privilege
  `APP_DATABASE_URL`, real SMTP delivery, `CORS_ALLOWED_ORIGINS`, HTTPS, Redis and ClamAV. The server refuses to start
  with development-only settings in production. See the
  [production checklist](docs/reference/configuration.md#production-checklist).

## Security design (summary)

Password plus emailed one-time code; authenticator (TOTP) confirmation for final paper approval; argon2 password
hashing and account lockout; revocable sessions; role- and scope-based authorization on every request with logged
refusals; separation of duties; workflow invariants enforced by database triggers; uploads validated by content,
size-limited, stored under generated names and virus-scanned; rate limiting with automatic blocking; a tamper-evident
audit log. Details: [Architecture and security](docs/reference/architecture.md#security).
