# Graphic Era Examination Portal — Documentation

The Examination Portal manages the full life of an examination paper at Graphic Era: the **official syllabus**
(uploaded and published by the Head of Department), a **reviewed question bank** mapped to each subject's course
outcomes (COs) and Bloom's taxonomy levels, **paper generation** that meets CO and Bloom targets exactly, **independent
validation** by four validators, **final approval** by the Controller of Examinations (COE) with two-factor
confirmation, and **printing** in the institution's formal paper format.

> **New here?** Install the portal ([Installation](getting-started/installation.md)), load the demo data, sign in with a
> [demo account](getting-started/demo-credentials.md), and follow the [guided demo](getting-started/demo-walkthrough.md).

## Start here

| I want to… | Read |
|---|---|
| Install and run the portal on my computer | [Installation and setup](getting-started/installation.md) |
| Know which accounts and passwords to use | [Demo accounts and sign-in](getting-started/demo-credentials.md) |
| Try every feature in a 45-minute guided tour | [Guided demo walkthrough](getting-started/demo-walkthrough.md) |
| See the sample syllabus and the 280 sample questions | [Demo data](demo-data/README.md) |
| Fix a problem | [Troubleshooting and FAQ](troubleshooting.md) |

## User guides (by role)

| Role | What they do | Guide |
|---|---|---|
| Everyone | Sign-in, screen layout, notifications, passwords | [Basics for every user](user-guide/README.md) |
| **Teacher** | Writes questions for assigned subjects, maps them to topics and COs, submits and revises them | [Teacher guide](user-guide/teacher.md) |
| **Head of Department (HOD)** | Publishes the official syllabus, assigns teachers and reviewers, runs review batches, watches coverage | [HOD guide](user-guide/hod.md) |
| **Reviewer** | Checks questions against the syllabus, COs, Bloom level, difficulty and answer key; approves or returns them | [Reviewer guide](user-guide/reviewer.md) |
| **Controller of Examinations (COE)** | Creates examinations and blueprints, generates papers, assigns validators, gives final approval, prints | [COE guide](user-guide/coe.md) |
| **Paper validator** | Reviews an assigned paper against an 11-point checklist, reports issues, records a decision | [Validator guide](user-guide/validator.md) |
| **Technical administrator** | Accounts, access scopes, policies, platform health; no academic actions | [Administrator guide](user-guide/admin.md) |

## Reference

| Topic | Document |
|---|---|
| Workflows and state machines (syllabus, question, paper) | [Workflows](reference/workflows.md) |
| The 13 question types and what each needs | [Question types](reference/question-types.md) |
| Bloom's taxonomy, course outcomes and difficulty | [Taxonomy and outcomes](reference/taxonomy.md) |
| System architecture, data model and security design | [Architecture and security](reference/architecture.md) |
| Environment variables and deployment settings | [Configuration](reference/configuration.md) |
| Main API endpoints | [API reference](reference/api.md) |
| Automated tests and how to run them | [Testing](reference/testing.md) |
| Terms used in this documentation | [Glossary](reference/glossary.md) |

## Project files

| Document | Contents |
|---|---|
| [`README.md`](../README.md) | Project overview and quick start |
| [`CHANGELOG.md`](../CHANGELOG.md) | What changed in each release |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | How to set up, test and contribute |
| [`SECURITY.md`](../SECURITY.md) | Reporting vulnerabilities; security notes |
| [Demo data catalog](demo-data/CATALOG.md) | How the demo data was built and verified, recorded HOD decisions, scenarios |

## Development history

Background documents kept for maintainers in [`docs/development/`](development/):

| Document | Contents |
|---|---|
| [PIVOT_SPEC_V2.md](development/PIVOT_SPEC_V2.md) | The examination-domain specification the system implements (code comments cite its sections) |
| [PIVOT_STATUS.md](development/PIVOT_STATUS.md) | Detailed implementation log of that specification |
| [DEVELOPMENT_HISTORY.md](development/DEVELOPMENT_HISTORY.md) | The earlier developer README: phase-by-phase history and detailed security notes |
| [GRAPHIC_ERA_REDESIGN_NOTES.md](development/GRAPHIC_ERA_REDESIGN_NOTES.md) | Interface redesign and the formal paper template |
| [GETTING_STARTED.md](development/GETTING_STARTED.md) | The original setup guide (superseded by [Installation](getting-started/installation.md)) |
| [INTEGRATION_PLAN.md](development/INTEGRATION_PLAN.md) | The first pivot's working checklist (superseded) |

## Important notices

- **Demo content.** The 280 questions loaded by `npm run seed:demo` are **sample questions written for testing**. The
  syllabus data they use (subjects, course outcomes, units, contact hours) is the department's official 2023 syllabus.
- **Demo passwords are public.** The demo accounts' passwords are published in this repository. Never load demo data into
  a production database; the seed scripts refuse to run when `NODE_ENV=production`.
- **Official logo.** The portal shows the institution name as text until an approved logo file is configured (see
  [Configuration](reference/configuration.md#branding)).
