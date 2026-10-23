// Account administration (PIVOT_SPEC_V2 §2, §4, §5, §35), mounted at /api/academic/users (the URLs the frontend
// already uses). Admin provisions every role; an HOD provisions and manages teacher/reviewer accounts in a
// department its hod scope covers. Every change runs in one transaction with its audit row (logged last).
//   - Provisioning grants the role's scopes and emails a one-time setup code; no password is ever sent or shown.
//   - Deactivation revokes every scope, bumps token_version (all sessions end) and burns pending codes; migration
//     040 enforces the same with triggers, so manual SQL cannot leave a deactivated user with live access.
//   - Role change (admin only, with a reason) revokes the old role's scopes and assignments and grants the new ones.
import express from 'express';
import { get, all, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { notify } from '../notifications.js';
import { grantScope, revokeAllScopes, isUuid, hodCoversSql } from '../scopes.js';
import { departmentContext, checkAcademic } from '../academic-scope.js';
import { notifyValidatorsNeedingReplacement } from '../paper-notifications.js';
import { devSecretsExposed, deliverNotice } from '../otp-delivery.js';
import {
  PROVISIONABLE_BY, ROLES, normalizeEmail, validateIdentity, resolveScopePlan, canManage, isLastActiveAdmin,
  baseScopesFor, issueAccountSetup, deliverInvite, unusablePasswordHash, listScopes,
} from '../accounts.js';

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'hod'));

const SCOPES_JSON = `(SELECT COALESCE(json_agg(json_build_object('id', s.id, 'role', s.role, 'campus_id', s.campus_id, 'department_id', s.department_id,
    'program_id', s.program_id, 'course_offering_id', s.course_offering_id) ORDER BY s.created_at), '[]'::json)
  FROM user_scopes s WHERE s.user_id = u.id AND s.is_active) AS scopes`;
const USER_COLS = `u.id, u.email, u.full_name, u.employee_id, u.role, u.department_id, u.campus_id, u.is_active, u.must_change_password,
  u.access_deadline, u.created_at, u.deactivated_at, u.totp_enabled, u.totp_reenroll_required, d.name AS department_name, c.name AS campus_name`;

router.get('/', async (req, res) => {
  const rows = req.user.role === 'admin'
    ? await all(`
        SELECT ${USER_COLS}, ${SCOPES_JSON}
        FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN campuses c ON c.id = u.campus_id
        ORDER BY u.created_at DESC`)
    : await all(`
        SELECT ${USER_COLS}, ${SCOPES_JSON}
        FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN campuses c ON c.id = u.campus_id
        WHERE u.role IN ('teacher', 'reviewer') AND ${hodCoversSql('$1', 'u.campus_id', 'u.department_id')}
        ORDER BY u.created_at DESC`, [req.user.id]);
  res.json(rows);
});

async function loadTarget(req, res) {
  const target = isUuid(req.params.id) ? await get('SELECT * FROM users WHERE id = $1', [req.params.id]) : null;
  if (!target) { res.status(404).json({ error: 'Not found' }); return null; }
  const m = await canManage(req.user, target);
  if (!m.allowed) { res.status(403).json({ error: m.error }); return null; }
  return target;
}

const responseFor = (user, scopes, invite) => ({
  id: user.id, email: user.email, full_name: user.full_name, employee_id: user.employee_id, role: user.role,
  department_id: user.department_id, campus_id: user.campus_id, access_deadline: user.access_deadline, created_at: user.created_at,
  scopes, invite_delivered: invite.delivered,
  // Development only (never in production): the setup code, for local testing without a mail server.
  ...(devSecretsExposed() ? { dev_setup_token: invite.token } : {}),
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const role = body.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!PROVISIONABLE_BY[req.user.role].includes(role)) {
    return res.status(403).json({ error: req.user.role === 'hod' ? 'HODs can only create teacher or reviewer accounts' : 'Not allowed' });
  }
  const errors = validateIdentity(body);
  if (errors.length) return res.status(400).json({ error: errors[0], details: errors });
  const email = normalizeEmail(body.email);

  // Placement: the admin chooses campus/department; an HOD places accounts in its own department unless it names
  // another department its hod scope covers (the campus always follows the department).
  let campusId = body.campus_id || null;
  let departmentId = body.department_id || null;
  if (req.user.role === 'hod') {
    const d = await departmentContext(departmentId || req.user.department_id);
    if (!d?.is_active) return res.status(400).json({ error: 'department_id must be an active department' });
    const a = await checkAcademic(req.user, 'manage', d, 'department', d.department_id);
    if (!a.allowed) return res.status(403).json({ error: 'You can only create accounts in a department your HOD scope covers' });
    departmentId = d.department_id; campusId = d.campus_id;
  } else if (!campusId && departmentId) {
    campusId = (await departmentContext(departmentId))?.campus_id || null;
  }
  let deadline = null;
  if (role === 'teacher' && body.access_deadline) {
    deadline = new Date(body.access_deadline);
    if (Number.isNaN(deadline.getTime()) || deadline <= new Date()) return res.status(400).json({ error: 'access_deadline must be a future date' });
  }
  const plan = await resolveScopePlan({ get }, { role, campusId, departmentId, scopes: body.scopes });
  if (plan.error) return res.status(400).json({ error: plan.error });

  const passwordHash = await unusablePasswordHash();
  let out;
  try {
    out = await withTransaction(async (txn) => {
      const user = await txn.get(`
        INSERT INTO users (email, full_name, employee_id, password_hash, role, department_id, institution_id, campus_id, access_deadline, must_change_password, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10)
        RETURNING id, email, full_name, employee_id, role, department_id, campus_id, access_deadline, created_at`,
      [email, body.full_name.trim(), body.employee_id.trim(), passwordHash, role, plan.departmentId, plan.institutionId, plan.campusId,
        deadline ? deadline.toISOString() : null, req.user.id]);
      const scopes = [];
      for (const s of plan.scopes) {
        const id = await grantScope({ userId: user.id, role, campusId: s.campusId, departmentId: s.departmentId, programId: s.programId, grantedBy: req.user.id }, txn);
        scopes.push({ id, role, campus_id: s.campusId, department_id: s.departmentId, program_id: s.programId });
      }
      const token = await issueAccountSetup(txn, user.id);
      await logAudit({ userId: req.user.id, action: 'user_created', entityId: user.id, ip: req.ip,
        details: { email, role, employee_id: user.employee_id, campus_id: plan.campusId, department_id: plan.departmentId, scopes } }, txn);
      return { user, scopes, token };
    });
  } catch (err) {
    if (err.code === '23505') {
      if (/employee/.test(err.constraint || '')) return res.status(409).json({ error: 'That employee ID is already in use' });
      if (/email/.test(err.constraint || '')) return res.status(409).json({ error: 'An account with this email already exists' });
      return res.status(409).json({ error: 'An account with these details already exists' });
    }
    throw err;
  }
  const delivered = await deliverInvite(out.user, out.token, req);
  res.status(201).json(responseFor(out.user, out.scopes, { delivered, token: out.token }));
});

router.post('/:id/resend-invite', async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  if (!target.is_active) return res.status(409).json({ error: 'This account is inactive; reactivate it first' });
  if (!target.must_change_password) return res.status(409).json({ error: 'This account is already set up' });
  const token = await withTransaction(async (txn) => {
    const t = await issueAccountSetup(txn, target.id);
    await logAudit({ userId: req.user.id, action: 'account_invite_reissued', entityId: target.id, ip: req.ip }, txn);
    return t;
  });
  const delivered = await deliverInvite(target, token, req);
  res.json({ invite_delivered: delivered, ...(devSecretsExposed() ? { dev_setup_token: token } : {}) });
});

router.post('/:id/deactivate', async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
  if (target.role === 'admin' && await isLastActiveAdmin({ get }, target.id)) return res.status(409).json({ error: 'The last active admin cannot be deactivated' });
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
  const out = await withTransaction(async (txn) => {
    // Scopes first, so the revocation records who and why (the 040 trigger on users would otherwise revoke them
    // anonymously). An already inactive account holds no active scope, so nothing is revoked in that case.
    const revoked = await revokeAllScopes(txn, target.id, { by: req.user.id, reason: 'account_deactivated' });
    const u = await txn.get(`UPDATE users SET is_active = FALSE, token_version = token_version + 1, deactivated_at = now(), deactivated_by = $2,
                               totp_pending_secret = NULL, totp_pending_expires_at = NULL
                             WHERE id = $1 AND is_active RETURNING id`, [target.id, req.user.id]);
    if (!u) return null;
    await txn.run('UPDATE otp_codes SET used = TRUE WHERE user_id = $1 AND used = FALSE', [target.id]);
    await logAudit({ userId: req.user.id, action: 'user_deactivated', entityId: target.id, ip: req.ip,
      details: { reason, role: target.role, revoked_scopes: revoked } }, txn);
    return { revoked };
  });
  if (!out) return res.status(409).json({ error: 'Already inactive' });
  // A deactivated validator can no longer decide (re-checked at decision time); tell the COEs to replace them.
  if (target.role === 'validator') await notifyValidatorsNeedingReplacement(target.id, 'was deactivated');
  res.json({ ok: true, revoked_scopes: out.revoked.length });
});

router.post('/:id/reactivate', async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  const out = await withTransaction(async (txn) => {
    const u = await txn.get(`UPDATE users SET is_active = TRUE, failed_login_attempts = 0, locked_until = NULL, deactivated_at = NULL, deactivated_by = NULL
                             WHERE id = $1 AND NOT is_active RETURNING *`, [target.id]);
    if (!u) return null;
    const restored = [];
    for (const s of await baseScopesFor(txn, u)) {
      const id = await grantScope({ userId: u.id, role: u.role, ...s, grantedBy: req.user.id }, txn);
      restored.push({ id, ...s });
    }
    await logAudit({ userId: req.user.id, action: 'user_reactivated', entityId: u.id, ip: req.ip, details: { restored_scopes: restored } }, txn);
    return { u, restored };
  });
  if (!out) return res.status(409).json({ error: 'Already active' });
  res.json({ ok: true, restored_scopes: out.restored.length, needs_scope_grant: ['coe', 'validator'].includes(out.u.role) });
});

// Authenticator reset: admin only, with a reason, for a person who lost their authenticator app. The only way an
// ENABLED authenticator is replaced without a current code from it (totp.js): the secret is cleared, every session
// ends (whoever re-enrols must sign in again with password and emailed code), totp_reenroll_required lets the
// owner enrol a new one with the password, and the owner is told in the app and by email. Audited.
router.post('/:id/reset-authenticator', requireRole('admin'), async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 10) return res.status(400).json({ error: 'A reason of at least 10 characters is required' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot reset your own authenticator; another administrator must do it' });
  if (!target.is_active) return res.status(409).json({ error: 'The account is inactive' });
  if (!target.totp_enabled && !target.totp_secret && !target.totp_pending_secret) return res.status(409).json({ error: 'This account has no authenticator to reset' });
  const done = await withTransaction(async (txn) => {
    const u = await txn.get(`UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_pending_secret = NULL, totp_pending_expires_at = NULL,
                               totp_last_used_step = NULL, totp_reenroll_required = TRUE, token_version = token_version + 1
                             WHERE id = $1 AND is_active RETURNING id`, [target.id]);
    if (!u) return false;
    await logAudit({ userId: req.user.id, action: 'totp_reset_by_admin', entityId: target.id, ip: req.ip, details: { reason, role: target.role } }, txn);
    return true;
  });
  if (!done) return res.status(409).json({ error: 'The account changed meanwhile; reload and try again' });
  await notify(target.id, 'security_totp_reset', 'The administrator reset your authenticator app. Set it up again (Authenticator tab) before your next approval. If you did not ask for this, contact the administrator immediately.');
  const noticeSent = await deliverNotice(target.email, 'totp_reset');
  res.json({ ok: true, notice_sent: noticeSent });
});

// Role change: admin only, with a reason. Old scopes and role assignments end; the new role's scopes are granted.
router.post('/:id/role', requireRole('admin'), async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  const { role, campus_id: campusId, department_id: departmentId, scopes, reason } = req.body || {};
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (role === target.role) return res.status(400).json({ error: 'The account already has that role' });
  if (typeof reason !== 'string' || reason.trim().length < 10) return res.status(400).json({ error: 'A reason of at least 10 characters is required' });
  if (target.role === 'admin' && await isLastActiveAdmin({ get }, target.id)) return res.status(409).json({ error: 'The last active admin cannot be demoted' });
  const plan = await resolveScopePlan({ get }, { role, campusId: campusId || target.campus_id, departmentId: departmentId || null, scopes });
  if (plan.error) return res.status(400).json({ error: plan.error });
  const out = await withTransaction(async (txn) => {
    const revoked = await revokeAllScopes(txn, target.id, { by: req.user.id, reason: 'role_changed' });
    if (target.role === 'reviewer') await txn.run('UPDATE reviewer_assignments SET is_active = FALSE WHERE reviewer_id = $1 AND is_active', [target.id]);
    if (target.role === 'teacher') await txn.run('UPDATE teacher_course_assignments SET is_active = FALSE, updated_at = now() WHERE teacher_id = $1 AND is_active', [target.id]);
    const u = await txn.get(`UPDATE users SET role = $2, department_id = $3, campus_id = $4, institution_id = $5,
                               access_deadline = CASE WHEN $2 = 'teacher' THEN access_deadline ELSE NULL END, token_version = token_version + 1
                             WHERE id = $1 AND role = $6 RETURNING id, role`,
    [target.id, role, plan.departmentId, plan.campusId, plan.institutionId, target.role]);
    if (!u) return null;
    const granted = [];
    for (const s of plan.scopes) {
      const id = await grantScope({ userId: target.id, role, campusId: s.campusId, departmentId: s.departmentId, programId: s.programId, grantedBy: req.user.id }, txn);
      granted.push({ id, campus_id: s.campusId, department_id: s.departmentId, program_id: s.programId });
    }
    await logAudit({ userId: req.user.id, action: 'user_role_changed', entityId: target.id, ip: req.ip,
      details: { old_role: target.role, new_role: role, reason: reason.trim(), revoked_scopes: revoked, granted_scopes: granted } }, txn);
    return { granted, revoked };
  });
  if (!out) return res.status(409).json({ error: 'The account changed meanwhile; reload and try again' });
  await notify(target.id, 'account_role_changed', `Your account role was changed from ${target.role} to ${role}. Sign in again to continue.`);
  if (target.role === 'validator') await notifyValidatorsNeedingReplacement(target.id, 'changed role');
  res.json({ ok: true, role, scopes: await listScopes(target.id), revoked_scopes: out.revoked.length });
});

export default router;
