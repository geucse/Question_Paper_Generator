# Reviewer guide

As a reviewer you are the independent check between a teacher's question and the examination bank. You confirm that each
question belongs to the syllabus, is correct and clear, is mapped to the right course outcome, has the right Bloom level,
difficulty and marks, and has a correct answer key. Only questions you (or the other assigned reviewers) accept can be
activated and used in papers.

Demo account: `reviewer@portal.edu` / `Review@123` (reviews TCS 571, TCS 101, TCS 308, TCS 408 and TCS 703 in the demo
data, plus DSA101). `reviewer2` and `reviewer3` review the other demo subjects.

## Your workspace

| Sidebar section | Contents |
|---|---|
| **Question lifecycle** | Questions of the offerings you review, by status |
| **Review workspace** | **Dashboard**, **Syllabus changes**, **Review batches**, **Authenticator setup** |
| **Analytics & coverage** | Coverage and generation readiness of your offerings |

You see only the course offerings the HOD assigned you to review. You can read their syllabus but not change it.

## How a review round works

1. The HOD puts submitted questions in a **review batch** and assigns you to it. The questions are **Under review**.
2. You record a **verdict** on each question.
3. You **complete** the batch with a short summary.
4. The decision is applied to each question: **Approved**, **Changes requested** or **Rejected**.
5. Approved questions are **activated**; activation re-checks everything (the quality gate) before the question enters
   the bank.

If several reviewers share a batch, a question is approved only when **every** verdict accepts it and the
classifications agree. When they disagree, the HOD resolves it (decides, adds a reviewer or asks for a re-review); a
split is never averaged. A question is rejected only if every reviewer rejects it; otherwise any rejection or revision
request returns it to the author.

## Recording a verdict

Open **Review workspace → Review batches**, open the batch, and for each question:

1. **Read the question in full**: the text, options or case, attachments, and the **model answer / answer key**.
2. **Verify the classification**. The author's choices are pre-filled; correct anything that is wrong:
   - **Difficulty** (easy, medium, hard)
   - **Bloom level** (remember, understand, apply, analyze, evaluate, create)
   - **Course outcome**: only this subject's COs are offered
   - **Unit**, **topic** and optionally **subtopic** of the syllabus
3. **Review checklist.** Tick each point you have confirmed:

   | Checklist item | Ask yourself |
   |---|---|
   | Matches the selected syllabus unit and topic | Is this really examined under that topic of *this* subject's syllabus? |
   | Technically correct | Are the facts, data and wording of the question correct? |
   | Clear and unambiguous | Could a candidate reasonably read it two ways? |
   | CO fits | Does the question actually assess this course outcome? |
   | Bloom level fits | Does the task demand that level of thinking? ("List" is Remember; "design" is Create.) |
   | Difficulty fits | Is the expected effort easy, medium or hard for this course? |
   | Answer key correct and complete | Is the answer right, and complete enough to mark against? |
   | Marks fit | Do the marks match the expected answer? |

4. Set the flags if needed: **Ambiguous**, **Possible duplicate**, and **Answer approved** when the answer is right.
5. Choose the decision:
   - **Accept**: requires every checklist item, every classification field, **Answer approved**, and no flags.
   - **Request revision**: the author must fix something; the **comment is required** and should say exactly what.
   - **Reject**: the question cannot be fixed (out of syllabus, fundamentally wrong); a comment is required.
6. Select **Submit verdict**. You can change it (**Update verdict**) until the batch is decided.

Then select **Complete review** and write a short summary of the batch. Finally apply the decision to each question.

## Rules that protect the review

- You **cannot review your own question** (if you also write questions).
- You can act only on batches you are assigned to, in offerings you are assigned to. Anything else is refused and
  logged; you are not even told the state of other batches.
- A CO from another subject or another syllabus version is refused.
- Automated findings (spelling, clarity, duplicates) shown with a question are **advisory**. The decision is yours.

## Syllabus changes

When the HOD approves a new syllabus version, questions on changed or removed items are listed under **Syllabus
changes**. Re-review them against the new version: confirm the new placement and CO, or return them to the author.

## Activation

An approved question becomes **Active** through activation, which re-runs the quality gate: approved syllabus version,
topic in that version, CO mapping, Bloom level, difficulty, marks, type-specific answer fields, model answer, and your
approval. If anything is missing, activation is refused with the list of problems.

## Examples to practise on

The demo data includes questions of 11 types with their intended classification and model answers; for example
[TCS 571](../demo-data/subjects/TCS571.md). After `npm run seed:demo`, each subject has one question **Submitted** and
waiting for a batch: ask the HOD to create one and review it.
