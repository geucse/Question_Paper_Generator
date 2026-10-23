# User guide: basics for every user

This page covers what is the same for everyone. Then read the guide for your role:
[Teacher](teacher.md) · [Head of Department](hod.md) · [Reviewer](reviewer.md) ·
[Controller of Examinations](coe.md) · [Paper validator](validator.md) · [Administrator](admin.md).

## Who does what

| | Teacher | HOD | Reviewer | COE | Validator | Admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Publish the official syllabus (upload, verify, approve) | | ✓ | | | | |
| Read the syllabus of assigned subjects | ✓ | ✓ | ✓ | | | |
| Write and submit questions | ✓ | | | | | |
| Assign teachers and reviewers, run review batches | | ✓ | | | | |
| Review questions (verdicts, decisions, activation) | | ✓ (resolves disagreements) | ✓ | | | |
| Create examinations and blueprints, generate papers | | | | ✓ | | |
| Validate an assigned paper | | | | | ✓ | |
| Final approval and printing | | | | ✓ | | |
| Accounts, access scopes, policies, platform health | | teachers and reviewers of the department | | | | ✓ |

Every permission is checked by the server on each request, within the person's **scope** (their campus, department,
program or course offering). Hiding a button is only a convenience; the server refuses anything outside the role and
scope, and records the refusal.

## Signing in

1. Enter your email and password and select **Continue**.
2. Enter the 6-digit code sent to your email (in a development setup it appears in the backend terminal) and select
   **Verify & Sign in**.

- Codes last **5 minutes** and allow **3 attempts**; sign in again for a new one.
- After **5 wrong passwords** sign-in to the account is paused for **15 minutes**.
- **Forgot password?** sends a reset code to your registered email.
- **Set up a new account** is for people who received an invitation: enter the setup code from the email and choose a
  password. Passwords are never sent or shown to anyone.

If the portal shows **You must set a new password**, enter the current password and choose a new one; the rest of the
portal stays locked until you do.

## The screen

- **Header (top):** the institution name (or its official logo), the **notifications** bell with the number of unread
  messages, and your name and role.
- **Sidebar (left):** the sections of your workspace, then **Change password** and **Sign out** at the bottom. On a phone
  or narrow window the sidebar opens with the menu button in the header and closes with *Escape*.
- **Workspace heading and overview:** the title of your workspace and a row of figures that matter for your role (for
  example *Needs revision* for a teacher, *Ready for your approval* for the COE), with a status bar underneath. All
  figures come from live data; **Refresh figures** reloads them.

## Notifications

The bell lists messages such as *a question needs revision*, *you were assigned a course* or *a paper is ready for your
approval*. Select a message to mark it read, or **Mark all read**.

## Changing your password

Select **Change password** in the sidebar, enter the current password and the new one twice. Changing it ends your
other sessions.

## Status names you will see

| Questions | Syllabus versions | Papers |
|---|---|---|
| Draft → Submitted → Under review → Approved → Active | Draft → Content verified → In HOD review → Active | Generated → Validation pending → Validated → COE approved → Print-ready |
| Changes requested ↔ Resubmitted (a revision loop) | Superseded (replaced by a newer active version) | Changes required (sent back), Regenerated (replaced by a new revision) |
| Rejected (final), Retired (removed from use; can be restored) | Rejected (with a reason) | Archived |

Full diagrams: [Workflows](../reference/workflows.md).

## Accessibility

The portal works with the keyboard alone (visible focus outline; *Tab* to move, *Enter* or *Space* to act), labels every
form field for screen readers, and respects the system's reduced-motion setting.
