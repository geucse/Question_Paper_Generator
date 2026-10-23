// Paper workflow policy (PIVOT_SPEC_V2 sections 26, 27, 28, 30).
// Pure functions only — no database access — so they can be unit-tested offline.
// The same transition table is enforced in the database by the newest migration that defines
// enforce_paper_lifecycle (039; first added in 036), and the issue windows by 039's
// enforce_paper_issue_rules. Keep them in sync: test-paper-policy.mjs parses the SQL and fails if
// they drift apart.

export const PAPER_STATUSES = [
  'DRAFT', 'GENERATING', 'GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED',
  'REGENERATED', 'VALIDATED', 'COE_APPROVED', 'PRINT_READY', 'ARCHIVED',
];

// Normal workflow transitions. "No skipping states" (spec §26).
// REGENERATED marks a revision that was superseded by a newer one created by
// /regenerate; it is history, never edited, and can only be archived.
export const PAPER_TRANSITIONS = {
  DRAFT: ['GENERATING'],
  GENERATING: ['GENERATED', 'DRAFT'],
  GENERATED: ['VALIDATION_PENDING', 'REGENERATED', 'ARCHIVED'],
  VALIDATION_PENDING: ['VALIDATED', 'CHANGES_REQUIRED'],
  CHANGES_REQUIRED: ['REGENERATED', 'ARCHIVED'],
  REGENERATED: ['ARCHIVED'],
  // COE send-back (spec §27 "COE decides whether to replace/regenerate"); the DB requires a
  // paper_send_backs row written in the same transaction.
  VALIDATED: ['COE_APPROVED', 'CHANGES_REQUIRED'],
  COE_APPROVED: ['PRINT_READY'],
  PRINT_READY: ['ARCHIVED'],
  ARCHIVED: [],
};

// The admin emergency reset (spec §36) may return a stuck, not-yet-locked
// paper to GENERATED. Only allowed when the database session carries the
// override flag set by routes/admin.js inside the same transaction.
// Never from CHANGES_REQUIRED: that is the validators' (or the COE's) verdict, not a stuck state (its exits are
// regenerate and archive), and resetting it would let the rejected content be re-validated unchanged, i.e. the
// technical override would become an academic re-approval path (§36). For the same reason the reset refuses a
// VALIDATION_PENDING paper whose round already holds a CHANGES_REQUIRED decision (routes/admin.js and the 039
// guard_validator_assignment trigger).
export const OVERRIDE_RESET_FROM = ['VALIDATION_PENDING', 'VALIDATED', 'COE_APPROVED'];

// Statuses a paper may be created in.
export const INSERTABLE_STATUSES = ['DRAFT', 'GENERATING'];

// A paper of an examination that is in progress (generated, not yet printed). An examination has at most one
// (migration 039, check_one_live_paper_per_examination); a new candidate is a regeneration of it, never a
// second paper. A printed (PRINT_READY) paper is counted separately: at most one per examination.
export const LIVE_PAPER_STATUSES = ['GENERATING', 'GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED', 'COE_APPROVED'];
// Statuses /regenerate starts from: exactly those whose transitions include REGENERATED (test-paper-policy.mjs).
export const REGENERATABLE_STATUSES = ['GENERATED', 'CHANGES_REQUIRED'];
// Spec §28: once PRINT_READY the paper is locked; "any later change creates a new paper revision". /revise
// generates that revision with the printed paper as its parent. The printed paper stays PRINT_READY (it is
// what was printed) until the revision itself is marked PRINT_READY; that same transaction archives it, so an
// examination never has two printed papers (migration 039 checks this at COMMIT).
export const REVISABLE_STATUSES = ['PRINT_READY'];

// Papers whose question list may still be written.
export const QUESTIONS_WRITABLE_IN = ['DRAFT', 'GENERATING'];

export function canTransitionPaper(from, to, { override = false } = {}) {
  if (from === to) return !['PRINT_READY', 'ARCHIVED'].includes(from);
  if ((PAPER_TRANSITIONS[from] || []).includes(to)) return true;
  return override && to === 'GENERATED' && OVERRIDE_RESET_FROM.includes(from);
}

// Spec §27: exactly four validators; by default all four must approve.
// The threshold is configurable but never below 3, so a paper can't pass with
// half of its independent reviewers objecting.
export const VALIDATOR_COUNT = 4;
export const MIN_REQUIRED_APPROVALS = 3;
export const DEFAULT_REQUIRED_APPROVALS = 4;

export function normalizeRequiredApprovals(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_REQUIRED_APPROVALS || n > VALIDATOR_COUNT) return DEFAULT_REQUIRED_APPROVALS;
  return n;
}

// decisions: array of 'APPROVE' | 'CHANGES_REQUIRED' | null, one per active assignment.
// Returns the outcome once every validator has decided; until then the paper stays VALIDATION_PENDING.
export function validationOutcome(decisions, requiredApprovals = DEFAULT_REQUIRED_APPROVALS) {
  const required = normalizeRequiredApprovals(requiredApprovals);
  const approvals = decisions.filter((d) => d === 'APPROVE').length;
  const allDecided = decisions.length === VALIDATOR_COUNT && decisions.every(Boolean);
  if (!allDecided) return { allDecided: false, allApproved: false, approvals, required, nextStatus: null };
  const passed = approvals >= required;
  return {
    allDecided: true,
    allApproved: approvals === VALIDATOR_COUNT,
    approvals,
    required,
    nextStatus: passed ? 'VALIDATED' : 'CHANGES_REQUIRED',
  };
}

// Everything the COE needs before final approval, as a list of human-readable blockers.
export function coeApprovalBlockers({ paperStatus, totalValidators, approvals, requiredApprovals, openIssues }) {
  const required = normalizeRequiredApprovals(requiredApprovals);
  const out = [];
  if (paperStatus !== 'VALIDATED') out.push(`Paper must be VALIDATED (current: ${paperStatus})`);
  if (totalValidators !== VALIDATOR_COUNT) out.push(`Paper must have exactly ${VALIDATOR_COUNT} validators (currently: ${totalValidators})`);
  if (approvals < required) out.push(`At least ${required} of ${VALIDATOR_COUNT} validators must approve (currently: ${approvals})`);
  if (openIssues > 0) out.push(`${openIssues} validator issue(s) are still open; resolve or close them first`);
  return out;
}

// ---------- Validator access and assignments (spec §4, §27) ----------
// Validators work on a paper only while it is under validation: they view it (with the answer key) and
// report issues while VALIDATION_PENDING or VALIDATED, and decide only while VALIDATION_PENDING. From
// COE_APPROVED on (and on any superseded revision) the paper is the COE's alone; a validator keeps only the
// record of their own decision (GET /my-validations).
export const VALIDATOR_ACCESS_STATUSES = ['VALIDATION_PENDING', 'VALIDATED'];
// Statuses in which a single undecided validator may be replaced (GENERATED only for legacy rows).
export const REPLACEABLE_IN = ['GENERATED', 'VALIDATION_PENDING'];
// Why an assignment ended (migration 039 pva_deactivation_reason_check).
export const ASSIGNMENT_END_REASONS = ['reassigned', 'replaced', 'paper_reset', 'paper_regenerated', 'paper_archived'];

export function paperAccessFor({ role, inScope = false, assignedActive = false, paperStatus }) {
  if (role === 'coe' && inScope) return { view: true, answerKey: true, reportIssue: false, decide: false };
  if (role === 'validator' && assignedActive && VALIDATOR_ACCESS_STATUSES.includes(paperStatus)) {
    return { view: true, answerKey: true, reportIssue: canReportIssue(paperStatus), decide: paperStatus === 'VALIDATION_PENDING' };
  }
  return { view: false, answerKey: false, reportIssue: false, decide: false };
}

// ---------- Validator issues (spec §27, §30) ----------
// Same list as the CHECK constraint in migration 028.
export const ISSUE_TYPES = ['spelling', 'grammar', 'incorrect', 'unclear', 'formatting', 'wrong_co', 'wrong_bloom',
  'wrong_difficulty', 'duplicate', 'missing_answer', 'wrong_marks', 'syllabus_mismatch', 'other'];
export const ISSUE_STATUSES = ['open', 'resolved', 'wont_fix', 'carried_forward'];
export const MANUAL_ISSUE_CLOSE = ['resolved', 'wont_fix']; // carried_forward is written only by regeneration
export const ISSUE_REPORTABLE_IN = ['VALIDATION_PENDING', 'VALIDATED'];
export const ISSUE_CLOSABLE_IN = ['GENERATED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED', 'VALIDATED'];
export const COE_SEND_BACK_FROM = ['VALIDATION_PENDING', 'VALIDATED'];
export const canReportIssue = (status) => ISSUE_REPORTABLE_IN.includes(status);
export const canCloseIssue = (status) => ISSUE_CLOSABLE_IN.includes(status);

// Splits a parent revision's open issues on regeneration (spec §30 "resolved: replaced question"): an issue
// about a question the new revision no longer contains is resolved by the replacement; a paper-level issue,
// or one whose question was selected again, is carried to the new revision.
export function planIssueCarry(openIssues, newQuestionIds) {
  const kept = new Set(newQuestionIds);
  const resolve = []; const carry = [];
  for (const i of openIssues) (i.question_id && !kept.has(i.question_id) ? resolve : carry).push(i);
  return { resolve, carry };
}
