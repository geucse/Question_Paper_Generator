// Question lifecycle states (PIVOT_SPEC_V2 §7). The states mirror the DB CHECK
// constraint from migration 026 — keep them in sync with
// backend/src/routes/questions-lifecycle.js TRANSITIONS.
export const QUESTION_STATES = {
  DRAFT: { cls: 'badge-draft', label: 'Draft' },
  SUBMITTED: { cls: 'badge-pending', label: 'Submitted' },
  UNDER_REVIEW: { cls: 'badge-pending', label: 'Under review' },
  CHANGES_REQUESTED: { cls: 'badge-rejected', label: 'Changes requested' },
  RESUBMITTED: { cls: 'badge-pending', label: 'Resubmitted' },
  APPROVED: { cls: 'badge-approved', label: 'Approved' },
  ACTIVE: { cls: 'badge-approved', label: 'Active' },
  RETIRED: { cls: 'badge-draft', label: 'Retired' },
  REJECTED: { cls: 'badge-rejected', label: 'Rejected' },
};
