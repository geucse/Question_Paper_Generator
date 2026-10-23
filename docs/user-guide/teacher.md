# Teacher guide

As a teacher you write questions for the subjects the HOD assigned to you. Each question is placed on a topic of the
**official syllabus**, mapped to that subject's own **course outcomes (COs)**, classified by **Bloom level** and
**difficulty**, and reviewed by an independent reviewer before it can ever appear in an examination paper.

Demo account: `teacher2@portal.edu` / `Teach@123` (teaches TCS 571 and others; see
[assignments](../getting-started/demo-credentials.md#who-is-assigned-to-what-after-npm-run-seeddemo)).

## Your workspace

| Sidebar section | What it is for |
|---|---|
| **Write & submit** | Writing, previewing, uploading and submitting questions; reading the syllabus |
| **Question status** | Every question you have written, in every state, with its history and any reviewer comments |

The overview at the top shows **Needs revision** (returned to you), **Drafts**, **With reviewers** and **Live in the
bank** (active), with a status bar of all your questions.

At the top of *Write & submit* you see the course offering you are writing for. If you teach several, choose the
offering first. **Access until** shows the HOD's submission deadline for you; after it you can still read but not submit.

## 1. Read the official syllabus

**Write & submit → Syllabus** shows, for the chosen offering:

- the **active** syllabus version: its course outcomes (CO1, CO2, …) and its units with topics and subtopics;
- **View the official PDF** when the version was extracted from the department's syllabus document;
- a note when the HOD is preparing a new version (the active one stays in force until it is approved).

The syllabus is **read-only** for teachers. If something is wrong in it, tell your HOD (who alone can change it).

## 2. Choose objective or subjective

The two tabs **Objective questions** and **Subjective questions** group the 13 question types:

- *Objective:* MCQ, True/False, Fill in the Blank, Assertion-Reason, Numerical.
- *Subjective:* Short Answer, Long Answer, Descriptive, Derivation, Proof, Programming, Case Study, Diagram.

What each type needs is listed in [Question types](../reference/question-types.md).

## 3. Write a question

Under **Write a question**:

1. **Question type.** The form changes to the fields that type needs (options for MCQ, the assertion and reason, the
   expected value and unit for numerical, the case text, the programming language, the accepted answers for each blank…).
2. **Question text.** For programming questions, put code between triple back-ticks (```) to keep its layout.
3. **Placement.** Choose the **unit**, **topic** and (optionally) **subtopic** of the active syllabus. A question must
   sit on a real topic of its own subject.
4. **Classification.** Choose **difficulty** (easy, medium, hard), **Bloom level** (remember → create) and **marks**.
   See [Taxonomy and outcomes](../reference/taxonomy.md) for how to judge Bloom levels.
5. **Answer.** Write the **model answer** (and the answer key fields of the type). Reviewers check it; the answer key is
   printed only on the internal copy of a paper.
6. **Diagram** questions need the diagram attached as a PNG or JPEG (it is virus-scanned; **Scan again** retries a scan).

Then:

- **Save draft** keeps it as a draft you can return to.
- **Save & Preview** saves it and shows it as candidates will see it.

## 4. Preview, duplicate check and submission

The preview runs a **duplicate check** against the bank of the offering:

| You see | Choose |
|---|---|
| *Possible existing question* | **Use Existing Question** (withdraw yours as a duplicate) or **This Is Different** |
| *Related question found* | **Yes, Related (keep both)** or **Not Related** |

Pending duplicate decisions must be resolved before submitting.

To submit, choose the **primary course outcome** and any **secondary** ones. Only the COs of this subject's active
syllabus are offered. Then select **Confirm & Submit Final**.

After submission an **automated check** looks at spelling, clarity, duplicates and topic balance. Its findings are
**advisory**: they never change the question's status. If you disagree, use **Dispute automated findings** and explain.

## 5. Follow your questions (Question status)

The list can be filtered by status. Each question shows its full content, its path (Draft → Submitted → Under review →
Approved → Active) and its history.

| Status | Meaning | What you can do |
|---|---|---|
| **Draft** | Not submitted | Edit, preview, submit |
| **Submitted** | Waiting for a review batch | **Withdraw to draft and edit** if you need to change it |
| **Under review** | A reviewer is checking it | Wait |
| **Changes requested** | The reviewer returned it with a comment | **Revise**, then **Confirm & Resubmit** |
| **Resubmitted** | Your revision is waiting for review again | Wait |
| **Approved** | Accepted by the reviewer | Wait for activation |
| **Active** | In the bank; may be selected for papers | Nothing (changes go through the HOD) |
| **Rejected** | Not accepted (final) | Read the reason |
| **Retired** | Removed from use by the HOD | Read the reason |

**Revising** keeps the question's history: the reviewer sees what changed. Use **Send note to HOD** to raise anything
about a question with your HOD.

## 6. Bulk upload

**Bulk upload** adds many questions at once from a spreadsheet:

1. **Download template (.xlsx, one example per question type)**.
2. Fill one row per question (type, text, options or answers, difficulty, Bloom level, marks, topic, CO codes such as
   `CO1;CO3`).
3. **Upload filled file**. Every row is validated and the result is shown first: how many rows are valid, and a table
   of the rows with errors (with the problem) and of notes. **Nothing is submitted yet.**
4. Select **Confirm & submit N questions**. Each valid row goes through the same checks as a normal submission and is
   **submitted for review**; diagram questions (which still need their diagram) and rows that may duplicate an existing
   question are saved as **drafts** for you to finish under *My questions*. Rows with errors are skipped. Nothing is
   ever made Active by an upload.

## Good practice

- One question, one clear task. State exactly what the answer must cover; that is what reviewers check most.
- Choose the Bloom level from what the question **demands** ("design", "justify", "compare"), not from its topic.
- Make the marks match the expected answer length and effort.
- Map to the CO the question really assesses; add a secondary CO only if it is genuinely assessed too.

## Sample questions

The demo data contains 280 worked examples across 11 question types, each with its CO, Bloom level, difficulty and model
answer: see [Demo data](../demo-data/README.md).
