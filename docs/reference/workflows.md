# Workflows and state machines

Every status change below is enforced twice: by the API route (role, scope, preconditions) and by the database (a
trigger refuses any transition not in these diagrams). Every change is audited.

## End-to-end flow

```mermaid
flowchart LR
  A[HOD uploads / enters syllabus] --> B[HOD verifies, submits, approves<br/>syllabus version ACTIVE]
  B --> C[HOD assigns teachers and reviewers]
  C --> D[Teachers write questions<br/>on syllabus topics, with COs]
  D --> E[HOD creates review batch]
  E --> F[Reviewers verify and decide]
  F -->|changes requested| D
  F -->|approved| G[Activation<br/>quality gate]
  G --> H[(Active question bank)]
  H --> I[COE: examination + blueprint<br/>generate paper]
  I --> J[4 validators decide]
  J -->|changes required| I
  J -->|approved| K[COE final approval<br/>with authenticator]
  K --> L[Lock for printing<br/>PRINT_READY]
```

## Syllabus version

```mermaid
stateDiagram-v2
  [*] --> DRAFT: HOD uploads PDF / creates / copies current
  DRAFT --> TEACHER_VERIFIED: Verify content (HOD)
  TEACHER_VERIFIED --> HOD_REVIEW: Submit for HOD review
  HOD_REVIEW --> ACTIVE: Approve (activate)
  TEACHER_VERIFIED --> DRAFT: Return to draft (reason)
  HOD_REVIEW --> DRAFT: Return to draft (reason)
  DRAFT --> REJECTED: Reject (reason)
  TEACHER_VERIFIED --> REJECTED
  HOD_REVIEW --> REJECTED
  ACTIVE --> SUPERSEDED: a newer version is approved
```

- Shown in the interface as *Draft → Content verified → In HOD review → Active*. (`TEACHER_VERIFIED` is the stored name
  from before syllabus publishing became HOD-only.)
- Content (COs, units, topics, subtopics) can change only in **DRAFT**. Verification and approval require at least one
  CO and at least one unit with a topic.
- Only one version of an offering is **ACTIVE**. Approving a version runs change detection (see the
  [HOD guide](../user-guide/hod.md#change-the-syllabus-later)).

## Question

```mermaid
stateDiagram-v2
  [*] --> DRAFT: teacher saves
  DRAFT --> SUBMITTED: submit (with COs)
  SUBMITTED --> DRAFT: withdraw to draft
  SUBMITTED --> UNDER_REVIEW: HOD puts it in a review batch
  UNDER_REVIEW --> APPROVED: all verdicts accept
  UNDER_REVIEW --> CHANGES_REQUESTED: any verdict requests revision / rejects
  UNDER_REVIEW --> REJECTED: all verdicts reject
  CHANGES_REQUESTED --> RESUBMITTED: author revises and resubmits
  RESUBMITTED --> UNDER_REVIEW: next review batch
  APPROVED --> ACTIVE: activation (quality gate)
  APPROVED --> CHANGES_REQUESTED
  ACTIVE --> RETIRED: HOD retires (reason)
  ACTIVE --> CHANGES_REQUESTED: e.g. syllabus item removed
  RETIRED --> ACTIVE: restore (quality gate again)
```

Rules worth knowing:

- Leaving **UNDER_REVIEW** is only possible as the recorded decision of the question's review batch.
- **APPROVED** must be recorded by an active reviewer who is not the author.
- **ACTIVE** requires the quality gate: approved syllabus version of the same offering, a topic in that version, a CO
  mapping, Bloom level, difficulty, marks > 0, question text, the type's answer fields, a model answer, the reviewer's
  approval, and no unresolved duplicate.
- **REJECTED** is final. Only **ACTIVE** questions are ever selected for papers.

## Examination paper

```mermaid
stateDiagram-v2
  [*] --> GENERATED: Generate paper
  GENERATED --> VALIDATION_PENDING: assign 4 validators
  VALIDATION_PENDING --> VALIDATED: required approvals reached
  VALIDATION_PENDING --> CHANGES_REQUIRED: a validator requires changes
  VALIDATED --> COE_APPROVED: final approval + authenticator code
  VALIDATED --> CHANGES_REQUIRED: COE sends it back for changes
  COE_APPROVED --> PRINT_READY: Lock for printing
  GENERATED --> REGENERATED: COE regenerates (new revision)
  CHANGES_REQUIRED --> REGENERATED: COE regenerates (new revision)
  GENERATED --> ARCHIVED
  CHANGES_REQUIRED --> ARCHIVED
  REGENERATED --> ARCHIVED
  PRINT_READY --> ARCHIVED: end of the exam cycle
```

- A paper's questions are **frozen snapshots** taken at generation: later edits to the bank never change a generated
  paper, and the printed paper is always rendered from the snapshots.
- Until **PRINT_READY** every page of the PDF carries a DRAFT watermark.
- Open validator issues block final approval. The administrator's emergency reset can end a stuck validation round but
  cannot overturn a *changes required* decision.

## Review round with several reviewers

| Verdicts on a question | Result |
|---|---|
| Every reviewer accepts and the classifications agree | Approved |
| Every reviewer accepts but classifications differ | Waits for the HOD to resolve (decide, add a reviewer, or re-review) |
| At least one *request revision* or *reject* (not all reject) | Changes requested |
| Every reviewer rejects | Rejected |
