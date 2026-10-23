# Exam Portal — frontend

React 19 + Vite 8, no UI framework beyond `src/index.css`. Role screens: `App.jsx` routes teacher, HOD/reviewer,
COE, validator and admin to their dashboards; API calls go through `src/api.js` (`VITE_API_BASE_URL`, default
`http://localhost:4000/api`; the Docker image uses `/api` behind its nginx proxy).

```bash
npm ci               # Node 22+
npm run dev          # http://localhost:5173 (backend on :4000)
npm run lint         # oxlint (.oxlintrc.json); any warning fails
npm run build        # dist/
npx playwright install chromium   # once
npm run test:e2e     # builds with --mode e2e into dist-e2e/ and runs e2e/mock-ui.cjs against a mocked API
```

The e2e checks cover UI wiring only (what each role sees, required reasons, request payloads); authorization is
tested by the backend route tests and smoke test. See `../GETTING_STARTED.md` and `../PIVOT_STATUS.md`.
