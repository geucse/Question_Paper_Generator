# Demo data: sample syllabus and questions

> All 280 questions are **DEMO / SAMPLE** content for testing the portal. The syllabus data (subjects, COs, units, hours) is the official Graphic Era 2023 CSE syllabus.

Source: `backend/data/syllabus-2023/Syllabus-2023-New.pdf` (316 pages, SHA-256 `df70a961856eef533a00bac09c1eeb4533474e382d5e0a80692a21f61ed6ec07`). Loaded by `npm run seed:demo`. Full background: [demo data catalog](CATALOG.md).

**Totals:** 14 subjects · 280 questions · 84 course outcomes · 70 units · 301 verified topics.

| Sem | Code | Title | PDF pages | COs | Units | Topics | Questions | Teachers | Reviewer |
|---|---|---|---|---|---|---|---|---|---|
| I | [TCS 101](subjects/TCS101.md) | Fundamental of computer and Introduction to Programming | 1–3 | 6 | 5 | 28 | 20 | teacher1, teacher2 | reviewer |
| II | [TCS 201](subjects/TCS201.md) | Programming for Problem Solving | 4–6 | 6 | 5 | 27 | 20 | teacher2, teacher3 | reviewer2 |
| III | [TCS 302](subjects/TCS302.md) | Data structures with C | 9–11 | 6 | 5 | 29 | 20 | teacher3, teacher4 | reviewer3 |
| III | [TCS 308](subjects/TCS308.md) | Logic Design & Computer Organization | 7–8 | 6 | 5 | 19 | 20 | teacher4, teacher1 | reviewer |
| III | [TMA 316](subjects/TMA316.md) | Discrete Structures and Combinatorics | 14–16 | 6 | 5 | 20 | 20 | teacher1, teacher2 | reviewer2 |
| IV | [TCS 402](subjects/TCS402.md) | Finite Automata and Formal Languages | 53–54 | 6 | 5 | 20 | 20 | teacher2, teacher3 | reviewer3 |
| IV | [TCS 408](subjects/TCS408.md) | Programming in Java | 51–52 | 6 | 5 | 19 | 20 | teacher3, teacher4 | reviewer |
| IV | [TCS 409](subjects/TCS409.md) | Design and Analysis of Algorithms | 57–59 | 6 | 5 | 20 | 20 | teacher4, teacher1 | reviewer2 |
| V | [TCS 503](subjects/TCS503.md) | Database Management System | 119–121 | 6 | 5 | 20 | 20 | teacher1, teacher2 | reviewer3 |
| V | [TCS 571](subjects/TCS571.md) | Big Data Visualization | 130–131 | 6 | 5 | 19 | 20 | teacher2, teacher3 | reviewer |
| VI | [TCS 601](subjects/TCS601.md) | Compiler Design | 170–172 | 6 | 5 | 20 | 20 | teacher3, teacher4 | reviewer2 |
| VI | [TCS 611](subjects/TCS611.md) | Software Engineering | 172–175 | 6 | 5 | 20 | 20 | teacher4, teacher1 | reviewer3 |
| VII | [TCS 703](subjects/TCS703.md) | Computer Networks II | 223–225 | 6 | 5 | 20 | 20 | teacher1, teacher2 | reviewer |
| VII | [TCS 704](subjects/TCS704.md) | Advanced Computer Architecture | 225–227 | 6 | 5 | 20 | 20 | teacher2, teacher3 | reviewer2 |

## Questions by type

| Type | Count |
|---|---|
| Short Answer | 96 |
| Numerical | 45 |
| MCQ | 43 |
| True/False | 19 |
| Programming | 17 |
| Long Answer | 15 |
| Assertion-Reason | 15 |
| Case Study | 14 |
| Fill in the Blank | 8 |
| Proof | 4 |
| Derivation | 4 |

## Questions by Bloom level and difficulty

| Bloom level | Count | | Difficulty | Count |
|---|---|---|---|---|
| Remember | 29 | | Easy | 93 |
| Understand | 80 | | Medium | 145 |
| Apply | 96 | | Hard | 42 |
| Analyze | 42 | |  |  |
| Evaluate | 16 | |  |  |
| Create | 17 | |  |  |

## Lifecycle after seeding

Each subject: **16 Active** questions (covering every unit and every CO the subject can cover) and one each **Approved**, **Changes requested**, **Submitted** and **Draft**. Each subject page shows which.
