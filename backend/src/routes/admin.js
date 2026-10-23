// Admin = technical administration only (PIVOT_SPEC_V2 sections 2, 36).
// Nothing here approves, reviews or edits academic content.
import express from 'express';
import { get, all, run, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { grantScope, revokeScope, isUuid } from '../scopes.js';
import { checkScopeRow } from '../accounts.js';
import { getReadiness } from './health.js';
import { rescanPending } from '../attachment-scan.js';
import { OVERRIDE_RESET_FROM, MIN_REQUIRED_APPROVALS, VALIDATOR_COUNT, normalizeRequiredApprovals } from '../paper-policy.js';
import { notifyPaperCoes, notifyValidators, notifyValidatorsNeedingReplacement } from '../paper-notifications.js';

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/system', async (req, res) => {
  const [users, questions, papers, lockdown, migrations, denials, overrides, attachments, readiness] = await Promise.all([
    all('SELECT role, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_active)::int AS active FROM users GROUP BY role ORDER BY role'),
    all('SELECT question_status, COUNT(*)::int AS n FROM questions GROUP BY question_status ORDER BY 1'),
    all('SELECT paper_status, COUNT(*)::int AS n FROM exam_papers GROUP BY paper_status ORDER BY 1'),
    get("SELECT value, updated_at FROM system_state WHERE key = 'lockdown_mode'"),
    get('SELECT COUNT(*)::int AS n, MAX(applied_at) AS last_applied FROM schema_migrations'),
    all(`SELECT action, reason, created_at FROM authorization_log WHERE decision = 'deny' ORDER BY created_at DESC LIMIT 15`),
    all('SELECT id, entity_type, entity_id, action, reason, created_at FROM admin_overrides ORDER BY created_at DESC LIMIT 10'),
    // Counts only: the admin sees how many uploads await a scan, never which question or file (technical-only).
    all('SELECT scan_status, COUNT(*)::int AS n FROM question_attachments GROUP BY 1 ORDER BY 1'),
    getReadiness().then((r) => r.body),
  ]);
  res.json({ users, questions, papers, lockdown, migrations, recent_denials: denials, recent_overrides: overrides, attachments, readiness });
});

// Rescan uploads the virus scanner could not check (attachment-scan.js). Technical batch, counts only.
router.post('/attachments/rescan', async (req, res) => {
  const limit = req.body?.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ error: 'limit must be an integer from 1 to 100' });
  const r = await rescanPending({ limit, actorId: req.user.id, ip: req.ip, maxAttempts: null });
  if (r.skipped) return res.status(503).json({ error: 'The virus scanner is unavailable; nothing was rescanned' });
  await logAudit({ userId: req.user.id, action: 'attachment_rescan_batch', entityId: null, details: r, ip: req.ip });
  res.json(r);
});

// Account-setup pickers (campuses, departments, programs): technical hierarchy only, nothing academic.
router.get('/hierarchy', async (req, res) => {
  const [campuses, departments, programs] = await Promise.all([
    all('SELECT id, name, code, is_active FROM campuses ORDER BY name'),
    all('SELECT id, name, code, campus_id FROM departments WHERE is_active ORDER BY name'),
    all('SELECT id, name, code, department_id, campus_id FROM programs WHERE is_active ORDER BY name'),
  ]);
  res.json({ campuses, departments, programs });
});

// ---- Scope management (accounts/roles are an admin responsibility) ----
router.get('/scopes', async (req, res) => {
  const { user_id } = req.query;
  const rows = await all(`
    SELECT s.*, u.email FROM user_scopes s JOIN users u ON u.id = s.user_id
    WHERE ($1::uuid IS NULL OR s.user_id = $1::uuid) AND s.is_active = TRUE
    ORDER BY u.email, s.role LIMIT 500`, [user_id || null]);
  res.json(rows);
});

// Teacher scopes are never granted here: they come from teacher assignments (the HOD's staffing decision), and a
// broader teacher scope would match offerings the teacher does not teach.
router.post('/scopes', async (req, res) => {
  const { user_id, role, campus_id, department_id, program_id, course_offering_id } = req.body || {};
  const user = isUuid(user_id) ? await get('SELECT id, role, is_active FROM users WHERE id = $1', [user_id]) : null;
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.is_active) return res.status(409).json({ error: 'The account is inactive; reactivate it first' });
  if (user.role !== role) return res.status(400).json({ error: `Scope role must match the user's role (${user.role})` });
  if (role === 'teacher') return res.status(400).json({ error: 'Teacher scopes come from course assignments (made by the HOD)' });
  if (course_offering_id) return res.status(400).json({ error: 'Offering-level scopes come from assignments' });
  // An HOD heads a whole department: every HOD check (authorization.js, scopes.js hodCovers/hodCoversSql) works at
  // campus + department level, so a program-limited HOD scope would silently cover the whole department. Refused
  // here and by chk_user_scopes_hod_department_level (migration 040 section F).
  if (role === 'hod' && program_id) return res.status(400).json({ error: 'An HOD scope covers a whole department; it cannot be limited to one program' });
  if (!campus_id) return res.status(400).json({ error: 'campus_id is required' });
  // The same hierarchy rules as provisioning: the department belongs to the campus, the program to both.
  if (['hod', 'reviewer'].includes(role) && !department_id) return res.status(400).json({ error: `A ${role} scope needs a department` });
  const rowError = await checkScopeRow({ get }, { campusId: campus_id, departmentId: department_id || null, programId: program_id || null });
  if (rowError) return res.status(400).json({ error: rowError });
  const id = await grantScope({
    userId: user_id, role, campusId: campus_id, departmentId: department_id || null, programId: program_id || null, grantedBy: req.user.id,
  });
  await logAudit({ userId: req.user.id, action: 'scope_granted', entityId: user_id, details: { scope_id: id, role, campus_id, department_id, program_id }, ip: req.ip });
  res.json({ id });
});

router.delete('/scopes/:id', async (req, res) => {
  const scope = isUuid(req.params.id) ? await get('SELECT * FROM user_scopes WHERE id = $1', [req.params.id]) : null;
  if (!scope) return res.status(404).json({ error: 'Scope not found' });
  // Teacher access is decided by the HOD's course assignments (questions.js, bulk.js, authorization.js); a teacher
  // scope only mirrors an assignment and ending the assignment revokes it. Revoking the mirror here would report
  // success while the teacher kept working, so it is refused with the real path.
  if (scope.role === 'teacher') {
    return res.status(409).json({ error: "A teacher's access comes from course assignments: ask the HOD to end the assignment (that revokes this scope), or deactivate the account" });
  }
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 500) : 'revoked by admin';
  const revoked = await revokeScope(scope.id, { by: req.user.id, reason });
  if (!revoked) return res.status(409).json({ error: 'That scope is already revoked' });
  await logAudit({ userId: req.user.id, action: 'scope_revoked', entityId: scope.user_id, details: { scope_id: scope.id, role: scope.role, reason }, ip: req.ip });
  // A validator who lost scope can no longer decide (re-checked at decision time); tell the COEs to replace them.
  if (scope.role === 'validator') await notifyValidatorsNeedingReplacement(scope.user_id, 'lost validator scope for this campus');
  res.json({ ok: true });
});

// ---- Emergency technical override (spec section 36) ----
// Only recovers a STUCK, not-yet-locked paper (e.g. validators left the
// organisation). It never approves anything: the paper returns to GENERATED so the
// COE re-runs the normal workflow. It never overturns a CHANGES_REQUIRED verdict either
// (that would let rejected content be re-validated unchanged, an academic re-approval
// path §36 forbids): a CHANGES_REQUIRED paper, or a VALIDATION_PENDING round that holds a
// CHANGES_REQUIRED decision, is refused; the COE regenerates or archives it. Also enforced
// by the database (migration 039). Validator decisions are not deleted: the active
// round is ended ('paper_reset') and kept as history (migration 039), so the same
// validators can be assigned again and decide in a new round. Open issues stay;
// the COE still closes them before approval.
router.post('/overrides/reset-paper', async (req, res) => {
  const { paper_id, reason } = req.body || {};
  if (!reason || reason.trim().length < 10) return res.status(400).json({ error: 'A reason of at least 10 characters is required' });
  const paper = await get('SELECT id, paper_status FROM exam_papers WHERE id = $1', [paper_id]);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  const refusal = (status, objections = 0) => {
    if (['PRINT_READY', 'ARCHIVED'].includes(status)) return 'Locked papers cannot be overridden; the COE revises a printed paper as a new revision instead';
    if (status === 'CHANGES_REQUIRED') return 'A CHANGES_REQUIRED paper is not stuck: the COE regenerates it as a new revision or archives it. The technical reset never overturns a validation verdict.';
    if (!['GENERATED', ...OVERRIDE_RESET_FROM].includes(status)) return `A ${status} paper cannot be reset; only papers stuck between generation and PRINT_READY`;
    if (status === 'VALIDATION_PENDING' && objections > 0) {
      return `${objections} validator(s) already recorded CHANGES_REQUIRED in this round; the technical reset cannot discard that. The COE replaces undecided validators, or sends the paper back and regenerates it.`;
    }
    return null;
  };
  if (refusal(paper.paper_status)) return res.status(409).json({ error: refusal(paper.paper_status) });
  const out = await withTransaction(async (txn) => {
    // Transaction-local flag read by the enforce_paper_lifecycle and guard_validator_assignment triggers
    // (migrations 036, 039). It is the only way back to GENERATED, so the override cannot be used outside
    // this audited route.
    await txn.run("SELECT set_config('app.paper_override', 'on', true)");
    // The status is re-checked under the row lock: a concurrent regenerate/approval must not be overridden.
    const cur = await txn.get('SELECT id, paper_status FROM exam_papers WHERE id = $1 FOR UPDATE', [paper_id]);
    const { n: objections } = await txn.get(`SELECT COUNT(*)::int AS n FROM paper_validator_assignments
                                             WHERE paper_id = $1 AND is_active AND decision = 'CHANGES_REQUIRED'`, [paper_id]);
    if (refusal(cur?.paper_status, objections)) return { status: 409, error: refusal(cur?.paper_status, objections) };
    const ended = await txn.all(`
      UPDATE paper_validator_assignments SET is_active = FALSE, deactivated_by = $2, deactivation_reason = 'paper_reset', deactivation_note = $3
      WHERE paper_id = $1 AND is_active RETURNING id, validator_id, validator_number, decision, validation_round`, [paper_id, req.user.id, reason.trim()]);
    await txn.run(`UPDATE exam_papers SET paper_status = 'GENERATED', coe_approved_by = NULL, coe_approved_at = NULL,
                   coe_approval_totp_verified = FALSE, required_approvals = NULL WHERE id = $1`, [paper_id]);
    await txn.run(`INSERT INTO admin_overrides (admin_id, entity_type, entity_id, action, reason, old_value, new_value)
                   VALUES ($1, 'paper', $2, 'reset_paper', $3, $4, $5)`,
      [req.user.id, paper_id, reason.trim(), JSON.stringify({ paper_status: cur.paper_status, ended_assignments: ended }), JSON.stringify({ paper_status: 'GENERATED' })]);
    // Audit last, in the same transaction: the reset and its record commit together (chain lock held until COMMIT).
    await logAudit({ userId: req.user.id, action: 'technical_override_reset_paper', entityId: paper_id,
      details: { from: cur.paper_status, reason, ended_assignments: ended }, ip: req.ip }, txn);
    return { from: cur.paper_status, ended };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await notifyValidators(out.ended.map((v) => v.validator_id), paper_id, 'validation_ended', 'the technical administrator reset this paper; your validation round has ended.');
  await notifyPaperCoes(paper_id, 'paper_reset', 'the technical administrator reset this paper to GENERATED; assign validators again to restart validation.');
  res.json({ ok: true, paper_status: 'GENERATED', ended_assignments: out.ended.length });
});

// ---- Validation policy (spec §27: "All 4 must approve" by default, configurable) ----
// Institution configuration, so it sits with the technical admin; it never approves anything.
// Each paper freezes the value in force when its validators are assigned, so a change only
// affects papers assigned afterwards.
router.get('/settings/validation-policy', async (req, res) => {
  const row = await get("SELECT value, updated_at FROM system_state WHERE key = 'required_validator_approvals'");
  res.json({ required_approvals: normalizeRequiredApprovals(row?.value), updated_at: row?.updated_at || null,
    allowed_values: [MIN_REQUIRED_APPROVALS, VALIDATOR_COUNT].filter((v, i, a) => a.indexOf(v) === i) });
});

router.put('/settings/validation-policy', async (req, res) => {
  const { required_approvals, reason } = req.body || {};
  const n = Number(required_approvals);
  if (!Number.isInteger(n) || n < MIN_REQUIRED_APPROVALS || n > VALIDATOR_COUNT) {
    return res.status(400).json({ error: `required_approvals must be an integer from ${MIN_REQUIRED_APPROVALS} to ${VALIDATOR_COUNT}` });
  }
  if (!reason || String(reason).trim().length < 10) return res.status(400).json({ error: 'A reason of at least 10 characters is required' });
  const before = await get("SELECT value FROM system_state WHERE key = 'required_validator_approvals'");
  await run(`INSERT INTO system_state (key, value, updated_at) VALUES ('required_validator_approvals', $1, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [String(n)]);
  await logAudit({ userId: req.user.id, action: 'validation_policy_changed', entityId: null,
    details: { old_value: normalizeRequiredApprovals(before?.value), new_value: n, reason: String(reason).trim() }, ip: req.ip });
  res.json({ required_approvals: n });
});

// Optional validator-independence rule (spec §27): validator ≠ reviewer of any question in the paper.
// The reviewer set is paper_question_reviewers() (migration 039); it is checked at assignment, at replacement
// and again when the validator decides (src/validator-eligibility.js).
router.get('/settings/validator-independence', async (req, res) => {
  const row = await get("SELECT value, updated_at FROM system_state WHERE key = 'validator_excludes_question_reviewers'");
  res.json({ exclude_question_reviewers: String(row?.value).toLowerCase() === 'true', updated_at: row?.updated_at || null });
});

router.put('/settings/validator-independence', async (req, res) => {
  const { exclude_question_reviewers, reason } = req.body || {};
  if (typeof exclude_question_reviewers !== 'boolean') return res.status(400).json({ error: 'exclude_question_reviewers must be true or false' });
  if (!reason || String(reason).trim().length < 10) return res.status(400).json({ error: 'A reason of at least 10 characters is required' });
  const before = await get("SELECT value FROM system_state WHERE key = 'validator_excludes_question_reviewers'");
  await run(`INSERT INTO system_state (key, value, updated_at) VALUES ('validator_excludes_question_reviewers', $1, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [String(exclude_question_reviewers)]);
  await logAudit({ userId: req.user.id, action: 'validator_independence_policy_changed', entityId: null,
    details: { old_value: String(before?.value).toLowerCase() === 'true', new_value: exclude_question_reviewers, reason: String(reason).trim() }, ip: req.ip });
  res.json({ exclude_question_reviewers });
});

router.get('/overrides', async (req, res) => {
  res.json(await all('SELECT * FROM admin_overrides ORDER BY created_at DESC LIMIT 100'));
});

export default router;
