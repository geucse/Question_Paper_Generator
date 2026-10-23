# Testing

| Suite | Command | What it covers | Result at release |
|---|---|---|---|
| Backend unit tests | `cd backend && npm run test:unit` | Paper generator, question types, paper PDF (layout, pagination, Unicode, Paper Analysis), syllabus extraction against the real PDF, demo dataset, scenarios A–C, auth security | 143 / 143 |
| Backend route tests | `cd backend && npm run test:routes` | Every API route with a mock database: roles, scopes (IDOR matrix), workflows, syllabus upload, refusals that write nothing | 374 / 374 |
| Frontend lint | `cd frontend && npm run lint` | oxlint with warnings as errors | 0 warnings |
| Frontend build | `cd frontend && npm run build` | Production build | passes |
| Browser tests | `cd frontend && npx playwright install chromium` (once), then `npm run test:e2e` | Real UI in Chromium against a mocked API: every role, sign-in flows, syllabus upload, read-only syllabus | 100 / 100 |
| Demo data check | `cd backend && npm run seed:demo -- --check` | 14 subjects, 280 questions, every reference valid | valid |
| Smoke test (real database) | backend running, then `cd backend && npm run smoke:pivot` | End-to-end against PostgreSQL | run locally |

`npm test` in `backend/` runs the unit and route tests. `./run-checks.sh` at the repository root runs the main checks
together.

## Notable checks

- The in-app syllabus extractor reproduces, for all 14 demo subjects, exactly what `pdftotext` extracts: titles, every
  CO word for word, unit text and contact hours; unit hours add up to each syllabus's total.
- The generator meets hard CO and Bloom targets exactly or refuses with the reason (scenarios A–C on the demo data).
- Teachers and reviewers are refused when trying to create, verify or submit a syllabus version, and nothing is written.
- The candidate copy of a paper never contains the answer key or the Paper Analysis page.

## Adding tests

Unit tests are plain `node:test` files (`backend/test-*.mjs`), added to `test:unit` in `backend/package.json`. Route
tests live in `backend/test/*.test.mjs`, use the mock database through `--import ./test/register.mjs` and the helpers in
`test/harness.mjs` (`sql()` to script query results, `writes()` to assert nothing was written). Browser checks are added
to `frontend/e2e/mock-ui.cjs` with `session()` and `check()`.
