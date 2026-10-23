# Controller of Examinations (COE) guide

As COE you create examinations, define their **blueprints**, generate papers from the reviewed question bank, send each
paper to **four independent validators**, give the **final approval** with your authenticator, and lock the paper for
printing. The portal enforces your CO and Bloom targets exactly: it never relaxes them silently.

Demo account: `coe@portal.edu` / `Coe@123456`. Set up the authenticator first (below).

## Your workspace

| Sidebar section | Contents |
|---|---|
| **Examinations & Blueprints** | Create examinations; define and version their blueprints; check feasibility; generate papers |
| **Papers** | Every paper with its status; open one to validate, assign validators, approve, print or archive |
| **Authenticator** | Link your authenticator app (shown as *Authenticator (required)* until done) |

The overview shows **Ready for your approval**, **Under validation**, **Awaiting validators** and **Open validator
issues**, with a status bar of all papers.

## Before your first approval: the authenticator

Final approval is confirmed with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…).

1. Open **Authenticator**, enter your current password and select **Set up authenticator**.
2. Scan the QR code with the app and confirm with the 6-digit code it shows.

Each code works once; five wrong codes lock approval for 15 minutes. Until this is done, the approval panel asks you to
set it up instead of showing a code box.

## 1. Create an examination

**Examinations & Blueprints → Create examination**:

| Field | Notes |
|---|---|
| Course offering | The subject, program, session and semester; the examination uses that offering's **active syllabus** |
| Exam type | Mid-term, End-term, Quiz, Supplementary or Make-up (printed as e.g. "MID SEMESTER EXAMINATION") |
| Maximum marks | The marks a candidate can score |
| Duration (minutes) | Printed as "Time" |
| Exam date | Printed with the month and year in the heading, and as the date |

## 2. Define the blueprint

A blueprint states what the paper must contain. Every change is saved as a **new blueprint version**, so earlier papers
keep the rules they were generated under.

| Setting | Meaning |
|---|---|
| Easy / medium / hard counts | How many questions of each difficulty |
| Total marks | Must add up exactly (normally the examination's maximum marks) |
| Reuse look-back | Avoid questions used in the last N examinations of the offering |
| **Sections** (optional) | Name, number of questions, **marks each** or section total, **allowed question types**, **attempt any** (internal choice) and instructions printed under the heading |
| **CO targets** | Number of questions per CO, written like `CO1:2, CO2:3`; the codes must exist in the syllabus version |
| **Bloom targets** | Percentage of questions per Bloom level. At 100% the distribution is exact; below 100% the listed levels get that share and the rest is free |

**Internal choice ("attempt any 1 of 2").** A section with *attempt any 1* prints as one question with alternatives
**(a) OR (b)**, as in the institution's paper format. To build a paper like the standard mid-semester format (five
questions of 10 marks, each with an OR choice), create five sections of 2 questions × 10 marks with *attempt any 1*.

## 3. Check feasibility, then generate

**Check feasibility** tells you before generating whether the active bank can meet every constraint together, and if
not, exactly why, for example:

- *"CO target CO3=2 but only 0 eligible question(s) map to CO3"*
- *"Bloom target evaluate=3 but only 1 eligible question(s) are evaluate"*
- *"No combination of eligible ACTIVE questions satisfies all hard constraints together (difficulty counts, exactly 20
  marks, the CO targets)"*

Then **Generate paper** (choose the blueprint version; the **seed** is optional and makes the selection reproducible).
Only **Active** questions of this offering's syllabus version are eligible; questions used recently are avoided.

If a target cannot be met, your choices are: revise the blueprint, ask the HOD for questions in the gap, or record an
**Override** of the CO/Bloom targets **with a reason**. An override is shown to every validator and recorded in the
audit log; it never happens automatically.

## 4. Inspect the paper

Open it from **Papers**. The detail page shows:

- **Printed paper**: **Download / Preview / Print paper** (the candidate copy) and the same **with answer key** (the
  internal copy). The preview is the same PDF that downloads and prints. Until the paper is print-ready every page
  carries a *DRAFT — NOT FOR DISTRIBUTION* watermark.
- **Automated validation**: each CO and Bloom target with the achieved value (*Met* or *Missed (n short)*), section
  checks and warnings; if it failed, how to resolve it.
- **Questions**: each with its slot, how it is numbered on paper (e.g. *printed as Q2(a)*), its CO codes and why it
  was selected.

### The printed format

The candidate copy follows the institution's formal paper: Roll No. line, institution and campus, examination heading,
programme / course / semester / course code / time / maximum marks, numbered instructions ("Note"), and a bordered
question table with **Q. No. | Question | Marks | CO**, OR alternatives, and *Page X of Y* on every page. The internal
copy adds a **Paper Analysis** page (distribution by CO, Bloom level, syllabus unit and difficulty; a question mapped to
several COs counts under each) and the **answer key**.

## 5. Validation

Under **Validators** assign **exactly four** validators and select **Assign & send for validation**. Each validator
reviews independently and records a final decision (see the [Validator guide](validator.md)).

- **Issues reported by validators** appear on the paper. Resolve each with an explanation (at least 10 characters) or
  refer it; open issues block approval.
- If a validator cannot continue, **replace** them (the replacement and the reason are recorded).
- The number of approvals needed is the institution's **validation policy**: 3 or 4 of the 4 validators (set by the
  administrator). It is fixed for a paper once its validators are assigned.

If a validator requires changes, use **Send back for changes** or **Regenerate as new revision** (with a reason); the
previous revision stays in the history.

## 6. Final approval and printing

When the paper shows the required approvals and no open issues:

1. In **Final COE approval** enter the 6-digit **Authenticator code** and select **Approve**.
2. **Lock for printing**: the paper becomes **PRINT_READY**; the watermark disappears and the paper can no longer change.
3. Download or print the candidate copy.

To change a printed paper later, use **Revise printed paper (new revision)**; the printed one stays on record. At the end
of the examination cycle **Archive** it (with a reason).

## Paper statuses

Generated → Validation pending → Validated → COE approved → **Print-ready** → Archived. Side paths: *Changes required*
(a validator asked for changes) and *Regenerated* (replaced by a new revision). See [Workflows](../reference/workflows.md).

## Practise with the demo data

The [guided demo](../getting-started/demo-walkthrough.md) generates a 20-mark paper for **TCS 571** and shows refusals for
**TCS 409** (no question can cover CO3) and **TCS 101** (too few Evaluate questions).
