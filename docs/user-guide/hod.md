# Head of Department (HOD) guide

As HOD you own the department's **official syllabus**, decide **who teaches and who reviews** each course offering, run
the **review of questions**, and keep the question bank ready for examinations. You do not write questions and you do
not approve examination papers (that is the COE's role).

Demo account: `hod@portal.edu` / `Hod@12345` (CSE department).

## Your workspace

| Sidebar section | Contents |
|---|---|
| **Question lifecycle** | Every question of your department, by status; retire or restore active questions; export to Excel |
| **Review workspace** | **Attention**, **Review batches**, **Mistake detection**, **Manage academics**, **Authenticator setup** |
| **Analytics & coverage** | Whether the active bank can support paper generation, and where it has gaps |
| **Legacy papers** | Papers from the earlier HOD-led paper flow (kept for reference) |

The overview shows **Awaiting review**, **Approved, not yet live**, **Returned to authors** and **Live in the bank**,
with a status bar of every question in your scope.

**Manage academics** has six parts: **Build hierarchy**, **Assign people**, **User accounts**, **Syllabus versions**,
**Question mapping** and **Previous-year papers**.

---

## Recommended order of work

1. Build the structure (subjects and course offerings) — *Build hierarchy*.
2. Publish the official syllabus of each offering — *Syllabus versions*.
3. Assign teachers and reviewers — *Assign people*.
4. Teachers write and submit questions; you run review batches — *Review batches*.
5. Watch coverage and fill gaps before examinations — *Analytics & coverage*.

---

## 1. Build the academic structure

**Manage academics → Build hierarchy** creates, in order: sessions, programs, subjects (**Create subject**: code,
title, category), course offerings (**Create course offering**: subject, program, session, semester) and sections. A
course offering is "this subject, in this program, in this session and semester"; syllabi, assignments and questions
all belong to an offering.

## 2. Publish the official syllabus

**Manage academics → Syllabus versions**, then choose the **Course offering**.

Every syllabus is a sequence of **versions**. Each version moves through four steps, shown on its card:

| Step | Status | Your action |
|---|---|---|
| 1. Review and correct the content | Draft | Check COs, units and topics against the official document; add, correct or remove items |
| 2. Confirm it matches the official syllabus | Draft → Content verified | **Verify content** |
| 3. Submit for approval | Content verified → In HOD review | **Submit for HOD review** |
| 4. Approve to make it active | In HOD review → Active | **Approve (activate)** |

At any point before approval you can **Return to draft** (with what must be corrected) or **Reject** (with a reason).
An **Active** version never changes; approving a newer version makes the old one **Superseded**.

### Create a version from the official PDF (recommended)

1. In **Upload the official syllabus (PDF)** choose the department's syllabus PDF (up to 25 MB) and select **Upload and
   extract**.
2. The portal finds this offering's course in the document by its **subject code** (for example *TCS 571*) and creates a
   **Draft** version with:
   - the **course outcomes exactly as printed** (CO1, CO2, …);
   - the **units** with their **contact hours**;
   - **topics** split from each unit's text;
   - the PDF's page range, kept with the version (**View the official PDF**).
3. Read the **warnings**. They point out anything the extraction could not be sure of, for example a unit without a
   "Unit n" label, hours that do not add up to the stated total, a title that differs from the subject record, or a
   course with no printed COs.
4. Correct the draft (see below), then **Verify content**, **Submit for HOD review** and **Approve (activate)**.

What the upload will **not** do: publish anything, invent COs or topics, or read scanned (image-only) PDFs. If the
document does not contain the offering's course, you are told so and shown the courses it does contain. A PDF without COs
for the course cannot be verified: resolve that with the department first.

### Correct or enter content by hand

While a version is a **Draft**, each version card lets you:

- **Add CO** (code such as *CO3*, and its description) or remove one;
- **Add Unit** (code and title), **Add Topic** to a unit, **Add subtopic** to a topic, or remove any of them.

Every change is recorded in the audit log. Topics should use the syllabus's own wording: questions are placed on them
and reviewers check that placement.

### Change the syllabus later

Select **New version from current (version N)** on the active version. This copies it into a new draft. Edit, verify,
submit and approve it. On approval the portal compares the two versions:

- questions on **unchanged** units, topics and COs move to the new version automatically;
- questions on **changed or removed** items are listed under **Changes from the previous version** on the new version;
  for each you can **Map to version N** (choose the new unit, topic, CO and Bloom level, with a reason) or **Retire** it;
- approved questions on removed items go back to their authors as *Changes requested*.

**Question mapping** lists active questions whose placement is not yet reviewer-verified, so you can map them.

## 3. Assign teachers and reviewers

**Manage academics → Assign people**:

- **Assign teacher**: teacher, course offering, optional section. The teacher is notified and can write questions for
  that offering.
- **Assign reviewer**: reviewer and course offering. Reviewers review only offerings they are assigned to. Depending on
  the institution's policy, a reviewer cannot review an offering they also teach.

**User accounts** creates teacher and reviewer accounts for your department (they receive a setup code by email) and
lets you deactivate them. Other roles are created by the administrator.

## 4. Run the review

**Review workspace → Review batches**:

1. **Create batch**: choose the offering, give the batch a title and select the waiting questions (*Submitted* or
   *Resubmitted*). They move to **Under review**.
2. Assign one or more of the offering's reviewers to the batch (**Assign selected**).
3. Reviewers record verdicts and **Complete review** (see the [Reviewer guide](reviewer.md)).
4. When reviewers **disagree** on a question's classification (difficulty, Bloom level, CO, unit or topic), resolve it:
   decide the final values yourself (*HOD override*), add another reviewer, or ask for a re-review. A split verdict is
   never averaged.
5. **Close batch** when its questions are decided.

The **Attention** list shows questions that need your notice (for example escalations); it is read-only, because the
decisions belong to the assigned reviewers. **Mistake detection** runs automatic checks across a teacher's questions;
its findings are advisory.

## 5. Keep the bank ready (Analytics & coverage)

- **Generation readiness** counts the active questions usable by a new paper, and those not usable yet (mapping not
  reviewer-verified, or still on an earlier syllabus version).
- The **coverage grid** shows active questions per combination of syllabus item, CO, Bloom level and difficulty. Cells
  marked **0 (gap)** have no active question: a blueprint needing that combination will fail. Ask the teachers for
  questions there before the examination.
- **Usage & duplicates** shows recently used questions and duplicate candidates awaiting review.

A CO with no question at all is a real gap. In the demo data, **TCS 409 CO3** has none because the printed syllabus has
no unit on its topic (backtracking, branch and bound); see [Demo data](../demo-data/subjects/TCS409.md).

## 6. Question lifecycle

**Question lifecycle** lists every question of your scope with filters by status (Submitted, Under review, Changes
requested, Resubmitted, Approved, Active, Retired, Rejected). For an **Active** question you can **Retire** it (with a
reason; it stops being selectable for papers) and later restore it. **Export all to Excel** downloads the list.

## 7. Previous-year papers

**Manage academics → Previous-year papers** keeps earlier papers; questions from them can be added to the
previous-year bank for reference and duplicate checks.

## What the HOD cannot do

Write or submit questions, approve a question as its reviewer, create examinations, or approve papers. The portal also
refuses any action outside your department's scope.
