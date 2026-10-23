# Contributing

Thank you for helping improve the Examination Portal. This guide covers setup, the rules the code follows, and what a
change needs before it is merged.

## Set up

Follow [Installation](docs/getting-started/installation.md) (Node.js 22+, Docker). Then:

```bash
cd backend && npm test                 # unit + route tests, no database needed
cd frontend && npx playwright install chromium   # once
cd frontend && npm run lint && npm run build && npm run test:e2e
```

`./run-checks.sh` runs the full local check (it starts a throwaway PostgreSQL in Docker).

## Rules of the codebase

- **The server decides.** Every endpoint checks role and scope on the server (`authorization.js`, `academic-scope.js`);
  hiding a button is never enough. Add route tests for refusals, including that nothing is written.
- **Workflow rules live in the database too.** Status transitions and invariants are enforced by triggers. Database
  changes are a **new numbered migration** in `backend/migrations/`; applied migrations are never edited.
- **Papers are frozen.** Never make a generated paper depend on live question-bank data.
- **No silent relaxation.** The generator meets targets exactly or refuses with a reason.
- **Syllabus fidelity.** Never invent course outcomes or topics; surface uncertainty as warnings.
- **Shared definitions.** Question types (`question-types.js`) and Bloom levels (`taxonomy.js`) come from one place.
- **Accessibility.** Label form fields, keep keyboard access, keep the UI usable on narrow screens.
- **Lint has no warnings.** `npm run lint` fails on any warning.

## Making a change

1. Create a branch from `main`.
2. Make the change with tests (`backend/test-*.mjs` unit tests, `backend/test/*.test.mjs` route tests,
   `frontend/e2e/mock-ui.cjs` browser checks).
3. Update the documentation in `docs/`. If you change the demo data (`backend/data/syllabus-2023/`), run
   `npm run seed:demo -- --check` and `npm run docs:demo` in `backend/`.
4. Open a pull request and complete its checklist. CI must pass.

## Commit messages

Use the imperative mood and say what changes for the user, for example
`Refuse syllabus approval when no course outcome is recorded`.

## Security

Never commit secrets, `.env` files, real personal data or real examination content. Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md), not in public issues.
