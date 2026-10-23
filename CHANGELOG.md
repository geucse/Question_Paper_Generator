# Changelog

All notable changes to this project. Dates are release dates of each round of work.

## 2026-10-23 — HOD syllabus workflow, demo dataset and documentation

### Added
- **Syllabus PDF upload for the HOD** (`POST /api/academic/course-offerings/:id/syllabus-upload`): a built-in PDF text
  extractor and syllabus parser create a draft version with the course outcomes, units, contact hours and topics exactly
  as printed, with warnings; the source PDF is kept and viewable. Validated against the official 2023 CSE syllabus
  (identical results to `pdftotext` for every demo subject).
- **Demo dataset**: 14 theory subjects of the 2023 CSE syllabus, 280 sample questions (11 types, all Bloom levels), HOD
  verification notes and gap flags; `npm run seed:demo` builds it through the API as each role (idempotent, refused in
  production); `npm run seed:demo -- --check` validates it offline.
- **Paper Analysis page** on the internal copy: distribution by CO, Bloom level, unit and difficulty.
- **Reviewer checklist** (syllabus alignment, correctness, clarity, CO, Bloom, difficulty, answer key, marks) required to
  accept a question.
- **Teacher read-only syllabus view** with the official PDF; HOD upload screen with extraction review and step indicator.
- Shared Bloom's taxonomy definition (`backend/src/taxonomy.js`).
- Complete documentation in `docs/`: installation, demo accounts, guided demo, six role guides, reference, demo-data pages.
- Repository files: README, CHANGELOG, CONTRIBUTING, SECURITY, issue and pull-request templates, `.editorconfig`.

### Changed
- **Only the HOD creates, verifies, submits and approves syllabus versions** (teachers previously could create, verify
  and submit). Tests updated to assert the refusals.
- Development documents moved to `docs/development/`; the demo data catalog to `docs/demo-data/CATALOG.md`.

### Tests
- Unit 143 (was 129), route 374 (was 368), browser 100 (was 87). CI now also runs the demo seed on PostgreSQL.

## 2026-10-22 — Graphic Era redesign and formal paper template

### Added
- Graphic Era interface: design tokens, navy sidebar shell, role dashboards with live figures, redesigned sign-in,
  accessible dialogs and notifications.
- Formal examination-paper template: roll number, institution and examination details, numbered instructions, bordered
  question table with marks and CO, OR alternatives, page numbers, Unicode and mathematical notation (embedded DejaVu
  fallback fonts), logo slot.
- CO codes frozen on each paper at generation; printed numbering and COs shown on paper screens; validation summary
  with remediation guidance.

## Earlier — examination domain (PIVOT_SPEC_V2)

The examination domain (COE, blueprints, generation, four validators, TOTP approval, print-ready locking), the reviewed
question bank and its database guards. See [docs/development/PIVOT_STATUS.md](docs/development/PIVOT_STATUS.md) and
[docs/development/DEVELOPMENT_HISTORY.md](docs/development/DEVELOPMENT_HISTORY.md).
