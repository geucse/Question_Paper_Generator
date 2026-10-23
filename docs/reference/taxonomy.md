# Bloom's taxonomy, course outcomes and difficulty

## Bloom's taxonomy (revised)

One shared definition is used across the system (`backend/src/taxonomy.js`); the database accepts only these values.

| Level | Stored as | The question asks the candidate to… | Typical verbs |
|---|---|---|---|
| Remember | `remember` | Retrieve facts and definitions | define, list, name, state |
| Understand | `understand` | Explain, summarise, interpret, classify | explain, describe, distinguish, summarise |
| Apply | `apply` | Use a method, formula or algorithm on a concrete problem | compute, solve, implement, trace |
| Analyze | `analyze` | Break down, compare, diagnose, trace causes or structure | compare, analyse, examine, determine why |
| Evaluate | `evaluate` | Justify a choice against criteria, critique, assess alternatives | justify, recommend, assess, critique |
| Create | `create` | Design, construct or develop a new solution | design, construct, develop, formulate |

Judge the level by what the answer **requires**, not by the topic or a single verb. "Explain why the algorithm is
O(n log n)" is Understand; "Choose between two algorithms for this workload and justify it" is Evaluate.

## Course outcomes (COs)

- COs belong to **one subject's syllabus version**. CO1 of TCS 571 and CO1 of TCS 101 are different outcomes; a question
  can only be mapped to the COs of its own subject's version (the server refuses others).
- Each question has one **primary** CO and optionally **secondary** COs, chosen by the teacher and verified by the
  reviewer.
- **Several COs:** a question mapped to several COs counts toward **each** of them. CO targets in a blueprint count
  questions this way, and so does the Paper Analysis page (whose CO rows can therefore add up to more than the number of
  questions; the page says so).
- A CO with no possible question (because no syllabus unit covers it) is a gap the HOD must resolve, never filled with
  questions from other topics. Example: TCS 409 CO3 in the demo data.

## Difficulty

| Level | Stored as | Guidance |
|---|---|---|
| Easy | `easy` | Direct recall or a one-step application |
| Medium | `medium` | Several steps, or applying a method to a new case |
| Hard | `hard` | Extended reasoning, design, or combining several topics |

## Targets in a blueprint

- **Difficulty counts** are exact.
- **CO targets** are numbers of questions per CO (`CO1:2, CO3:1`).
- **Bloom targets** are percentages; at 100% the distribution is exact, below 100% the listed levels get that share.
- With hard targets enabled, generation either meets every target or is refused with the reason. Only the COE can
  override a CO/Bloom target, with a reason that validators see.
