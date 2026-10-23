# Demo data catalog (Graphic Era 2023 CSE syllabus)

**All 280 questions in this dataset are DEMO / SAMPLE content written for this portal. They are not official
examination questions.** The syllabus data they are built on (subjects, course outcomes, units, contact hours) is the
department's official 2023 syllabus.

## Source

| | |
|---|---|
| Document | `backend/data/syllabus-2023/Syllabus-2023-New.pdf` (Graphic Era (Deemed to be University), Dehradun, Department of Computer Science and Engineering, 316 pages) |
| SHA-256 | `df70a961856eef533a00bac09c1eeb4533474e382d5e0a80692a21f61ed6ec07` |
| Extraction | `backend/src/pdf-text-extract.js` + `backend/src/syllabus-parse.js` (the same code the HOD upload uses) |
| Catalog | `backend/data/syllabus-2023/catalog.json`: subjects, COs and units exactly as printed, with page ranges |
| Questions | `backend/data/syllabus-2023/questions/<CODE>.json`: the HOD-verified topic list and 20 sample questions per subject |

Two independent text extractions (the in-app extractor and `pdftotext -raw`) produce the identical catalog for all 14
subjects: titles, every CO word for word, unit text and contact hours. For every subject the unit hours add up to the
total printed in the syllabus. `npm run test:unit` checks this against the PDF on every run.

## Subject selection

Exactly 14 theory subjects (no laboratory courses), Semesters I-VII; Semester VIII is excluded only to keep the limit
of 14. **The source has only one theory course in each of Semesters I and II** (TCS 101 and TCS 201), so the spec's
"two per semester" cannot be met there; Semesters III and IV contribute three each and V-VII two each. Core courses
(category DC) were preferred; TCS 571 (an elective, DE) is included because it is the subject of the reference
examination paper.

| Sem | Code | Title (as printed) | PDF pages | COs | Units (hours) | Topics | Questions | Types | Bloom (R/U/Ap/An/E/C) | Diff (E/M/H) | Not ACTIVE after seeding |
|---|---|---|---|---|---|---|---|---|---|---|---|
| I | TCS 101 | Fundamental of computer and Introduction to Programming | 1–3 | 6 | 8 / 10 / 8 / 7 / 10 | 28 | 20 | 9 | 2/7/5/3/1/2 | 7/11/2 | Q16 approved, Q18 changes requested, Q19 submitted, Q20 draft |
| II | TCS 201 | Programming for Problem Solving | 4–6 | 6 | 6 / 10 / 8 / 10 / 10 | 27 | 20 | 9 | 2/5/8/2/1/2 | 9/9/2 | Q16 approved, Q18 changes requested, Q19 submitted, Q20 draft |
| III | TCS 302 | Data structures with C | 9–11 | 6 | 10 / 10 / 9 / 9 / 8 | 29 | 20 | 9 | 1/5/8/4/1/1 | 6/10/4 | Q16 approved, Q17 changes requested, Q18 submitted, Q19 draft |
| III | TCS 308 | Logic Design & Computer Organization | 7–8 | 6 | 10 / 8 / 10 / 10 / 10 | 19 | 20 | 8 | 3/3/9/2/2/1 | 9/9/2 | Q16 approved, Q18 changes requested, Q19 submitted, Q20 draft |
| III | TMA 316 | Discrete Structures and Combinatorics | 14–16 | 6 | 11 / 9 / 9 / 10 / 9 | 20 | 20 | 8 | 0/4/12/3/0/1 | 5/12/3 | Q16 approved, Q17 changes requested, Q19 submitted, Q20 draft |
| IV | TCS 402 | Finite Automata and Formal Languages | 53–54 | 6 | 10 / 10 / 9 / 10 / 8 | 20 | 20 | 8 | 1/5/5/4/1/4 | 4/11/5 | Q16 approved, Q17 changes requested, Q19 submitted, Q20 draft |
| IV | TCS 408 | Programming in Java | 51–52 | 6 | 10 / 9 / 9 / 9 / 9 | 19 | 20 | 8 | 3/6/5/4/1/1 | 8/10/2 | Q15 approved, Q17 changes requested, Q19 submitted, Q20 draft |
| IV | TCS 409 | Design and Analysis of Algorithms | 57–59 | 6 | 8 / 10 / 12 / 10 / 10 | 20 | 20 | 8 | 2/4/9/3/2/0 | 6/11/3 | Q15 approved, Q16 changes requested, Q18 submitted, Q20 draft |
| V | TCS 503 | Database Management System | 119–121 | 6 | 9 / 9 / 11 / 9 / 10 | 20 | 20 | 8 | 3/6/6/4/0/1 | 5/11/4 | Q16 approved, Q18 changes requested, Q19 submitted, Q20 draft |
| V | TCS 571 | Big Data Visualization | 130–131 | 6 | 10 / 10 / 9 / 9 / 8 | 19 | 20 | 7 | 3/6/4/4/2/1 | 8/9/3 | Q15 approved, Q18 changes requested, Q19 submitted, Q20 draft |
| VI | TCS 601 | Compiler Design | 170–172 | 6 | 9 / 9 / 8 / 9 / 9 | 20 | 20 | 8 | 1/8/8/2/0/1 | 5/12/3 | Q16 approved, Q18 changes requested, Q19 submitted, Q20 draft |
| VI | TCS 611 | Software Engineering | 172–175 | 6 | 10 / 9 / 8 / 10 / 8 | 20 | 20 | 7 | 3/7/6/1/2/1 | 7/10/3 | Q16 approved, Q18 changes requested, Q19 submitted, Q20 draft |
| VII | TCS 703 | Computer Networks II | 223–225 | 6 | 9 / 10 / 9 / 9 / 8 | 20 | 20 | 7 | 3/7/5/3/2/0 | 7/10/3 | Q16 approved, Q18 changes requested, Q19 submitted, Q20 draft |
| VII | TCS 704 | Advanced Computer Architecture | 225–227 | 6 | 9 / 10 / 10 / 8 / 8 | 20 | 20 | 8 | 2/7/6/3/1/1 | 7/10/3 | Q16 approved, Q17 changes requested, Q18 submitted, Q20 draft |
| | **Total** | | | **84** | **70 units** | **301** | **280** | | 29/80/96/42/16/17 | 93/145/42 | 56 (4 per subject) |

Bloom columns: Remember / Understand / Apply / Analyze / Evaluate / Create. Question types used across the dataset:
short_answer 96, numerical 45, mcq 43, true_false 19, programming 17, long_answer 15, assertion_reason 15, case_study 14, fill_blank 8, proof 4, derivation 4. Diagram questions are not seeded (activation requires an uploaded diagram); descriptive questions are
represented by long-answer questions.

## How the data was checked (`src/demo-dataset.js`, enforced by the seed and `npm run test:unit`)

- Every verified topic appears verbatim in its unit's text in the PDF (the source's own spellings are kept, e.g.
  "uncheced Exceptions", "JBDC drivers").
- Every question belongs to one subject, one unit and one verified topic of that unit, and maps only to that subject's
  own COs (CO1 of one subject is never another subject's CO1).
- Bloom levels and difficulty use the shared taxonomy (`src/taxonomy.js`); every question passes the app's own
  type-specific validation for activation; no duplicate questions; every unit has questions.
- Every CO has at least one question, or carries an HOD flag explaining why it cannot have one.
- Numerical and worked answers were checked by hand (and some recomputed in code); reviewer-style mistakes caught
  during authoring were corrected.

## Recorded HOD decisions

| Subject | Kind | Detail |
|---|---|---|
| TCS 503 | Source irregularity | Unit 3 has no "Unit 3" label in the PDF; it is identified by its row number (11 hours). The parser reports this as a warning. |
| TCS 503 | Correction | Unit 5 reads "Lock 9Management" in the PDF (the unit's hours printed inside the text); corrected to "Lock Management" during verification. The original text is kept alongside. |
| TCS 409 | Gap flag | CO3 ("back tracking and branch and bound techniques") is not covered by any unit of the printed syllabus (pages 57-59), so no question maps to it. A blueprint that requires CO3 is refused (Scenario B). |

## Seeding

```bash
cd backend
npm run seed                 # base accounts, CSE department, B.Tech program, 2026-2027 session
npm run seed:demo            # the 14 subjects, syllabi and 280 questions (safe to run again)
npm run seed:demo -- --check # validate the dataset only (no database needed)
```

`seed:demo` starts the API in-process and acts through the normal routes as each role: the HOD creates the subjects,
offerings and syllabus versions (verify, submit, approve), assigns teachers (two per subject) and reviewers, and runs
review batches; teachers write and submit the questions with their subject's own COs; reviewers verify the
classification, decide and activate. Every validation, scope check, quality gate, audit entry and database trigger
applies. Only the demo accounts are inserted directly, as `seed.js` does. It refuses to run with
`NODE_ENV=production`, and reruns only move things forward (nothing is created twice).

After seeding, each subject has 16 ACTIVE questions and one each APPROVED, CHANGES_REQUESTED, SUBMITTED and DRAFT. The
four are chosen so that the ACTIVE questions still cover every unit and every CO the subject can cover.

Demo accounts (development passwords, published in this repository): the ones printed by `npm run seed`, plus
`reviewer2@portal.edu`, `reviewer3@portal.edu` and `reviewer.ece@portal.edu` (ECE department), password `Review@123`.

## Demo scenarios

| | Scenario | Where | How it is shown |
|---|---|---|---|
| A | Healthy subject | TCS 571 | Its ACTIVE bank covers all units and COs; a blueprint with hard CO targets generates a valid paper. `test-demo-scenarios.mjs` |
| B | Missing CO coverage | TCS 409 | A blueprint requiring CO3 is refused: "CO target CO3=2 but only 0 eligible question(s) map to CO3". |
| C | Bloom mismatch | TCS 101 | A blueprint requiring more Evaluate questions than are approved is refused with the shortfall. |
| D | Revision cycle | TCS 571, question 16 | The seed submits a first version, the reviewer requests changes, the author revises and resubmits, the reviewer approves, and it is activated; the history and audit show each step. |
| E | Syllabus version change | TCS 571 | The seed starts a new draft version from the active one; approving it (as the HOD) runs change detection and moves questions on unchanged items automatically. |
| F | Security | any | Route tests: a reviewer of another department, a reviewer without a seat on the batch, a teacher trying to create/verify/submit the syllabus, and a CO from another syllabus version are all refused and nothing is written. |

## Printed papers

Papers generated from these questions print in the institution's format (`backend/src/paper-pdf.js`). The internal
copy (with the answer key, for the COE and assigned validators) adds a "Paper Analysis" page with the distribution by
CO, Bloom level, syllabus unit and difficulty; a question mapped to several COs is counted under each of its COs. The
candidate copy carries none of this.
