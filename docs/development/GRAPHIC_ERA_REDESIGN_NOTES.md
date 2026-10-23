# Graphic Era redesign: implementation notes

What changed in `exam-portal-v5` for the Graphic Era redesign (README_GRAPHIC_ERA_REDESIGN.md), how to configure it, and
what is still owed by the project owner. The examination workflow of PIVOT_SPEC_V2 is unchanged.

## Scope guarantees

- No migration, seed, trigger, auth, TOTP/OTP, rate-limit, scope or authorization file was modified.
- No API route, role check or lifecycle rule was removed or relaxed. Two **additive** response fields were added to
  `GET /api/examinations/papers/:id` questions: `cos` (CO codes frozen at generation) and `print_label` (how the
  printed paper numbers the question, e.g. `Q2(a)`).
- All 13 question types, configurable sections, internal choices, hard CO/Bloom targets, validators, review batches,
  audit and the DRAFT watermark behave as before. No mock data was introduced into the application.

## Printed examination paper (`backend/src/paper-pdf.js`)

Same PDFKit pipeline, same exported functions, rebuilt layout following the institution's sample paper:

| Element | Source |
|---|---|
| Roll No. line | always (dotted vector line) |
| Logo | approved PNG/JPEG at `backend/assets/brand/institution-logo.png` or `INSTITUTION_LOGO_PATH`; omitted when absent |
| Institution / campus | `INSTITUTION_NAME`; campus and department from the examination |
| Exam heading | `examinations.exam_type` (mid_term → MID SEMESTER EXAMINATION, end_term → END SEMESTER EXAMINATION, …) + month/year of `exam_date`, else the academic session; legacy papers use their title |
| Program, course, code, semester (Roman), time, maximum marks, session, date | the examination and paper; missing values print `—` (time prints a blank line) |
| Note: i., ii., … | derived only from the paper's frozen section rules, then `exam_papers.instructions`, then `PAPER_GENERAL_INSTRUCTIONS` |
| Question grid | Q. No. / Question / Marks / CO; the CO column appears when the paper recorded CO codes |
| OR alternatives | a section with "attempt any 1" prints as one question with (a) OR (b) [OR (c) …]. When every section is such a choice (the sample paper's shape) section headings are not printed; otherwise headings and numbering are kept |
| Footer | "Page X of Y" on every page; DRAFT watermark on every page until PRINT_READY |

Rendering details:
- The text engine wraps, justifies and paginates itself: long questions split across pages under a repeated column
  header; no auto-added or blank pages. Text stays selectable/searchable (real spaces kept in justified lines).
- Latin text uses the standard Times/Courier fonts. Characters outside WinAnsi (Greek, ∑ ≤ √ ∞ ℝ, sub/superscripts,
  most non-Latin scripts) are drawn with embedded DejaVu fonts (`backend/assets/fonts`, licence included).
- Untrusted text is cleaned of control, zero-width and bidi-override characters.
- CO codes come from `exam_papers.candidate_metrics.question_cos`, written by the generator at generation
  (`exam-generator.js questionCos`) and frozen by migration 039. The PDF never reads the live CO mapping.

Limitations: CJK and Devanagari are not covered by DejaVu; LaTeX markup prints as plain text; papers generated
before this change print without a CO column (their CO codes were never frozen).

## Frontend

- Design tokens (`--ge-*`) and restyled shared classes in `src/index.css` (existing class names kept).
- `src/components/shell/`: header (brand, notifications, user), navy sidebar with gold active marker, mobile drawer
  (Escape closes, focus managed), page heading, and `RoleOverview` (figures + status pipeline from endpoints the
  role already uses; loading, error/retry and empty states). Each role's existing main tabs render into the sidebar
  (`Tabs primary`), so names, state and behaviour are unchanged.
- Sign-in screen redesigned; labels associated with inputs. Password dialog has dialog semantics.
- Paper screens: "Printed paper" panel (preview = the same PDF that downloads and prints), printed numbering and CO
  codes per question, validation results with the gap to each target and how to resolve it (nothing is relaxed).

## Configuration

| Setting | Where | Default |
|---|---|---|
| `INSTITUTION_NAME` | backend | `Institution Name Not Configured` |
| `INSTITUTION_LOGO_PATH` | backend | `backend/assets/brand/institution-logo.png` if present |
| `PAPER_GENERAL_INSTRUCTIONS` | backend, `|`-separated | none |
| `VITE_INSTITUTION_NAME` | frontend build | `Graphic Era` |
| `VITE_BRAND_LOGO_URL` | frontend build | none (name shown as text) |

Wired through `.env.example`, `.env.prod.example`, `docker-compose.prod.yml`, `frontend/Dockerfile` and k8s.

## Owed by the project owner

- **Official Graphic Era logo** (SVG/PNG for the portal, PNG/JPEG for papers). See `frontend/BRANDING.md` and
  `backend/assets/brand/README.md`. The cropped reference image must not be used.
- Confirmation of the exam-heading wording per exam type and of `INSTITUTION_NAME` for each campus.
- Optional official favicon.

## Tests

- `backend/test-paper-template.mjs` (new, in `npm run test:unit`): one-page OR paper, dynamic metadata, missing
  metadata, multi-page pagination, a question longer than a page, Unicode/maths, sanitising, logo present/absent,
  numbering and derived instructions.
- `backend/test/examinations.test.mjs`: printed metadata, frozen CO codes and numbering through the real route; the
  PDF route never reads the live CO mapping.
- `backend/test/pdf-text.mjs`: also decodes text drawn with embedded fonts (ToUnicode CMaps).
- `frontend/e2e/mock-ui.cjs`: one pre-existing race fixed (the TOTP setup check read the request log before the
  request was recorded; it failed intermittently on the original build too).
