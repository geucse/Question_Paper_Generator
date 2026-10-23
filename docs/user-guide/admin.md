# Technical administrator guide

The administrator runs the platform: accounts, access scopes, the validation policy, health and security. The
administrator has **no academic powers**: no syllabus, question, review, examination or paper decisions. The portal
refuses such actions for this role and records the attempt.

Demo account: `admin@portal.edu` / `Admin@12345`.

## Your workspace

| Sidebar section | Contents |
|---|---|
| **System** | Readiness of the platform, active protections, accounts, questions and papers by status, recent access denials and overrides; **Rescan unscanned uploads** |
| **Accounts** | Create accounts for any role; resend invitations; deactivate, reactivate; reset an authenticator; change a role |
| **Access scopes** | What each account may act on (campus, department, program or course offering) |
| **Validation policy** | How many validator approvals a paper needs |
| **Emergency override** | Reset a technically stuck paper (audited) |
| **Structure & security** | The academic hierarchy (*Manage academics*), **Security & audit** and **Threat monitor** |

The overview shows **Platform readiness** (with any failing checks), **Active accounts**, **Papers on record** and
**Questions on record**.

## Accounts

**Accounts → Create a new account**: email, role and the scope the role needs (for example a teacher's department, a
reviewer's department, a validator's campus). The person receives a **setup code by email** and chooses their own
password under *Set up a new account* on the sign-in page. No password is ever shown to anyone.

Other account actions:

| Action | Effect |
|---|---|
| Resend invitation | A new setup code for someone who has not set their password yet |
| Deactivate | The account is signed out everywhere at once and can no longer act (a deactivated validator can no longer decide) |
| Reactivate | Restores the account and its scopes |
| Reset authenticator | For a COE who lost their authenticator: they must link a new one before approving again |
| Change role | Moves the account to another role; its sessions end |

You cannot deactivate your own account. HODs can also create teacher and reviewer accounts for their own department.

## Access scopes

Every action is checked against the account's scope. A reviewer of the CSE department cannot see ECE batches; a teacher
can write only for offerings they are assigned to. Use **Access scopes** to review and adjust what an account covers.
The demo account `reviewer.ece@portal.edu` (ECE department) shows a refused out-of-scope access.

## Validation policy

Sets the **required approvals**: **3 or 4** of the four validators per paper. The change takes a reason (at least 10
characters) and is audited. A paper keeps the threshold it had when its validators were assigned, and the database
refuses final approval with fewer approvals, with fewer than exactly four active validators, with open validator
issues, or without the COE's authenticator confirmation.

## Emergency override: reset a stuck paper

For a paper stuck between generation and print-ready (for example validators who can no longer act), enter its **Paper
ID** and a reason, and select **Apply override**. The current validation round is ended and kept as history, so
validators can be assigned again.

It is deliberately limited: it **cannot** overturn a validator's *changes required* decision (the COE regenerates or
archives such a paper), it cannot touch print-ready papers, and open issues remain for the COE. The **Override
history** lists every use.

## Security and monitoring

- **Security & audit**: the audit log of significant actions and **Verify chain integrity**, which checks that the log
  has not been altered.
- **Threat monitor**: blocked addresses (**Unblock**) and the lockdown state (**Clear lockdown**) set by the automatic
  protections against repeated failed sign-ins and abuse.
- **System → Rescan unscanned uploads** sends uploaded files that were never virus-scanned (for example while ClamAV was
  down) for scanning; unscanned files are quarantined until then.

## Configuration

Platform settings (email delivery, institution name and logo, CORS, rate limits, virus scanning) are environment
variables set by whoever deploys the portal; see [Configuration](../reference/configuration.md).
