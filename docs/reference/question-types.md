# Question types

The portal supports 13 question types. Every type needs: question text (at least 10 characters for activation),
marks (a whole number above 0), difficulty, Bloom level, a syllabus topic, a CO mapping, and a **model answer or solution**
(at least 5 characters). The table lists what each type needs in addition. The same rules are checked when saving, at
activation (in the database) and in bulk uploads.

| Type | Group | Additional requirements | Printed as |
|---|---|---|---|
| **MCQ** | Objective | Four options (A–D) and the correct answer | Question with (A)–(D) |
| **True/False** | Objective | Correct answer TRUE or FALSE | Question with "(True / False)" |
| **Fill in the Blank** | Objective | Each blank marked with `___` in the text, and exactly one accepted answer per blank | Text with blanks |
| **Assertion-Reason** | Objective | An assertion, a reason, and the correct option A–D (fixed wording below) | Assertion (A), Reason (R) and options A–D |
| **Numerical** | Objective | The expected value (a number); optional tolerance (≥ 0) and unit | Question, plus "(Give the answer in …)" when a unit is set |
| **Short Answer** | Subjective | — | Question |
| **Long Answer** | Subjective | — | Question |
| **Descriptive** | Subjective | — | Question |
| **Derivation** | Subjective | — | Question |
| **Proof** | Subjective | — | Question |
| **Programming** | Subjective | The programming language; optional constraints | Code in a monospace block with indentation kept; "Language: …" |
| **Case Study** | Subjective | The case text (at least 20 characters) | "Case:" printed before the question |
| **Diagram** | Subjective | An attached diagram (PNG or JPEG), virus-scanned, before activation | The diagram embedded under the question |

Assertion-Reason options (fixed, only the letter is stored):

- (A) Both A and R are true, and R is the correct explanation of A
- (B) Both A and R are true, but R is not the correct explanation of A
- (C) A is true, but R is false
- (D) A is false, but R is true

Answer keys print only on the **internal copy** of a paper (COE and assigned validators). Examples of every type except
Diagram and Descriptive are in the [demo data](../demo-data/README.md).
