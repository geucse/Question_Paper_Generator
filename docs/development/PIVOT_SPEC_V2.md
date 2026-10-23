# Exam Portal --- Pivot Specification v2

> **Goal:** Modify the existing project incrementally. Do not rebuild.
> Preserve existing data and working functionality. Use safe migrations
> only.\
> **Completion rule:** Never claim completion until migrations, backend
> smoke tests, frontend build, and lint pass.

------------------------------------------------------------------------

## 1. Core Architecture

The system has **two separate domains** sharing one PostgreSQL database.

### A. Question Bank Domain

**Teacher → HOD → Reviewer**

Purpose: create, review, curate and maintain a trusted, structured,
versioned question dataset.

### B. Examination Domain

**COE → 4 Validators**

Purpose: generate examination papers only from approved/active
questions, validate the generated paper, and make it print-ready.

### Strict boundary

``` text
Question Bank ──READ ONLY──> Examination
Examination ──NO WRITE──> Question Bank
```

The HOD does **not** generate papers.

The Admin is **technical-only** and is never required for normal
academic actions.

------------------------------------------------------------------------

# 2. Roles

Supported roles:

``` text
teacher
hod
reviewer
admin
coe
validator
```

  Action                       Teacher        HOD   Reviewer   Admin   COE   Validator
  -------------------------- --------- ---------- ---------- ------- ----- -----------
  Create/edit own draft              ✓   optional                          
  Assign question reviewer                      ✓                          
  Review/approve question                                  ✓               
  Technical administration                                         ✓       
  Generate paper                                                         ✓ 
  Assign 4 validators                                                    ✓ 
  Validate paper                                                                     ✓
  Final paper approval                                                   ✓ 

Admin handles only:

-   database/system access
-   configuration
-   logs
-   technical maintenance
-   accounts/roles where required
-   migrations/emergency recovery

Admin must not participate in ordinary question or paper approval.

------------------------------------------------------------------------

# 3. Academic / Multi-Campus Hierarchy

Use immutable IDs, never names, for identity.

``` text
Institution
  ↓
Campus
  ↓
College
  ↓
Department
  ↓
Program
  ↓
Course
  ↓
Course Offering
  ↓
Subject
  ↓
Syllabus Version
  ↓
Unit
  ↓
Topic
  ↓
Subtopic
```

### Academic session

Add/use:

``` text
academic_sessions
```

Examples:

``` text
2025-26
2026-27
2027-28
```

A course offering belongs to an academic session.

### Course vs Subject

Keep the distinction clear:

``` text
Course
    = academic/program-level course definition

Subject
    = teachable subject

Course Offering
    = specific subject/program/campus/semester/session instance
```

Questions must ultimately be tied to the correct **course offering +
syllabus version**.

------------------------------------------------------------------------

# 4. Scope-Based Authorization

Permissions are:

``` text
Role + Scope
```

not role alone.

Add/use:

``` text
user_scopes
```

with appropriate:

``` text
user_id
role
institution_id
campus_id
college_id
department_id
program_id
course_offering_id / subject_id
```

Add one central backend authorization layer:

``` text
authorize(user, action, resource)
```

Check:

``` text
role
→ scope
→ resource context
→ ownership
→ conflict rules
→ allow/deny
```

Do not rely on frontend hiding.

### Mandatory isolation

Campus A data must never appear in Campus B queries.

HOD, Teacher and Reviewer see only their authorized academic scope.

COE/Validator access is restricted to their examination
assignments/scope.

------------------------------------------------------------------------

# 5. User Identity

Users should have:

``` text
user_id
employee_id
full_name
official_email
role
status
institution_id
campus_id
```

Use:

``` text
ACTIVE / INACTIVE
```

Never use names for authorization or uniqueness.

Keep inactive users for historical authorship/audit.

------------------------------------------------------------------------

# 6. Question Bank

Reuse existing question-bank functionality where possible:

``` text
questions
canonical_questions
question_versions
question_reviews
reviewer_assignments
question_course_outcomes
syllabus_*
dedup/similarity
audit_log
```

Do not rewrite working functionality unnecessarily.

------------------------------------------------------------------------

# 7. Question Lifecycle

``` text
DRAFT
 ↓
SUBMITTED
 ↓
UNDER_REVIEW
 ↓
CHANGES_REQUESTED ↔ RESUBMITTED
 ↓
APPROVED
 ↓
ACTIVE
 ↓
RETIRED
```

Terminal state:

``` text
REJECTED
```

Meaning:

-   `APPROVED` = academically approved.
-   `ACTIVE` = approved + all quality/eligibility gates passed and
    usable by paper generation.
-   `RETIRED` = cannot be selected for new papers.
-   `REJECTED` = rejected and not eligible.

Never let paper generation use anything except `ACTIVE`.

------------------------------------------------------------------------

# 8. Question Metadata

Question creation must use controlled fields/dropdowns wherever
possible.

### Academic context

``` text
Campus
College
Department
Program
Academic Session
Semester
Course Offering
Subject
Subject Code
Syllabus Version
Unit
Topic
Subtopic
```

### Assessment metadata

``` text
CO(s)
Bloom Level
Difficulty
Question Type
Marks
```

### Content

``` text
Question Text
Answer/Solution
Options (where applicable)
Tags
Source/Origin
```

### Controlled values

Bloom:

``` text
Remember (L1)
Understand (L2)
Apply (L3)
Analyze (L4)
Evaluate (L5)
Create (L6)
```

Difficulty:

``` text
Easy
Medium
Hard
```

Question types may include:

``` text
MCQ
Short Answer
Long Answer
Numerical
Derivation
Proof
Programming
Case Study
Diagram
Assertion-Reason
Fill in the Blank
True/False
Descriptive
```

Marks are always explicit.

------------------------------------------------------------------------

# 9. Course Outcomes

COs belong to the specific **course offering/syllabus context**.

Therefore:

``` text
CO3 of Computer Networks
≠
CO3 of DBMS
```

Multiple COs may map to one question through:

``` text
question_course_outcomes
```

CO definitions should be versioned with the academic/syllabus context
where necessary.

------------------------------------------------------------------------

# 10. Type-Specific Validation

Examples:

``` text
MCQ → options + correct answer required
Numerical → expected answer required
Programming → language/constraints where applicable
Diagram → required asset where applicable
```

A question cannot become `ACTIVE` if required metadata/type-specific
fields are missing.

------------------------------------------------------------------------

# 11. Question Quality Gate

To become `ACTIVE`, a question must have:

``` text
valid academic context
valid syllabus/topic mapping
CO
Bloom level
difficulty
marks
question type
required content
final reviewer decision
no unresolved duplicate conflict
```

Do not blindly promote old approved questions.

Existing legacy `approved` questions should first migrate to `APPROVED`,
then pass the new quality/eligibility gate before becoming `ACTIVE`.

------------------------------------------------------------------------

# 12. Reviewer Assignment

Reviewer assignment must be conflict-safe.

Hard rules:

``` text
Reviewer ≠ Question Author
Reviewer must be ACTIVE
Reviewer must have required scope
```

Optional configurable rule:

``` text
Reviewer cannot review a course they currently teach.
```

HOD can see reviewer workload and assign/reassign.

If a reviewer becomes inactive, pending reviews must be reassigned.

Reviewer edits to question metadata require:

``` text
old value
new value
reason
who
when
```

and must be audited.

------------------------------------------------------------------------

# 13. Duplicate / Similarity Detection

Support:

1.  Exact duplicate --- normalized hash.
2.  Near duplicate --- text similarity.
3.  Semantic duplicate --- existing pgvector/embedding system.

Similarity detection only **flags** questions.

It must never silently delete or reject a question.

Human reviewer decides.

------------------------------------------------------------------------

# 14. Question Versioning

Approved question edits create a new version.

Example:

``` text
Q102 v1
Q102 v2
Q102 v3
```

Keep historical versions.

One version is active for a given valid context.

A syllabus change creates a new syllabus version; old questions do not
automatically become valid for it.

------------------------------------------------------------------------

# 15. Question Security and Exposure

Do not expose the entire question bank to every teacher.

Access must follow role + scope.

Recommended question states/flags may include:

``` text
BANK_INTERNAL
EXAM_ELIGIBLE
RETIRED
```

Questions selected for an upcoming paper may optionally be temporarily
`RESERVED` to prevent conflicting concurrent paper generation.

------------------------------------------------------------------------

# 16. Question Usage

Track:

``` text
question_usage
(
  question_id,
  version_id,
  exam_id,
  paper_id,
  used_at
)
```

Also maintain:

``` text
times_used
last_used_at
```

Generator policies should support:

``` text
prefer never used
avoid last N examinations
avoid recently used
```

These are configurable soft constraints.

------------------------------------------------------------------------

# 17. Dataset Quality / Coverage

HOD and Reviewer dashboards should show:

``` text
Questions by status
Questions by CO
Questions by Bloom
Questions by difficulty
Questions by unit/topic
Questions by type
Duplicate candidates
Unused/recently used questions
```

Also provide coverage-gap views, e.g.:

``` text
Unit × Difficulty
CO × Bloom
```

This helps identify missing question-bank coverage.

------------------------------------------------------------------------

# 18. Question Retirement

Retirement requires:

``` text
retired_by
retired_at
retirement_reason
```

Possible reasons:

``` text
Syllabus changed
Incorrect
Duplicate
Outdated
Poor quality
Overused
Curriculum removed
```

Do not hard-delete academic questions.

------------------------------------------------------------------------

# 19. Examination Domain

Reuse existing examination functionality where possible.

Use/extend:

``` text
paper_blueprints
paper_generation_requests
exam_papers
paper_questions
paper_validation_log
candidate_recommendations
paper_constraint_overrides
paper_pdf
```

Add:

``` text
examinations
paper_validator_assignments
paper_validation_reviews
paper_issues
paper_revisions
```

------------------------------------------------------------------------

# 20. Examination Creation

COE creates an examination with:

``` text
Campus
College
Program
Academic Session
Semester
Course Offering
Subject
Syllabus Version
Exam Type
Maximum Marks
Duration
Pattern
```

Then creates a **paper blueprint**.

------------------------------------------------------------------------

# 21. Blueprint

Blueprint defines requirements such as:

``` text
Total marks
Question count
CO distribution
Bloom distribution
Difficulty distribution
Unit/topic coverage
Question type
Marks pattern
Internal choices
Question reuse policy
```

Blueprints must be versioned:

``` text
Blueprint v1
Blueprint v2
...
```

Never silently modify the blueprint used by a historical paper.

------------------------------------------------------------------------

# 22. Paper Generation

Flow:

``` text
COE creates Exam
 ↓
Blueprint
 ↓
Select eligible ACTIVE dataset
 ↓
Generate
 ↓
Automated validation
 ↓
Assign exactly 4 validators
 ↓
Validate
 ↓
Fix/regenerate if required
 ↓
COE final approval
 ↓
PRINT_READY
```

------------------------------------------------------------------------

# 23. Generator Rules

### Hard constraints --- never violate

``` text
ACTIVE status
Correct campus
Correct program
Correct course offering
Correct subject
Correct syllabus version
Valid marks/type requirements
```

If hard constraints cannot be satisfied:

``` text
FAIL WITH CLEAR REASON
```

Never substitute an ineligible question just to complete the paper.

### Soft constraints

Optimize:

``` text
CO distribution
Bloom distribution
Difficulty
Topic diversity
Question diversity
Usage history
Similarity
```

------------------------------------------------------------------------

# 24. Reproducible Generation

Store:

``` text
generation_seed
generator_version
blueprint_version
generated_at
```

Optionally store:

``` text
eligible_question_set_hash
```

This allows the system to explain/reproduce why a paper was generated.

For each selected question, optionally store a short selection reason
such as:

``` text
CO3 required
Apply required
Medium difficulty
Unit 3 coverage
Not used recently
```

------------------------------------------------------------------------

# 25. Automated Paper Validation

Before human validators see the paper, check:

``` text
Total marks
Question count
Numbering
Sections
Internal choices
CO distribution
Bloom distribution
Difficulty distribution
Unit coverage
Duplicates
Missing answers/options
Only ACTIVE questions
Correct campus/program/subject/syllabus
```

------------------------------------------------------------------------

# 26. Paper Status

``` text
DRAFT
 ↓
GENERATING
 ↓
GENERATED
 ↓
VALIDATION_PENDING
 ↓
CHANGES_REQUIRED ↔ REGENERATED
 ↓
VALIDATED
 ↓
COE_APPROVED
 ↓
PRINT_READY
 ↓
ARCHIVED
```

No skipping states.

------------------------------------------------------------------------

# 27. Four Validators

Exactly four **distinct active users** are assigned.

Each submits:

``` text
APPROVE
```

or

``` text
CHANGES_REQUIRED + comments
```

Checklist includes:

``` text
Question correctness
Syllabus relevance
CO
Bloom
Difficulty
Marks
Formatting
Numbering
Spelling/grammar
Instructions
Layout
```

Default rule:

``` text
All 4 must approve.
```

Keep this configurable.

### Validator conflicts

By default:

``` text
Validator ≠ COE
Validator ≠ author of any question in paper
```

Optionally also block:

``` text
Validator ≠ reviewer of a question in paper
```

if institutional policy requires stronger independence.

Validators never edit the master question.

They create `paper_issues`.

COE decides whether to replace/regenerate.

Reviewer separately fixes the source question when necessary.

------------------------------------------------------------------------

# 28. Paper Snapshot / Immutability

`paper_questions` must store:

``` text
question_id
question_version_id
question_text_snapshot
marks_snapshot
metadata_snapshot
```

Historical papers must never change when the question bank changes.

Once `PRINT_READY`:

``` text
LOCK PAPER
```

Any later change creates a new paper revision:

``` text
Paper v1
Paper v2
Paper v3
```

------------------------------------------------------------------------

# 29. COE Approval

COE owns final paper approval.

Existing TOTP step-up should apply to COE final approval.

`PRINT_READY` must require:

``` text
all required validator approvals
+
COE approval
```

This must be enforced server-side and, where practical, by database
constraints/triggers.

------------------------------------------------------------------------

# 30. Paper Issues

Validator issues should record:

``` text
paper_id
question_id
issue_type
description
reported_by
created_at
status
resolution
```

Example:

``` text
Question 17
Issue: spelling
Status: resolved
Resolution: replaced question
```

------------------------------------------------------------------------

# 31. API Boundaries

Use logical namespaces:

``` text
/api/question-bank/*
/api/reviews/*
/api/academic/*
/api/examinations/*
/api/papers/*
/api/validators/*
/api/admin/*
```

Keep existing:

``` text
/api/auth
/api/notifications
/api/attachments
/api/bulk-upload
```

as compatibility paths until frontend migration is complete.

Old routes should become thin aliases, then be removed safely.

------------------------------------------------------------------------

# 32. Bulk Question Upload

Bulk upload must follow:

``` text
Upload
 ↓
Schema validation
 ↓
Academic-context validation
 ↓
Metadata validation
 ↓
Duplicate detection
 ↓
Preview/errors
 ↓
User confirmation
 ↓
SUBMITTED
```

Never import bulk questions directly as `ACTIVE`.

Report row-level errors such as:

``` text
Row 17 → invalid CO
Row 23 → missing Bloom
Row 41 → duplicate candidate
Row 52 → topic not in syllabus
```

------------------------------------------------------------------------

# 33. Frontend

Separate navigation into:

### Question Bank

``` text
Dashboard
My Questions
Review Queue
Courses
Subjects
Syllabus
Topics
CO
Analytics
```

### Examination

``` text
Dashboard
Create Examination
Blueprint
Generate Paper
Validator Assignments
Validation Queue
Final Papers
Print Ready
```

### Admin

Technical dashboard only.

Do not rewrite working screens unnecessarily. Split large components
incrementally.

------------------------------------------------------------------------

# 34. Database Integrity

Where fields are denormalized for performance, enforce consistency.

Example:

``` text
question.campus_id
=
question.course_offering.campus_id
```

Likewise for other duplicated hierarchy fields where applicable.

Use:

``` text
foreign keys
unique constraints
check constraints
transactions
```

and database triggers where necessary.

Consider PostgreSQL Row Level Security later if useful, but backend
authorization remains mandatory.

------------------------------------------------------------------------

# 35. Audit

Audit:

``` text
create
edit
submit
assign
approve
reject
retire
restore
metadata change
paper generation
validator decision
COE approval
print-ready transition
technical override
```

Record:

``` text
who
what
when
resource
old value
new value
reason
```

------------------------------------------------------------------------

# 36. Technical Emergency Override

Admin may have a separate emergency technical override for
corrupted/blocked records.

It must require:

``` text
reason
admin identity
timestamp
audit event
```

It must not become a normal academic approval mechanism.

------------------------------------------------------------------------

# 37. Security / Pre-Flight

Before implementation:

1.  Remove request-body logging; never log passwords/OTPs.
2.  Production must fail startup if `JWT_SECRET` is missing/too short.
3.  Remove `.env` and SQLite DB files from repository; update
    `.gitignore`.
4.  Lockdown must auto-expire and ignore 404 scans/proxy-IP issues.
5.  New migrations start at `023`; never rename/renumber existing
    migrations.

------------------------------------------------------------------------

# 38. Migration Safety

Rules:

``` text
Never drop existing production data.
Never rename/renumber existing migrations.
Use additive migrations.
Backfill safely.
Keep compatibility during frontend migration.
```

Legacy question status migration:

``` text
pending / ai_cleared / flagged
→ SUBMITTED / UNDER_REVIEW

needs_teacher_fix
→ CHANGES_REQUESTED

approved
→ APPROVED

rejected
→ REJECTED

is_draft
→ DRAFT
```

Then run the new quality gate to determine which questions can become
`ACTIVE`.

Legacy papers that were previously approved must be revalidated under
the new paper workflow where required.

------------------------------------------------------------------------

# 39. Key Invariants

These must be enforced:

1.  Question belongs to exactly one valid academic context.
2.  Campus/academic scope cannot be crossed.
3.  Reviewer ≠ author.
4.  Only `ACTIVE` questions can enter paper generation.
5.  Question must match the paper's syllabus version.
6.  Paper cannot become `PRINT_READY` without required validator
    approvals and COE approval.
7.  Historical papers never change.
8.  Admin is never required for normal academic actions.
9.  Validators cannot edit master questions.
10. AI never silently approves, merges, deletes, or changes academic
    status.
11. Names are never used as identity.
12. Hard generation constraints cannot be bypassed.

------------------------------------------------------------------------

# 40. Smoke Tests

Extend `smoketest.mjs` to verify:

``` text
Cross-campus access → DENIED
Teacher reviewing own question → DENIED
Inactive reviewer assignment → DENIED
Invalid metadata → ACTIVE transition denied
Non-ACTIVE question → generator rejects
Wrong syllabus question → generator rejects
Wrong campus question → generator rejects
Duplicate validator → assignment denied
Validator = COE → assignment denied
Paper without 4 approvals → PRINT_READY denied
Paper without COE approval → PRINT_READY denied
Editing source question → historical paper unchanged
Syllabus change → old question not automatically eligible
Bulk upload invalid row → row-level error
```

------------------------------------------------------------------------

# 41. Implementation Order

### Phase 1 --- Foundation

-   Pre-flight security fixes
-   Academic hierarchy
-   Academic sessions
-   Multi-campus scope
-   New roles
-   Central authorization

### Phase 2 --- Question Bank

-   Question status machine
-   Metadata
-   CO/Bloom/difficulty
-   Reviewer assignment/conflicts
-   Versioning
-   Quality gates

### Phase 3 --- Quality

-   Duplicate/similarity
-   Usage tracking
-   Coverage dashboard
-   Bulk upload validation

### Phase 4 --- Examination

-   COE
-   Examination
-   Blueprint
-   ACTIVE-only generator
-   Automated validation
-   Reproducible generation
-   Snapshots

### Phase 5 --- Validators

-   Four-validator workflow
-   Issues
-   Revisions
-   COE approval
-   Print-ready lock

### Phase 6 --- Optional Intelligence

-   AI metadata suggestions
-   Advanced semantic similarity
-   Generation optimization
-   Dataset readiness analytics

Each phase must end with:

``` text
Migration ✓
Backend tests ✓
Smoke test ✓
Frontend build ✓
Lint ✓
```

------------------------------------------------------------------------

# 42. Final Product Definition

> **A multi-campus academic question-bank and examination-management
> platform that builds a trusted, structured and versioned question
> dataset through Teacher--HOD--Reviewer governance, then independently
> generates and validates examination papers through the COE and four
> paper validators.**

The two responsibilities must remain separate:

``` text
QUESTION BANK
Teacher → HOD → Reviewer
        ↓
Trusted ACTIVE Dataset
        ↓ READ ONLY
EXAMINATION
        ↓
COE → Generate → 4 Validators → COE Approval
        ↓
PRINT READY
```

This is the core architecture and should guide the database, backend,
frontend, authorization, migrations and testing.
