// COE final approval, PRINT_READY lock and archiving (PIVOT_SPEC_V2 sections 26, 28, 29).
// Every rule here is also enforced by the database (migration 036, enforce_paper_lifecycle);
// the route adds identity, scope, TOTP step-up and readable errors.
import express from 'express';
import { authorize } from '../authorization.js';
import { get, all, run, withTransaction } from '../db.js';
import { logAudit } from '../audit.js';
import { requireAuth, requireRole } from '../middleware.js';
import { verifyStepUp } from '../totp.js';
import { describeError } from '../errors.js';
import { loadPaper, canSeePaper, paperScope, coeCoversPaper } from '../paper-access.js';
import { canTransitionPaper, coeApprovalBlockers, normalizeRequiredApprovals, COE_SEND_BACK_FROM } from '../paper-policy.js';
import { notifyEndedAssignments, notifyValidators } from '../paper-notifications.js';

const router = express.Router();
router.use(requireAuth);

// Database trigger messages that are safe and useful to show to the COE.
const SAFE_DB_ERRORS = /validators must approve|COE approval required|must be TOTP-verified|exactly 4 active validators|Invalid paper status transition|Cannot modify (PRINT_READY|ARCHIVED)|Open validator issues must be resolved|recorded COE send-back|Validators of a|cannot be removed|recorded decision|already has a printed paper/;

async function approvalCounts(paperId) {
  return get(`
    SELECT COUNT(*) FILTER (WHERE decision = 'APPROVE')::int AS approved, COUNT(*)::int AS total
    FROM paper_validator_assignments
    WHERE paper_id = $1 AND is_active = true`, [paperId]);
}

async function openIssueCount(paperId) {
  const row = await get(`SELECT COUNT(*)::int AS n FROM paper_issues WHERE paper_id = $1 AND status = 'open'`, [paperId]);
  return row?.n || 0;
}

// COE final approval with TOTP step-up (spec §29).
router.post('/papers/:paperId/coe-approve', requireRole('coe'), async (req, res) => {
  const { paperId } = req.params;
  const { totp_code } = req.body || {};
  if (!totp_code) return res.status(400).json({ error: 'TOTP code required for COE approval' });

  try {
    const paper = await loadPaper(paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    const required = normalizeRequiredApprovals(paper.required_approvals);
    const resource = { paper_id: paperId, ...paperScope(paper), required_approvals: required, type: 'coe_approval', id: paperId };
    // Scope = the paper's whole context (campus, department, program, offering), checked BEFORE its status is told:
    // a COE of another program or campus learns nothing about this paper. The denial is logged by authorize().
    if (!(await coeCoversPaper(req.user, paper))) {
      const denied = await authorize(req.user, 'approve_paper_coe', resource);
      return res.status(403).json({ error: denied.reason });
    }
    if (paper.paper_status !== 'VALIDATED') {
      return res.status(400).json({ error: `Paper must be VALIDATED before COE approval (current: ${paper.paper_status})` });
    }
    const authz = await authorize(req.user, 'approve_paper_coe', resource);
    if (!authz.allowed) return res.status(403).json({ error: authz.reason });

    // TOTP step-up (totp.js): sealed secret, single-use code, step_up_auth_log, per-user lockout.
    const step = await verifyStepUp(null, req.user, String(totp_code), { action: 'coe_approval', entityId: paperId, ip: req.ip });
    if (!step.ok) {
      await logAudit({ userId: req.user.id, action: 'coe_approval_totp_failed', entityId: paperId, details: { reason: step.error }, ip: req.ip });
      return res.status(step.status).json({ error: step.error, ...(step.needs_totp_setup ? { needs_totp_setup: true } : {}) });
    }

    const counts = await approvalCounts(paperId);
    const blockers = coeApprovalBlockers({
      paperStatus: paper.paper_status, totalValidators: counts.total, approvals: counts.approved,
      requiredApprovals: required, openIssues: await openIssueCount(paperId),
    });
    if (blockers.length) return res.status(409).json({ error: 'Paper is not ready for COE approval', reasons: blockers });

    // Conditional on the status we checked, so two concurrent approvals can't both succeed.
    const { rowCount } = await run(`
      UPDATE exam_papers
      SET paper_status = 'COE_APPROVED', coe_approved_by = $1, coe_approved_at = now(), coe_approval_totp_verified = true
      WHERE id = $2 AND paper_status = 'VALIDATED'
      RETURNING id`, [req.user.id, paperId]);
    if (!rowCount) return res.status(409).json({ error: 'Paper status changed while approving; reload and try again' });

    await logAudit({ userId: req.user.id, action: 'coe_approval_granted', entityId: paperId,
      details: { totp_verified: true, validator_approvals: counts.approved, required_approvals: required }, ip: req.ip });
    res.json({ message: 'COE approval granted with TOTP verification', paper_status: 'COE_APPROVED' });
  } catch (err) {
    if (SAFE_DB_ERRORS.test(err.message || '')) return res.status(400).json({ error: err.message });
    console.error('Failed COE approval:', JSON.stringify(describeError(err, { withStack: true })));
    res.status(500).json({ error: 'Failed to process COE approval' });
  }
});

// COE send-back (spec §27 "COE decides whether to replace/regenerate"): VALIDATION_PENDING or VALIDATED ->
// CHANGES_REQUIRED with a reason, so an issue found late is acted on instead of approved anyway. It approves
// nothing and needs no TOTP. The paper_send_backs row is written in the same transaction; the database refuses
// VALIDATED -> CHANGES_REQUIRED without it (migration 039). Validator decisions stay on record; the COE then
// regenerates the paper as a new revision.
router.post('/papers/:paperId/send-back', requireRole('coe'), async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 10 || reason.length > 2000) return res.status(400).json({ error: 'A reason of at least 10 characters is required to send a paper back' });
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
  let out;
  try {
    out = await withTransaction(async (txn) => {
      const p = await txn.get('SELECT id, paper_status FROM exam_papers WHERE id = $1 FOR UPDATE', [paper.id]);
      if (!COE_SEND_BACK_FROM.includes(p?.paper_status)) {
        return { status: 409, error: `Only a VALIDATION_PENDING or VALIDATED paper can be sent back (current: ${p?.paper_status})` };
      }
      const open = (await txn.all(`SELECT id FROM paper_issues WHERE paper_id = $1 AND status = 'open' ORDER BY created_at`, [p.id])).map((r) => r.id);
      await txn.run('INSERT INTO paper_send_backs (paper_id, from_status, reason, open_issue_ids, sent_back_by) VALUES ($1,$2,$3,$4::uuid[],$5)',
        [p.id, p.paper_status, reason, open, req.user.id]);
      const upd = await txn.run(`UPDATE exam_papers SET paper_status = 'CHANGES_REQUIRED' WHERE id = $1 AND paper_status = $2 RETURNING id`, [p.id, p.paper_status]);
      if (upd.rowCount !== 1) return { status: 409, error: 'Paper status changed; reload and try again' };
      // Audit last, in the same transaction: the status change and its record commit together.
      await logAudit({ userId: req.user.id, action: 'paper_sent_back', entityId: paper.id,
        details: { from: p.paper_status, to: 'CHANGES_REQUIRED', reason, open_issue_ids: open }, ip: req.ip }, txn);
      return { from: p.paper_status, open };
    });
  } catch (err) {
    if (SAFE_DB_ERRORS.test(err.message || '')) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (out.error) return res.status(out.status).json({ error: out.error });
  const validators = await all('SELECT validator_id FROM paper_validator_assignments WHERE paper_id = $1 AND is_active', [paper.id]);
  await notifyValidators(validators.map((v) => v.validator_id), paper.id, 'paper_sent_back', `the COE sent the paper back for changes: ${reason}`);
  res.json({ message: 'Paper sent back for changes', paper_status: 'CHANGES_REQUIRED', open_issue_ids: out.open });
});

// Transition to PRINT_READY (COE only, after COE approval). Locks the paper.
// A revision of a printed paper (/examinations/papers/:id/revise) replaces it here: the previous PRINT_READY
// paper of the examination is archived in the same transaction (its validators stay as its approval record), so
// an examination never has two printed papers (migration 039 checks it at COMMIT).
router.post('/papers/:paperId/print-ready', requireRole('coe'), async (req, res) => {
  const { paperId } = req.params;
  try {
    const paper = await loadPaper(paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
    if (paper.paper_status !== 'COE_APPROVED') {
      return res.status(400).json({ error: `Paper must be COE_APPROVED before PRINT_READY (current: ${paper.paper_status})` });
    }
    if (paper.coe_approved_by !== req.user.id) {
      return res.status(403).json({ error: 'Only the COE who approved can mark paper as PRINT_READY' });
    }
    const out = await withTransaction(async (txn) => {
      const p = await txn.get('SELECT id, paper_status FROM exam_papers WHERE id = $1 FOR UPDATE', [paperId]);
      if (p?.paper_status !== 'COE_APPROVED') return { status: 409, error: 'Paper status changed; reload and try again' };
      const replaced = await txn.all(`
        UPDATE exam_papers SET paper_status = 'ARCHIVED', archived_at = now(), archived_by = $1, archive_reason = $2
        WHERE examination_id = $3 AND paper_status = 'PRINT_READY' AND id <> $4
        RETURNING id, paper_version`, [req.user.id, `Replaced by printed revision v${paper.paper_version}`, paper.examination_id, paperId]);
      await txn.run(`UPDATE exam_papers SET paper_status = 'PRINT_READY', locked_by = $1 WHERE id = $2 AND paper_status = 'COE_APPROVED'`, [req.user.id, paperId]);
      // Audit last, in the same transaction (chain lock held until COMMIT).
      for (const old of replaced) {
        await logAudit({ userId: req.user.id, action: 'paper_archived', entityId: old.id,
          details: { from: 'PRINT_READY', reason: `Replaced by printed revision v${paper.paper_version}`, replaced_by: paperId }, ip: req.ip }, txn);
      }
      await logAudit({ userId: req.user.id, action: 'paper_print_ready', entityId: paperId,
        details: { locked: true, replaced_printed_papers: replaced.map((r) => r.id) }, ip: req.ip }, txn);
      return { replaced };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json({ message: 'Paper is now PRINT_READY and locked', paper_status: 'PRINT_READY', archived_printed_papers: out.replaced.map((r) => r.id) });
  } catch (err) {
    if (SAFE_DB_ERRORS.test(err.message || '')) return res.status(400).json({ error: err.message });
    console.error('Failed to mark PRINT_READY:', JSON.stringify(describeError(err, { withStack: true })));
    res.status(500).json({ error: 'Failed to mark paper as PRINT_READY' });
  }
});

// Archive (spec §26: ... -> PRINT_READY -> ARCHIVED). Also used to retire abandoned or superseded revisions.
// Archiving never deletes anything and never changes the paper's content.
router.post('/papers/:paperId/archive', requireRole('coe'), async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 10) return res.status(400).json({ error: 'A reason of at least 10 characters is required to archive a paper' });
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
  if (!canTransitionPaper(paper.paper_status, 'ARCHIVED')) {
    return res.status(409).json({ error: `A ${paper.paper_status} paper cannot be archived` });
  }
  try {
    const { rowCount } = await run(`
      UPDATE exam_papers SET paper_status = 'ARCHIVED', archived_at = now(), archived_by = $1, archive_reason = $2
      WHERE id = $3 AND paper_status = $4
      RETURNING id`, [req.user.id, reason, paper.id, paper.paper_status]);
    if (!rowCount) return res.status(409).json({ error: 'Paper status changed; reload and try again' });
  } catch (err) {
    if (SAFE_DB_ERRORS.test(err.message || '') || /Archiving a PRINT_READY/.test(err.message || '')) return res.status(400).json({ error: err.message });
    throw err;
  }
  await logAudit({ userId: req.user.id, action: 'paper_archived', entityId: paper.id, details: { from: paper.paper_status, reason }, ip: req.ip });
  // Migration 039 ended the validators of a revision archived before printing (a PRINT_READY paper keeps them
  // as its approval record, so this is a no-op then).
  await notifyEndedAssignments(paper.id, 'paper_archived', 'this paper revision was archived; your validation assignment has ended.');
  res.json({ message: 'Paper archived', paper_status: 'ARCHIVED' });
});

// Approval status. Same visibility as the paper itself: COE with campus scope, or an assigned validator
// while the paper is under validation (paper-access.js).
router.get('/papers/:paperId/coe-status', async (req, res) => {
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });

  const counts = await approvalCounts(paper.id);
  const openIssues = await openIssueCount(paper.id);
  const required = normalizeRequiredApprovals(paper.required_approvals);
  const approver = paper.coe_approved_by ? await get('SELECT full_name, email FROM users WHERE id = $1', [paper.coe_approved_by]) : null;
  const blockers = coeApprovalBlockers({
    paperStatus: paper.paper_status, totalValidators: counts.total, approvals: counts.approved, requiredApprovals: required, openIssues,
  });

  res.json({
    paper_status: paper.paper_status,
    coe_approved: !!paper.coe_approved_by,
    coe_approved_by: approver ? (approver.full_name || approver.email) : null,
    coe_approved_at: paper.coe_approved_at,
    totp_verified: paper.coe_approval_totp_verified,
    validator_approvals: counts.approved,
    total_validators: counts.total,
    required_approvals: required,
    open_issues: openIssues,
    ready_for_coe_approval: blockers.length === 0,
    blockers,
    ready_for_print: paper.paper_status === 'COE_APPROVED',
    is_locked: paper.paper_status === 'PRINT_READY' || (paper.paper_status === 'ARCHIVED' && !!paper.locked_at),
    locked_at: paper.locked_at,
  });
});

export default router;
