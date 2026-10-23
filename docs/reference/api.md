# API reference (main endpoints)

All endpoints are under `/api` and, except sign-in and health, need `Authorization: Bearer <token>`. Every endpoint
checks the caller's **role** and **scope**; refusals return 403 (or 404 for objects outside the scope). Errors are JSON:
`{ "error": "...", "request_id": "..." }`. Several routers are also reachable under compatibility paths
(`/api/question-bank`, `/api/reviews`, `/api/validators`).

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/health/live`, `/health/ready` | Liveness and readiness (database, Redis, protections) |

## Authentication (`/auth`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/login/password` | Step 1: email and password; sends a one-time code |
| POST | `/login/otp` | Step 2: the code; returns the session token |
| GET | `/me` | The signed-in user |
| POST | `/logout`, `/change-password` | Sign out; change password |
| POST | `/password-reset/request`, `/password-reset/confirm` | Reset by emailed code |
| POST | `/totp/setup`, `/totp/confirm` | Link an authenticator (COE) |

## Academic structure and syllabus (`/academic`)

| Method | Path | Role |
|---|---|---|
| GET | `/course-offerings`, `/subjects`, `/programs`, `/sessions`, `/departments`, `/sections` | in scope |
| POST | `/subjects`, `/course-offerings`, `/programs`, `/sessions`, `/sections`, `/departments` | HOD, admin |
| GET / POST | `/assignments/teacher`, `/assignments/reviewer` (+ `/:id/deactivate`) | HOD |
| GET | `/my-assignments`, `/my-reviewer-assignments` | teacher, reviewer |
| GET | `/syllabus-versions?course_offering_id=` | HOD, assigned teacher/reviewer |
| POST | `/course-offerings/:id/syllabus-upload` (multipart `file`, PDF ≤ 25 MB) | **HOD** |
| POST | `/syllabus-versions` | **HOD** |
| POST | `/syllabus-versions/:id/verify`, `/submit-review`, `/approve`, `/return`, `/reject` | **HOD** |
| GET | `/syllabus-versions/:id/extraction`, `/syllabus-versions/:id/source` | HOD, assigned teacher/reviewer |
| GET / POST | `/syllabus-versions/:id/course-outcomes`, `/syllabus-versions/:id/units`, `/units/:id/topics` | read: in scope; write: HOD, draft only |
| GET | `/course-offerings/:id/syllabus-tree` | in scope |
| POST | `/course-offerings/:id/syllabus-versions/from-current` | HOD |
| GET / POST | `/users` (+ `/:id/resend-invite`, `/deactivate`, `/reactivate`, `/reset-authenticator`, `/role`) | admin; HOD for its teachers and reviewers |

## Questions (`/questions`)

| Method | Path | Role |
|---|---|---|
| POST | `/draft` | teacher (create or update a draft) |
| GET | `/:id/preview` | author and reviewers |
| POST | `/:id/duplicate-decision` | teacher |
| POST | `/:id/submit` | teacher (`primary_course_outcome_id`, `secondary_course_outcome_ids`) |
| GET | `/mine`, `/:id/canonical`, `/lifecycle`, `/:id/lifecycle` | in scope |
| POST | `/:id/transition` (`target_status`, `reason`) | reviewer/HOD per transition (approve, return, activate, retire, restore) |
| GET | `/question-bank/analytics`, `/question-bank/export` | HOD, reviewer |
| GET | `/bulk-upload/template` | teacher (the .xlsx template) |
| POST | `/bulk-upload` (xlsx) then `/bulk-upload/:batchId/confirm` | teacher: validate and preview, then submit the valid rows |

## Review batches (`/review`)

| Method | Path | Role |
|---|---|---|
| POST / GET | `/batches` | HOD creates; HOD and reviewers list |
| POST | `/batches/:id/assign`, `/reassign` | HOD |
| POST | `/batches/:id/questions/:questionId/verdict` | assigned reviewer |
| POST | `/batches/:id/complete` | assigned reviewer |
| GET | `/batches/:id/disagreements` | HOD |
| POST | `/questions/:questionId/resolve` | HOD |
| POST | `/batches/:id/close` | HOD |

## Examinations and papers (`/examinations`)

| Method | Path | Role |
|---|---|---|
| POST / GET | `/` (examinations), `/blueprints` | COE |
| POST | `/:examId/feasibility`, `/:examId/generate` | COE |
| GET | `/papers`, `/papers/:paperId` | COE; assigned validators |
| GET | `/papers/:paperId/pdf` (`?include_answers=1`, `?inline=1`) | COE; assigned validators (answers) |
| POST | `/papers/:paperId/validators`, `/validators/:n/replace` | COE |
| POST | `/papers/:paperId/regenerate`, `/papers/:paperId/revise` | COE |
| GET | `/my-validations` | validator |
| POST | `/papers/:paperId/validate`, `/papers/:paperId/issues` | assigned validator |
| POST | `/issues/:issueId/resolve`, `/issues/:issueId/refer` | COE |

## COE approval (`/coe`)

| Method | Path | Notes |
|---|---|---|
| GET | `/papers/:paperId/coe-status` | Approvals, blockers |
| POST | `/papers/:paperId/coe-approve` | Needs the authenticator code |
| POST | `/papers/:paperId/send-back`, `/print-ready`, `/archive` | With reasons where required |

## Administration (`/admin`)

| Method | Path |
|---|---|
| GET | `/system`, `/hierarchy`, `/scopes`, `/overrides` |
| POST / DELETE | `/scopes`, `/scopes/:id` |
| GET / PUT | `/settings/validation-policy`, `/settings/validator-independence` |
| POST | `/overrides/reset-paper`, `/attachments/rescan` |

## Notifications (`/notifications`)

List, unread count, mark one or all read.
