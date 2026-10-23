import express from 'express';
import { get, all, run } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit, verifyChain } from '../audit.js';

const router = express.Router();

// ---- Legacy HOD + Admin paper approval: RETIRED ----------------------
// PIVOT_SPEC_V2 §1, §2, §29 and invariant 8: final paper approval belongs to the
// COE (TOTP step-up) after 4 validators, and Admin is never part of academic
// approval. These endpoints used to approve and lock papers through the old
// `status` column, bypassing the new workflow, so they now return 410.
// The old implementation is in git history.
const retiredApproval = (req, res) => res.status(410).json({
  error: 'Legacy HOD/Admin paper approval is retired. Papers are validated by 4 validators and approved by the COE via /api/coe.',
});
router.post('/papers/:id/hod-approve', requireAuth, retiredApproval);
router.post('/papers/:id/admin-approve', requireAuth, retiredApproval);
router.post('/papers/:id/lock', requireAuth, retiredApproval);

router.get('/step-up-log', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await all(`SELECT l.id, l.action, l.entity_id, l.success, l.failure_reason, l.method, l.ip_address, l.created_at, u.email
    FROM step_up_auth_log l LEFT JOIN users u ON u.id = COALESCE(l.user_id, l.hod_id, l.admin_id)
    ORDER BY l.created_at DESC LIMIT 200`));
});

router.get('/audit-log', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200'));
});

router.get('/audit-log/verify', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await verifyChain());
});

// ---- Security operations center: blocklist, suspicious activity, lockdown ----
router.get('/security/blocked-ips', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await all('SELECT * FROM blocked_ips WHERE expires_at IS NULL OR expires_at > now() ORDER BY blocked_at DESC'));
});

router.get('/security/suspicious-activity', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await all('SELECT * FROM suspicious_activity ORDER BY created_at DESC LIMIT 200'));
});

router.get('/security/status', requireAuth, requireRole('admin'), async (req, res) => {
  const row = await get("SELECT value, updated_at FROM system_state WHERE key = 'lockdown_mode'");
  res.json({ lockdown_active: !!row && row.value === '1', since: row ? row.updated_at : null });
});

router.post('/security/blocked-ips/:ip/unblock', requireAuth, requireRole('admin'), async (req, res) => {
  await run('DELETE FROM blocked_ips WHERE ip = $1', [req.params.ip]);
  await logAudit({ userId: req.user.id, action: 'ip_manually_unblocked', entityId: req.params.ip, ip: req.ip });
  res.json({ ok: true });
});

router.post('/security/lockdown/clear', requireAuth, requireRole('admin'), async (req, res) => {
  await run("UPDATE system_state SET value = '0', updated_at = now() WHERE key = 'lockdown_mode'");
  await logAudit({ userId: req.user.id, action: 'lockdown_manually_cleared', entityId: null, ip: req.ip });
  res.json({ ok: true });
});

export default router;
