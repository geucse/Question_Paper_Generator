// Question lifecycle (PIVOT_SPEC_V2 sections 7, 11, 18).
// States mirror the DB CHECK constraint (migration 026) and the transition guard (migration 038):
// DRAFT > SUBMITTED > UNDER_REVIEW > (CHANGES_REQUESTED <> RESUBMITTED) > APPROVED > ACTIVE > RETIRED ; REJECTED terminal.
// The DB is the final guard (migration 038: trg_question_transition_guard checks every state change,
// trg_question_content_lock freezes approved content); this route adds roles, scope and reasons.
// SUBMITTED and RESUBMITTED are reached only through POST /questions/:id/submit (scan, duplicates, canonical, CO).
// Leaving UNDER_REVIEW is the review batch's decision (src/review-decision.js), applied here by a reviewer on it.
// REJECTED is reached only that way (every reviewer of the round rejected): a question sent back for changes
// is revised and resubmitted, then reviewed again; nobody rejects it alone from CHANGES_REQUESTED.

import express from 'express';
import { get, all, run, withTransaction } from '../db.js';
import { requireAuth } from '../middleware.js';
import { authorize } from '../authorization.js';
import { logAudit } from '../audit.js';
import { notify } from '../notifications.js';
import { reviewDecisionState, openReviewItem } from '../review-decision.js';
import { SCOPE_SQL, isUuid } from '../scopes.js';
import { QUESTION_ATTACHMENTS_SQL } from '../paper-attachments.js';

const router = express.Router();
router.use(requireAuth);

export const TRANSITIONS = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['UNDER_REVIEW', 'DRAFT'],
  UNDER_REVIEW: ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED'],
  CHANGES_REQUESTED: ['RESUBMITTED'],
  RESUBMITTED: ['UNDER_REVIEW'],
  APPROVED: ['ACTIVE', 'CHANGES_REQUESTED'],
  ACTIVE: ['RETIRED', 'CHANGES_REQUESTED'],
  RETIRED: ['ACTIVE'],
  REJECTED: [],
};

// Only these states can be edited by the author; everything later is locked until a reviewer requests changes.
export const EDITABLE_STATUSES = ['DRAFT', 'CHANGES_REQUESTED'];
// Submission targets are reached only through POST /questions/:id/submit (scan, duplicates, canonical, CO).
export const SUBMIT_TARGETS = { DRAFT: 'SUBMITTED', CHANGES_REQUESTED: 'RESUBMITTED' };
const SUBMIT_ONLY = Object.values(SUBMIT_TARGETS);
const REVIEW_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'];

export const RETIREMENT_REASONS = [
  'Syllabus changed', 'Incorrect', 'Duplicate', 'Outdated',
  'Poor quality', 'Overused', 'Curriculum removed',
];

function actionFor(from, to) {
  if (to === 'UNDER_REVIEW') return 'assign_review';
  if (to === 'ACTIVE' && from === 'RETIRED') return 'restore_question';
  if (to === 'ACTIVE') return 'activate_question';
  if (to === 'RETIRED') return 'retire_question';
  if (to === 'DRAFT') return 'submit_question'; // the author withdraws a submission
  return 'review_question'; // APPROVED, CHANGES_REQUESTED, REJECTED
}

// One conditional UPDATE for every move: it applies only if the question is still in `from` (concurrent
// decisions get 409). $1 target, $2 id, $3 actor, $4 reason, $5 from.
const TRANSITION_SQL = `
  UPDATE questions SET
    question_status = $1,
    approved_at  = CASE WHEN $1 = 'APPROVED' THEN now() ELSE approved_at END,
    approved_by  = CASE WHEN $1 = 'APPROVED' THEN $3::uuid ELSE approved_by END,
    activated_by = CASE WHEN $1 = 'ACTIVE' THEN $3::uuid ELSE activated_by END,
    rejection_reason = CASE WHEN $1 = 'REJECTED' THEN $4 ELSE rejection_reason END,
    retired_at   = CASE WHEN $1 = 'RETIRED' THEN now() WHEN $1 = 'ACTIVE' THEN NULL ELSE retired_at END,
    retired_by   = CASE WHEN $1 = 'RETIRED' THEN $3::uuid WHEN $1 = 'ACTIVE' THEN NULL ELSE retired_by END,
    retirement_reason = CASE WHEN $1 = 'RETIRED' THEN $4 WHEN $1 = 'ACTIVE' THEN NULL ELSE retirement_reason END,
    change_request_reason = CASE WHEN $1 = 'CHANGES_REQUESTED' THEN $4 ELSE change_request_reason END,
    change_requested_by   = CASE WHEN $1 = 'CHANGES_REQUESTED' THEN $3::uuid ELSE change_requested_by END,
    change_requested_at   = CASE WHEN $1 = 'CHANGES_REQUESTED' THEN now() ELSE change_requested_at END
  WHERE id = $2 AND question_status = $5
  RETURNING id`;
const STALE = 'The question changed state meanwhile; reload and try again';
// Messages from the DB guards (migration 038) are safe to show and say exactly what was refused.
const DB_REFUSAL = /Quality gate|Invalid question state|content is locked|Approval must|Retirement requires|Review decision required/;
const DECISION_LABEL = { APPROVED: 'approved', CHANGES_REQUESTED: 'sent back for changes', REJECTED: 'rejected' };

class Refusal extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

router.post('/:id/transition', async (req, res) => {
  const { id } = req.params;
  const { target_status, notes, reason } = req.body || {};

  // Roles outside the question bank (admin, COE, validators) are refused before anything about
  // the question is looked at, so they can't learn its state or existence from the error.
  if (req.user.role === 'admin') {
    const authz = await authorize(req.user, 'review_question', { question_id: id, type: 'question', id }); // logged denial
    return res.status(403).json({ error: authz.reason });
  }
  if (!['teacher', 'hod', 'reviewer'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Question lifecycle decisions belong to the question bank roles' });
  }
  if (!isUuid(id)) return res.status(404).json({ error: 'Question not found' });
  if (SUBMIT_ONLY.includes(target_status)) {
    return res.status(400).json({
      error: 'Submitting and resubmitting go through POST /questions/:id/submit, which runs the attachment scan, duplicate check, canonical record and CO mapping',
      submit_path: `/questions/${id}/submit`,
    });
  }

  const question = await get('SELECT id, question_status, submitted_by FROM questions WHERE id = $1', [id]);
  if (!question) return res.status(404).json({ error: 'Question not found' });
  // Visibility before anything about the question's state: only its author, a reviewer assigned to its offering
  // and the HOD whose scope covers it may learn its status (or that it exists). The denial is logged
  // (authorization_log) and answered exactly like an unknown id. The action itself is authorized below.
  const visible = await authorize(req.user, 'view_question_workflow', { question_id: id, type: 'question', id });
  if (!visible.allowed) return res.status(404).json({ error: 'Question not found' });

  const from = question.question_status;
  const allowed = (TRANSITIONS[from] || []).filter((t) => !SUBMIT_ONLY.includes(t));
  if (!allowed.includes(target_status)) {
    return res.status(400).json({ error: `Invalid transition from ${from} to ${target_status}`, allowed });
  }

  // Rejections, change requests, retirement and restore must carry a reason (audited, spec §18, §35).
  const isRestore = from === 'RETIRED' && target_status === 'ACTIVE';
  const why = reason == null ? '' : String(reason).trim();
  const needsReason = isRestore || ['REJECTED', 'CHANGES_REQUESTED', 'RETIRED'].includes(target_status);
  if (needsReason && why.length < 3) {
    return res.status(400).json({ error: isRestore ? 'A reason is required to restore a retired question' : `A reason is required to move a question to ${target_status}` });
  }

  const action = actionFor(from, target_status);
  const authz = await authorize(req.user, action, { question_id: id, action, type: 'question', id });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });

  if (target_status === 'ACTIVE') {
    // Activation and restore re-run the whole gate (the DB re-checks it in the same UPDATE).
    const gate = await get('SELECT * FROM validate_question_for_active($1)', [id]);
    if (!gate.valid) {
      return res.status(400).json({ error: 'Quality gate failed - question cannot be ACTIVE', validation_errors: gate.errors });
    }
  }

  const isReviewDecision = from === 'UNDER_REVIEW' && REVIEW_DECISIONS.includes(target_status);
  // The author withdrawing a submission: a review round it is still in (pre-038 data: batches did not move
  // questions to UNDER_REVIEW) ends with it, so verdicts on this content never decide the edited version.
  const isWithdrawal = from === 'SUBMITTED' && target_status === 'DRAFT';
  const params = [target_status, id, req.user.id, why || null, from];
  let review = null;
  let superseded = [];
  try {
    if (isReviewDecision) {
      // The decision comes from the review batch's verdicts (brain.md §8); it is recorded on the round and the
      // status changes in the same transaction (the DB guard requires both).
      review = await withTransaction(async (txn) => {
        const item = await openReviewItem(id, txn);
        if (item) await txn.get('SELECT id FROM review_batches WHERE id = $1 FOR UPDATE', [item.review_batch_id]); // serialises with verdict changes
        const state = await reviewDecisionState(id, req.user.id, txn, item || null);
        if (!state.allowed.includes(target_status)) {
          throw new Refusal(state.item && !state.me ? 403 : 409, {
            error: state.blockers[0] || state.refusals[target_status] || `The review verdicts allow only: ${state.allowed.join(', ')}`,
            blockers: state.blockers, allowed_decisions: state.allowed,
          });
        }
        const rec = await txn.run(`UPDATE review_batch_items SET outcome = $1, decided_by = $2, decided_at = now()
          WHERE id = $3 AND outcome IS NULL RETURNING id`, [target_status, req.user.id, state.item.id]);
        if (rec.rowCount !== 1) throw new Refusal(409, { error: STALE });
        const upd = await txn.run(TRANSITION_SQL, params);
        if (upd.rowCount !== 1) throw new Refusal(409, { error: STALE });
        return state;
      });
    } else if (isWithdrawal) {
      superseded = await withTransaction(async (txn) => {
        const upd = await txn.run(TRANSITION_SQL, params);
        if (upd.rowCount !== 1) throw new Refusal(409, { error: STALE });
        const closed = await txn.run(`UPDATE review_batch_items SET outcome = 'SUPERSEDED', decided_by = $2, decided_at = now()
          WHERE question_id = $1 AND outcome IS NULL RETURNING review_batch_id`, [id, req.user.id]);
        return closed.rows.map((r) => r.review_batch_id);
      });
    } else {
      const upd = await run(TRANSITION_SQL, params);
      if (upd.rowCount !== 1) return res.status(409).json({ error: STALE });
    }
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json(err.body);
    // The DB guards are the last line of defence; surface their message safely.
    return res.status(400).json({ error: DB_REFUSAL.test(err.message) ? err.message : 'Transition rejected' });
  }

  await logAudit({
    userId: req.user.id,
    action: isRestore ? 'question_transition_restore' : `question_transition_${target_status.toLowerCase()}`,
    entityId: id,
    details: {
      from, to: target_status, reason: why || null, notes: notes || null,
      ...(isRestore && { restore: true }),
      ...(superseded.length && { superseded_review_batch_ids: superseded }),
      ...(review && { review_batch_id: review.item.review_batch_id, verdicts: review.verdicts.map((v) => ({ reviewer_id: v.reviewer_id, decision: v.decision })) }),
    },
    ip: req.ip,
  });
  if (DECISION_LABEL[target_status]) {
    await notify(question.submitted_by, 'question_review_decision',
      `Your question was ${DECISION_LABEL[target_status]}${why ? `: ${why}` : ''}.`, id);
  }

  res.json({ message: `Question transitioned to ${target_status}`, question_status: target_status,
    ...(review && { review_batch_id: review.item.review_batch_id }) });
});

router.get('/retirement-reasons', (req, res) => res.json(RETIREMENT_REASONS));

// Questions the caller may act on, by lifecycle state (spec §4: role + scope, never the whole bank).
//   teacher  -> own questions
//   reviewer -> non-draft questions in offerings they are actively assigned to (never their own)
//   hod      -> non-draft questions in departments/campuses covered by an active HOD scope
// Bounded: at most 200 rows per page. Each row is the full question (type data, answer key, model answer, clean
// attachments): everyone who may list it is in its workflow (author, assigned reviewer, HOD in scope).
// SCOPE_SQL (src/scopes.js) is shared with the HOD lists in questions.js, analytics, review batches and legacy papers;
// it expects aliases co (course_offerings) and p (programs), $1 = user id, $2 = role. Re-exported here for callers.
export { SCOPE_SQL };

router.get('/lifecycle', async (req, res) => {
  const role = req.user.role;
  if (!['teacher', 'reviewer', 'hod'].includes(role)) return res.status(403).json({ error: 'Question lifecycle is part of the question bank domain' });
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  if (status && !Object.keys(TRANSITIONS).includes(status)) return res.status(400).json({ error: 'Unknown status', statuses: Object.keys(TRANSITIONS) });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const params = [req.user.id, role, status, limit, offset];
  let where;
  // Every branch references both $1 and $2: Postgres rejects bind parameters a statement doesn't use.
  if (role === 'teacher') where = `q.submitted_by = $1 AND $2::text = 'teacher'`;
  else if (role === 'reviewer') {
    where = `q.submitted_by <> $1 AND q.question_status <> 'DRAFT' AND ${SCOPE_SQL}
      AND EXISTS (SELECT 1 FROM reviewer_assignments ra WHERE ra.reviewer_id = $1 AND ra.course_offering_id = q.course_offering_id AND ra.is_active)`;
  } else where = `q.question_status <> 'DRAFT' AND ${SCOPE_SQL}`;

  const rows = await all(`
    SELECT q.id, q.question_text, q.question_status, q.question_type, q.difficulty, q.bloom_level,
           q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.model_answer, q.answer_data, q.subtopic,
           ${QUESTION_ATTACHMENTS_SQL} AS attachments,
           q.marks, q.topic, q.submitted_at, q.approved_at, q.activated_at, q.retired_at, q.retirement_reason,
           q.change_request_reason, q.change_requested_at, q.times_used, q.last_used_at, s.subject_code, co.offering_code,
           CASE WHEN q.submitted_by = $1 THEN NULL ELSE u.email END AS author_email,
           (q.submitted_by = $1) AS is_mine,
           EXISTS (SELECT 1 FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id
                    WHERE rbi.question_id = q.id AND rbi.outcome IS NULL AND rb.status <> 'cancelled') AS in_review_batch
    FROM questions q
    JOIN course_offerings co ON co.id = q.course_offering_id
    JOIN programs p ON p.id = co.program_id
    LEFT JOIN subjects s ON s.id = q.subject_id
    LEFT JOIN users u ON u.id = q.submitted_by
    WHERE ${where} AND ($3::text IS NULL OR q.question_status = $3::text)
    ORDER BY COALESCE(q.submitted_at, q.created_at) DESC
    LIMIT $4 OFFSET $5`, params);

  const counts = await all(`
    SELECT q.question_status, COUNT(*)::int AS n
    FROM questions q
    JOIN course_offerings co ON co.id = q.course_offering_id
    JOIN programs p ON p.id = co.program_id
    WHERE ${where}
    GROUP BY q.question_status`, [req.user.id, role]);

  res.json({ questions: rows, counts: Object.fromEntries(counts.map((c) => [c.question_status, c.n])), limit, offset });
});

// Lifecycle history (spec §35): every transition plus the create, edit, submit, resubmit, bulk import,
// duplicate and CO-mapping events, and the advisory AI checks. Pre-phase-1 decisions (now retired routes)
// are shown as 'legacy'. Each row carries a normalised `event`.
const HISTORY_EVENTS = {
  draft_created: 'draft_created', draft_updated: 'draft_updated', question_final_submit: 'submitted',
  question_resubmitted: 'resubmitted', question_bulk_imported: 'bulk_imported',
  question_withdrawn_as_duplicate: 'withdrawn_duplicate', question_co_mapping_changed: 'co_mapping_changed',
  ai_review_completed: 'ai_review', ai_review_disputed: 'ai_review_disputed',
  question_approved: 'legacy', question_rejected: 'legacy', question_flagged: 'legacy', reviewer_verdict: 'legacy', ai_review_appealed: 'legacy',
  // Syllabus versioning (042): re-mapped automatically, flagged by a change, mapped by the HOD, left for mapping.
  question_syllabus_remapped: 'syllabus_remapped', question_syllabus_flagged: 'syllabus_flagged',
  question_syllabus_mapped: 'syllabus_mapped', question_syllabus_remap_skipped: 'syllabus_remap_skipped',
};
const HISTORY_ACTIONS = Object.keys(HISTORY_EVENTS);

// The history carries reviewers' reasons and verdicts, so it is limited to the people in the question's
// workflow: the author, reviewers assigned to its offering and HODs whose scope covers it.
router.get('/:id/lifecycle', async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(404).json({ error: 'Question not found' });
  const q = await get(`
    SELECT question_status, created_at, submitted_at, approved_at, activated_at, retired_at, retirement_reason,
           change_request_reason, change_requested_at
    FROM questions WHERE id = $1`, [id]);
  if (!q) return res.status(404).json({ error: 'Question not found' });

  const authz = await authorize(req.user, 'view_question_workflow', { question_id: id, type: 'question', id });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });

  const trail = await all(`
    SELECT action, created_at, details FROM audit_log
    WHERE entity_id = $1::text AND (action LIKE 'question_transition_%' OR action = ANY($2::text[]))
    ORDER BY created_at DESC, id DESC LIMIT 200`, [id, HISTORY_ACTIONS]);

  res.json({ ...q, audit_trail: trail.map((t) => ({ ...t, event: t.action.startsWith('question_transition_') ? 'transition' : HISTORY_EVENTS[t.action] })) });
});

export default router;
