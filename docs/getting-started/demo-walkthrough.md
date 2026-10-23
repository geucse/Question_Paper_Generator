# Guided demo walkthrough (about 45 minutes)

This tour shows every role and the complete path from the official syllabus to a printed paper, using the demo data.
Each part names the account to use. Keep the backend terminal visible: it shows each sign-in code.

**Before you start:** complete [Installation](installation.md) including `npm run seed:demo`, and set up the COE
authenticator ([how](demo-credentials.md#the-coes-authenticator-required-before-final-approval)).

The showcase subject is **TCS 571 Big Data Visualization** (taught by `teacher2` and `teacher3`, reviewed by
`reviewer`). Its 20 sample questions are listed in [demo-data/subjects/TCS571.md](../demo-data/subjects/TCS571.md).

---

## Part 1 — The official syllabus (HOD) · 8 minutes

Sign in as **`hod@portal.edu`** (`Hod@12345`).

1. In the sidebar choose **Review workspace**, then **Manage academics → Syllabus versions**.
2. In **Course offering**, choose **TCS 571 — Big Data Visualization**.
3. Look at the version list:
   - **Version 1 — Active**: the syllabus the demo questions were written against. Its course outcomes and units are listed
     with each version; the step indicator shows it has completed every step.
   - **Version 2 — Draft**: a revised version started from version 1 (scenario E). Nothing in it is in force until it is
     approved.
4. **Upload the official PDF.** In **Upload the official syllabus (PDF)** choose
   `backend/data/syllabus-2023/Syllabus-2023-New.pdf` and select **Upload and extract**. After a few seconds a new
   **Draft** version appears with:
   - the six course outcomes exactly as printed on pages 130–131,
   - five units with their contact hours (10, 10, 9, 9, 8) and the topics extracted from each,
   - any warnings to check, and a **View the official PDF (pages 130–131)** button.

   Nothing has been published: the draft must be reviewed, confirmed (**Verify content**), submitted and approved.
   Use **Reject** with a reason if you do not want to keep this extra draft.
5. **See a wrong document refused.** Switch the offering to **DSA101** and upload the same PDF. The portal explains that
   the PDF does not contain DSA101 and lists the courses it does contain.
6. **See a source irregularity reported.** Switch to **TCS 503 Database Management System** and upload the PDF again. The
   warning says that unit 3 has no "Unit 3" label in the document and was identified by its row number. (Reject this
   draft afterwards.)

What this shows: only the HOD publishes the syllabus; extraction is exact and its uncertainties are shown, never hidden.

## Part 2 — Writing and revising questions (Teacher) · 8 minutes

Sign in as **`teacher2@portal.edu`** (`Teach@123`).

1. **Read the syllabus.** Under **Write & submit** open the **Syllabus** tab and pick **TCS 571**. The active syllabus
   is read-only: course outcomes, units and topics, and the link to the official PDF. Teachers cannot change it.
2. **See your questions' states.** Open **Question status** in the sidebar. TCS 571 has questions in every state:
   Active, Approved, Changes requested, Submitted and Draft. The overview at the top counts them.
3. **Respond to a change request.** Find the question in **Changes requested** (the reviewer's comment is shown with it).
   Use **Revise**, improve the question as asked, save it, and submit it again. It becomes **Resubmitted**.
4. **Write a new question.** Back in **Write & submit → Write a question**:
   - choose the TCS 571 offering, the question type (for example *Short Answer*), difficulty, Bloom level and marks;
   - place it on a **unit and topic** of the syllabus (for example Unit 3, "Choropleth map");
   - write the question and the model answer;
   - select **Save & Preview**. The preview shows the question as candidates will see it and runs the duplicate check;
   - submit it with a **primary course outcome** (and any secondary ones) from TCS 571's own CO list.

What this shows: every question is tied to a real topic and to its own subject's COs, and returned questions keep their
history.

## Part 3 — Organising the review (HOD) · 4 minutes

Sign in as **`hod@portal.edu`**.

1. **Review workspace → Review batches.** Create a batch for **TCS 571** with the waiting questions (the submitted demo
   question, the resubmitted one and your new one) using **Create batch**.
2. Assign the offering's reviewer (`reviewer@portal.edu`) to the batch. The questions move to **Under review**.

## Part 4 — Reviewing (Reviewer) · 6 minutes

Sign in as **`reviewer@portal.edu`** (`Review@123`).

1. **Review workspace → Review batches**, open the TCS 571 batch.
2. For each question:
   - read it with its answer;
   - verify the **difficulty, Bloom level, course outcome, unit and topic** (correct them if the author chose wrongly);
   - tick the **review checklist** (syllabus alignment, correctness, clarity, CO, Bloom, difficulty, answer key, marks) and
     **Answer approved**;
   - choose **Accept** and **Submit verdict**. (To return a question, choose *Request revision* and write a comment.)
3. Select **Complete review** with a short summary, then apply the decision to each question (it becomes **Approved**).
4. Activate the approved questions. Activation runs the quality gate: syllabus version, topic, CO mapping, answer and
   reviewer approval must all be in place.

What this shows: nothing reaches the paper bank without an independent review and a full classification check.

## Part 5 — Generating a paper (COE) · 6 minutes

Sign in as **`coe@portal.edu`** (`Coe@123456`).

1. **Examinations & Blueprints → Create examination**: course offering **TCS 571**, exam type **Mid-term**,
   **Maximum marks 20**, **Duration 45** minutes, and a date.
2. Add a **blueprint**: 2 easy, 3 medium, 1 hard question, 20 total marks; **CO targets** `CO6:1, CO3:1`. Save it.
3. Select **Check feasibility**: the portal reports whether the active question bank can meet every target.
4. Select **Generate paper**. The paper appears under **Papers** with its automated validation: CO and Bloom targets,
   achieved values and any warnings.
5. **Preview paper** shows the printable paper exactly as it will print, with a DRAFT watermark until it is final.
6. Assign **exactly four validators** (`validator1` to `validator4`) and select **Assign & send for validation**.

## Part 6 — Validation (four Validators) · 6 minutes

Sign in as **`validator1@portal.edu`** (`Valid@12345`) and repeat for validators 2, 3 and 4.

1. **Validation queue**: open the paper with **Review**.
2. Read the questions (their printed numbering and COs are shown) and preview the PDF with the answer key.
3. Optionally **Report issue** on a question.
4. Tick all 11 checklist items and **Approve** (or choose *Changes required* with comments). Each decision is final.

## Part 7 — Final approval and printing (COE) · 4 minutes

Sign in as **`coe@portal.edu`**.

1. **Papers**: open the paper. It shows *approvals 4/4*.
2. **Final COE approval**: enter the 6-digit **Authenticator code** from your app and **Approve**.
3. **Lock for printing.** The paper becomes **PRINT_READY**; the DRAFT watermark disappears.
4. **Download paper** gives the candidate copy in the institution's format (roll number line, examination details,
   numbered instructions, question table with marks and CO, page numbers). **Download paper with answer key** gives the
   internal copy, which ends with a **Paper Analysis** page (distribution by CO, Bloom level, unit and difficulty) and the
   answer key.

## Part 8 — When targets cannot be met (COE) · 3 minutes

Still as **`coe@portal.edu`**:

1. **Scenario B — missing CO.** Create an examination for **TCS 409 Design and Analysis of Algorithms** with a blueprint
   whose CO targets include `CO3:2`. Generation is refused: *"CO target CO3=2 but only 0 eligible question(s) map to CO3"*.
   The printed TCS 409 syllabus has no unit covering CO3 (backtracking, branch and bound), so the HOD flagged it.
2. **Scenario C — Bloom mismatch.** For **TCS 101**, set Bloom targets of 50% Evaluate and 50% Analyze. Generation is
   refused with the shortfall (only one approved Evaluate question exists).

The portal never relaxes a target on its own. The COE can revise the blueprint, ask the department for more questions,
or record an explicit override with a reason that every validator sees.

## Part 9 — Access control (Scenario F) · 2 minutes

1. Sign in as **`reviewer.ece@portal.edu`**: an ECE reviewer sees none of the CSE offerings, batches or questions.
2. As a teacher, the **Syllabus** tab offers no way to create, verify or approve a syllabus; the server refuses such
   requests even when sent directly.
3. As **`admin@portal.edu`**, notice that the administrator manages accounts and policies but has no academic actions
   (no approving, reviewing or generating).

## Part 10 — Administration (Admin) · 2 minutes

Sign in as **`admin@portal.edu`** (`Admin@12345`): **System** shows readiness and protections, **Accounts** creates
and manages users, **Validation policy** sets how many validator approvals a paper needs, and **Structure & security**
holds the academic hierarchy and the audit tools.

---

**Next:** the role guides explain every screen in detail — [Teacher](../user-guide/teacher.md),
[HOD](../user-guide/hod.md), [Reviewer](../user-guide/reviewer.md), [COE](../user-guide/coe.md),
[Validator](../user-guide/validator.md), [Administrator](../user-guide/admin.md).
