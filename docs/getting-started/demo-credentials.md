# Demo accounts and sign-in

> **For development and demonstrations only.** These passwords are published in this repository. Never use them, or
> the demo data, on a production system.

## Accounts

Created by `npm run seed`:

| Role | Email | Password | What this account is set up to do |
|---|---|---|---|
| Technical administrator | `admin@portal.edu` | `Admin@12345` | Accounts, access scopes, validation policy, platform health. No academic actions. |
| Head of Department (CSE) | `hod@portal.edu` | `Hod@12345` | Publishes syllabi, assigns teachers and reviewers, runs review batches for the whole CSE department. |
| Reviewer | `reviewer@portal.edu` | `Review@123` | Reviews questions of the offerings it is assigned to (see the table below). |
| Teacher | `teacher1@portal.edu` | `Teach@123` | Writes questions for its assigned subjects. |
| Teacher | `teacher2@portal.edu` | `Teach@123` | As above. |
| Teacher | `teacher3@portal.edu` | `Teach@123` | As above. |
| Teacher | `teacher4@portal.edu` | `Teach@123` | As above. |
| Controller of Examinations | `coe@portal.edu` | `Coe@123456` | Examinations, blueprints, paper generation, validators, final approval and printing. Needs an authenticator app for final approval (see below). |
| Paper validator | `validator1@portal.edu` … `validator5@portal.edu` | `Valid@12345` | Reviews papers the COE assigns (four per paper; the fifth lets you try replacing a validator). |

Added by `npm run seed:demo`:

| Role | Email | Password | Purpose |
|---|---|---|---|
| Reviewer | `reviewer2@portal.edu` | `Review@123` | Second CSE reviewer for the demo subjects |
| Reviewer | `reviewer3@portal.edu` | `Review@123` | Third CSE reviewer for the demo subjects |
| Reviewer (ECE department) | `reviewer.ece@portal.edu` | `Review@123` | Belongs to a different department: shows that the portal refuses out-of-scope access |

Accounts for real users are never created this way: the administrator (any role) or the HOD (teachers and reviewers of
the department) creates them under **Accounts**, and the person sets their own password from an emailed setup code.

## Signing in

Every sign-in has two steps: the password, then a one-time code.

1. Open the portal (normally http://localhost:5173) and enter the **email** and **password**. Select **Continue**.
2. A 6-digit code is sent. In development it is printed in the **backend terminal** on a line like
   `[otp-delivery:console] ... code=482913`. In production it is emailed.
3. Enter the code and select **Verify & Sign in**.

Rules you will meet:

- A code is valid for **5 minutes** and allows **3 attempts**. If it expires, go back and sign in again for a new one.
- After **5 wrong passwords** sign-in to that account is paused for **15 minutes**.
- If a code never appears, see [Troubleshooting](../troubleshooting.md#we-could-not-send-your-sign-in-code).

## The COE's authenticator (required before final approval)

Final approval of a paper is confirmed with a code from an authenticator app (Google Authenticator, Microsoft
Authenticator, Authy or similar). Set it up once:

1. Sign in as `coe@portal.edu`. Open **Authenticator** in the sidebar (shown as *Authenticator (required)* until it is set up).
2. Enter the current password and select **Set up authenticator**.
3. Scan the QR code with the app (or type the key shown), then enter the 6-digit code from the app to confirm.

Each authenticator code works once. Five wrong codes lock approval for 15 minutes.

## Who is assigned to what (after `npm run seed:demo`)

Each demo subject has two teachers (who share the 20 questions) and one reviewer:

| Subject | Title | Teachers | Reviewer |
|---|---|---|---|
| TCS 101 | Fundamental of computer and Introduction to Programming | teacher1, teacher2 | reviewer |
| TCS 201 | Programming for Problem Solving | teacher2, teacher3 | reviewer2 |
| TCS 302 | Data structures with C | teacher3, teacher4 | reviewer3 |
| TCS 308 | Logic Design & Computer Organization | teacher4, teacher1 | reviewer |
| TMA 316 | Discrete Structures and Combinatorics | teacher1, teacher2 | reviewer2 |
| TCS 402 | Finite Automata and Formal Languages | teacher2, teacher3 | reviewer3 |
| TCS 408 | Programming in Java | teacher3, teacher4 | reviewer |
| TCS 409 | Design and Analysis of Algorithms | teacher4, teacher1 | reviewer2 |
| TCS 503 | Database Management System | teacher1, teacher2 | reviewer3 |
| TCS 571 | Big Data Visualization | teacher2, teacher3 | reviewer |
| TCS 601 | Compiler Design | teacher3, teacher4 | reviewer2 |
| TCS 611 | Software Engineering | teacher4, teacher1 | reviewer3 |
| TCS 703 | Computer Networks II | teacher1, teacher2 | reviewer |
| TCS 704 | Advanced Computer Architecture | teacher2, teacher3 | reviewer2 |

The base seed also creates two small subjects, **DSA101** and **OS201**: `teacher1` teaches both (so it has a course
picker), the other teachers teach DSA101, and `reviewer@portal.edu` reviews DSA101.

## Which account to use for what

| To try… | Sign in as |
|---|---|
| Uploading and approving the official syllabus, review batches, assignments, coverage | `hod@portal.edu` |
| Writing, submitting and revising questions | `teacher2@portal.edu` (teaches TCS 571, the showcase subject) |
| Reviewing questions | `reviewer@portal.edu` (reviews TCS 571) |
| Creating an examination and generating a paper | `coe@portal.edu` |
| Validating a paper | `validator1@portal.edu` to `validator4@portal.edu` |
| Accounts, policies, system health | `admin@portal.edu` |
| Seeing access refused outside a department | `reviewer.ece@portal.edu` |

For a scripted tour through all of these, follow the [guided demo](demo-walkthrough.md).
