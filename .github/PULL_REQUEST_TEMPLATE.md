## What and why

## Checklist

- [ ] `cd backend && npm test` passes (unit + route tests)
- [ ] `cd frontend && npm run lint && npm run build` pass
- [ ] `cd frontend && npm run test:e2e` passes (UI changes)
- [ ] New database changes are a **new** numbered migration (applied migrations are never edited)
- [ ] Role and scope checks are enforced on the server for any new endpoint, with route tests for refusals
- [ ] Documentation updated (`docs/`); `npm run docs:demo` re-run if the demo data changed
- [ ] No secrets, real personal data or `.env` files in the change
