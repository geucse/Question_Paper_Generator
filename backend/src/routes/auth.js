import express from 'express';
import { get, run, withTransaction } from '../db.js';
import {
  verifyPassword, hashPassword, hashCode, generateOtp, safeEqualHex, issueSession, sessionLifetimeSeconds,
  dummyPasswordHash, validatePasswordStrength, generateResetToken,
} from '../auth.js';
import { checkAccountPassword, endSessionsAfterLock, LOCKED_SESSION_BODY, MAX_PASSWORD_ATTEMPTS, LOCK_MINUTES } from '../password-attempts.js';
import { logAudit } from '../audit.js';
import { requireAuth, requireRole } from '../middleware.js';
import { flagSuspicious } from '../security.js';
import { deliverCode, deliverNotice, OtpDeliveryError } from '../otp-delivery.js';
import { startEnrolment, confirmEnrolment } from '../totp.js';
import { normalizeEmail } from '../accounts.js';
import { notify } from '../notifications.js';
import { isUuid } from '../scopes.js';
import { describeError } from '../errors.js';

const router = express.Router();
const OTP_TTL_MIN = 5;
const RESET_TOKEN_TTL_MIN = 30;
const MAX_OTP_ATTEMPTS = 3;
const MAX_RESET_ATTEMPTS = 5;
const MAX_LOGIN_CODES_PER_15_MIN = 5;
const MAX_RESETS_PER_HOUR = 3;

// The same answer for an unknown email, a wrong password and a locked account: nothing about the account is
// revealed before the password is verified (a lockout that answered differently would itself be a password oracle).
const GENERIC = { error: `Invalid email or password. After ${MAX_PASSWORD_ATTEMPTS} failed attempts sign-in is paused for ${LOCK_MINUTES} minutes.` };
const INVALID_CODE = { error: 'Invalid or expired code. Sign in again to get a new one.' };

export function publicUser(u) {
  return {
    id: u.id, email: u.email, role: u.role, department_id: u.department_id, campus_id: u.campus_id,
    full_name: u.full_name ?? null, employee_id: u.employee_id ?? null, access_deadline: u.access_deadline ?? null,
    totp_enabled: !!u.totp_enabled, totp_reenroll_required: !!u.totp_reenroll_required, must_change_password: !!u.must_change_password,
  };
}

async function verifyPasswordForTiming(password) {
  await verifyPassword(await dummyPasswordHash(), typeof password === 'string' ? password : ''); // same cost as a real check
}

async function burnCode(id) {
  await run('UPDATE otp_codes SET used = TRUE WHERE id = $1', [id]);
}

// ---- Step 1: email + password ----
router.post('/login/password', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = email ? await get('SELECT * FROM users WHERE lower(email) = $1', [email]) : null;
  if (!user) {
    await verifyPasswordForTiming(password);
    await flagSuspicious(req, 'failed_login', { reason: 'unknown_account' });
    return res.status(401).json(GENERIC);
  }
  // password-attempts.js: the attempt is reserved (and the lock decided) atomically BEFORE the password is checked,
  // so concurrent guesses from many addresses cannot exceed the per-account budget.
  const pw = await checkAccountPassword(user, password);
  if (pw.locked) {
    await logAudit({ userId: user.id, action: 'login_refused_locked', entityId: user.id, details: pw.correct ? { concurrent_lock: true } : undefined, ip: req.ip });
    await flagSuspicious(req, 'failed_login', { user_id: user.id });
    return res.status(401).json(GENERIC);
  }
  if (!pw.ok) {
    if (pw.lockedNow) await logAudit({ userId: user.id, action: 'account_locked', entityId: user.id, details: { minutes: LOCK_MINUTES }, ip: req.ip });
    await logAudit({ userId: user.id, action: 'login_failed_password', entityId: user.id, ip: req.ip });
    await flagSuspicious(req, 'failed_login', { user_id: user.id });
    return res.status(401).json(GENERIC);
  }
  // The password is right: only now may the account's state be revealed.
  if (!user.is_active) {
    await logAudit({ userId: user.id, action: 'login_refused_inactive', entityId: user.id, ip: req.ip });
    return res.status(403).json({ error: 'This account is inactive. Contact your administrator.' });
  }
  if (sessionLifetimeSeconds(user) === 0) {
    await logAudit({ userId: user.id, action: 'login_refused_deadline', entityId: user.id, ip: req.ip });
    return res.status(403).json({ error: 'Access deadline has passed for this account' });
  }

  const recent = await get(`SELECT COUNT(*)::int AS n FROM otp_codes WHERE user_id = $1 AND purpose = 'login' AND created_at > now() - interval '15 minutes'`, [user.id]);
  if ((recent?.n ?? 0) >= MAX_LOGIN_CODES_PER_15_MIN) {
    await logAudit({ userId: user.id, action: 'login_otp_throttled', entityId: user.id, ip: req.ip });
    return res.status(429).json({ error: 'Too many sign-in codes were requested for this account. Wait 15 minutes and try again.' });
  }
  const otp = generateOtp();
  const codeId = await withTransaction(async (txn) => {
    // A new login code replaces any earlier unused one.
    await txn.run("UPDATE otp_codes SET used = TRUE WHERE user_id = $1 AND purpose = 'login' AND used = FALSE", [user.id]);
    const row = await txn.get(`INSERT INTO otp_codes (user_id, code_hash, purpose, expires_at)
                               VALUES ($1, $2, 'login', now() + make_interval(mins => $3)) RETURNING id`, [user.id, hashCode(otp), OTP_TTL_MIN]);
    return row.id;
  });
  try {
    await deliverCode(user.email, otp, 'login');
  } catch (e) {
    if (!(e instanceof OtpDeliveryError)) throw e;
    await burnCode(codeId);
    await logAudit({ userId: user.id, action: 'otp_delivery_failed', entityId: user.id, details: { purpose: 'login', kind: e.kind }, ip: req.ip });
    return res.status(503).json({ error: 'We could not send your sign-in code right now. Try again in a few minutes.' });
  }
  await logAudit({ userId: user.id, action: 'login_password_ok_otp_sent', entityId: user.id, ip: req.ip });
  // The code itself never appears in a response; it reaches the user only through deliverCode.
  return res.json({ message: 'A sign-in code has been sent to your registered email.', otp_pending_for: user.id });
});

// ---- Step 2: OTP verification -> issues JWT ----
router.post('/login/otp', async (req, res) => {
  const { userId, code } = req.body || {};
  if (!isUuid(userId) || typeof code !== 'string' || !/^\d{6}$/.test(code)) return res.status(401).json(INVALID_CODE);
  const user = await get('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user || !user.is_active) return res.status(401).json(INVALID_CODE);
  // Count the attempt first, atomically: concurrent guesses cannot exceed the limit.
  const rec = await get(`
    UPDATE otp_codes SET attempts = attempts + 1
    WHERE id = (SELECT id FROM otp_codes WHERE user_id = $1 AND purpose = 'login' AND used = FALSE ORDER BY created_at DESC LIMIT 1)
      AND attempts < $2 AND expires_at > now()
    RETURNING id, code_hash, attempts`, [userId, MAX_OTP_ATTEMPTS]);
  if (!rec) return res.status(401).json(INVALID_CODE);
  if (!safeEqualHex(hashCode(code), rec.code_hash)) {
    await logAudit({ userId: user.id, action: 'otp_failed', entityId: user.id, details: { attempts: rec.attempts }, ip: req.ip });
    await flagSuspicious(req, 'invalid_otp', { user_id: user.id });
    const left = MAX_OTP_ATTEMPTS - rec.attempts;
    return res.status(401).json({ error: left > 0 ? `Incorrect code; ${left} attempt(s) left` : INVALID_CODE.error });
  }
  const used = await run('UPDATE otp_codes SET used = TRUE WHERE id = $1 AND used = FALSE RETURNING id', [rec.id]);
  if (!used.rowCount) return res.status(401).json(INVALID_CODE); // consumed by a concurrent request
  // Session length: at most 8 hours and never past access_deadline.
  const token = issueSession(user);
  if (!token) return res.status(403).json({ error: 'Access deadline has passed for this account' });
  await logAudit({ userId: user.id, action: 'login_success', entityId: user.id, ip: req.ip });
  return res.json({ token, user: publicUser(user) });
});

// ---- TOTP (authenticator app): enrolment needs re-authentication; see totp.js ----
router.post('/totp/setup', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = await startEnrolment(req.user, req.body || {}, req.ip);
  res.status(r.status).json(r.body);
});

router.post('/totp/confirm', requireAuth, async (req, res) => {
  const r = await confirmEnrolment(req.user, req.body?.code, req.ip);
  res.status(r.status).json(r.body);
});

router.get('/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

// Real logout: since JWTs aren't stored server-side, "logging out" only
// means something if it actually invalidates the token — bumping
// token_version does exactly that. Every other tab/device holding an
// older token is logged out too; that's intended (a "this device only"
// logout would need a per-session store, which isn't part of this build).
router.post('/logout', requireAuth, async (req, res) => {
  await run('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
  await logAudit({ userId: req.user.id, action: 'logout', entityId: req.user.id, ip: req.ip });
  res.json({ ok: true });
});

// Admin-only incident response: kill every existing session for a specific
// user immediately (compromised account, offboarding, etc.) without
// waiting for their tokens to expire naturally.
router.post('/users/:id/force-logout', requireAuth, requireRole('admin'), async (req, res) => {
  const target = isUuid(req.params.id) ? await get('SELECT id FROM users WHERE id = $1', [req.params.id]) : null;
  if (!target) return res.status(404).json({ error: 'User not found' });
  await run('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.params.id]);
  await logAudit({ userId: req.user.id, action: 'force_logout', entityId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

// ---- Forgot password: request a reset code ----
// The same response whether or not the account exists, is inactive or is throttled, and it is sent BEFORE any
// lookup: the account-dependent work (lookup, throttle, code insert, audit, mail delivery) runs after the response,
// so neither the body nor the response time reveals whether an official email has an account.
router.post('/password-reset/request', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  res.json({ message: 'If an account with that email exists, a password reset code has been sent to it.' });
  if (!email) return;
  try {
    await issuePasswordReset(email, req.ip);
  } catch (e) {
    console.error('[auth] password reset request failed', JSON.stringify(describeError(e)));
  }
});

async function issuePasswordReset(email, ip) {
  const user = await get('SELECT * FROM users WHERE lower(email) = $1', [email]);
  if (!user || !user.is_active) return;
  const recent = await get(`SELECT COUNT(*)::int AS n FROM otp_codes WHERE user_id = $1 AND purpose = 'password_reset' AND created_at > now() - interval '1 hour'`, [user.id]);
  if ((recent?.n ?? 0) >= MAX_RESETS_PER_HOUR) {
    await logAudit({ userId: user.id, action: 'password_reset_throttled', entityId: user.id, ip });
    return;
  }
  const token = generateResetToken();
  const codeId = await withTransaction(async (txn) => {
    await txn.run("UPDATE otp_codes SET used = TRUE WHERE user_id = $1 AND purpose = 'password_reset' AND used = FALSE", [user.id]);
    const row = await txn.get(`INSERT INTO otp_codes (user_id, code_hash, purpose, expires_at)
                               VALUES ($1, $2, 'password_reset', now() + make_interval(mins => $3)) RETURNING id`, [user.id, hashCode(token), RESET_TOKEN_TTL_MIN]);
    await logAudit({ userId: user.id, action: 'password_reset_requested', entityId: user.id, ip }, txn);
    return row.id;
  });
  try {
    await deliverCode(user.email, token, 'password_reset');
  } catch (e) {
    await burnCode(codeId);
    await logAudit({ userId: user.id, action: 'otp_delivery_failed', entityId: user.id, details: { purpose: 'password_reset', kind: e?.kind ?? 'error' }, ip });
  }
}

// Redeem a password-reset code or an account-setup code (invitation). The code is looked up by its hash.
router.post('/password-reset/confirm', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim().toLowerCase() : '';
  const newPassword = req.body?.new_password;
  const invalid = async () => {
    await flagSuspicious(req, 'invalid_reset_token', {});
    return res.status(400).json({ error: 'Invalid or expired code' });
  };
  if (!/^[0-9a-f]{64}$/.test(token)) return invalid();
  const record = await get(`
    SELECT * FROM otp_codes WHERE purpose IN ('password_reset', 'account_setup') AND used = FALSE AND code_hash = $1
    ORDER BY created_at DESC LIMIT 1`, [hashCode(token)]);
  const user = record ? await get('SELECT * FROM users WHERE id = $1', [record.user_id]) : null;
  if (!record || !user || !user.is_active) return invalid();
  if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'This code has expired; request a new one' });
  if (record.attempts >= MAX_RESET_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts with this code; request a new one' });

  const strengthErrors = validatePasswordStrength(typeof newPassword === 'string' ? newPassword : '', user.email);
  if (strengthErrors.length > 0) {
    await run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [record.id]);
    return res.status(400).json({ error: 'Password does not meet requirements', details: strengthErrors });
  }
  const setup = record.purpose === 'account_setup';
  const newHash = await hashPassword(newPassword);
  // Proving control of the email clears a lockout and the forced change; every other session ends (token_version).
  const done = await withTransaction(async (txn) => {
    const used = await txn.get('UPDATE otp_codes SET used = TRUE WHERE id = $1 AND used = FALSE RETURNING id', [record.id]);
    if (!used) return false;
    await txn.run(`UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL,
                     must_change_password = FALSE, token_version = token_version + 1 WHERE id = $2`, [newHash, user.id]);
    await txn.run("UPDATE otp_codes SET used = TRUE WHERE user_id = $1 AND purpose IN ('password_reset', 'account_setup') AND used = FALSE", [user.id]);
    await logAudit({ userId: user.id, action: setup ? 'account_setup_completed' : 'password_reset_completed', entityId: user.id, ip: req.ip }, txn);
    return true;
  });
  if (!done) return res.status(400).json({ error: 'Invalid or expired code' });
  if (!setup) {
    await notify(user.id, 'security_password_changed', 'Your password was reset. If this was not you, contact the administrator immediately.');
    await deliverNotice(user.email, 'password_changed');
  }
  res.json({ ok: true });
});

// ---- Authenticated: change your own password ----
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const user = await get('SELECT * FROM users WHERE id = $1', [req.user.id]);

  // The same per-account budget as sign-in (password-attempts.js): a stolen token is not a password oracle.
  const pw = await checkAccountPassword(user, current_password);
  if (!pw.ok) {
    await logAudit({ userId: user.id, action: 'change_password_failed', entityId: user.id, details: pw.locked ? { locked: true } : undefined, ip: req.ip });
    await flagSuspicious(req, 'failed_login', { user_id: user.id, action: 'change_password' });
    if (pw.lockedNow) {
      await endSessionsAfterLock(user, { ip: req.ip, context: 'change password' });
      return res.status(401).json(LOCKED_SESSION_BODY);
    }
    if (pw.locked) return res.status(429).json({ error: `Too many incorrect passwords: the account is locked; try again in ${LOCK_MINUTES} minutes.` });
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const strengthErrors = validatePasswordStrength(typeof new_password === 'string' ? new_password : '', user.email);
  if (strengthErrors.length > 0) {
    return res.status(400).json({ error: 'Password does not meet requirements', details: strengthErrors });
  }
  const newHash = await hashPassword(new_password);
  const newTokenVersion = user.token_version + 1;
  // token_version bumps: a stolen token stops working the moment the password changes. A fresh token (new
  // token_version, still capped by access_deadline) is returned so this session continues.
  await run('UPDATE users SET password_hash = $1, must_change_password = FALSE, token_version = $2 WHERE id = $3', [newHash, newTokenVersion, user.id]);
  await logAudit({ userId: user.id, action: 'password_changed', entityId: user.id, ip: req.ip });
  await notify(user.id, 'security_password_changed', 'Your password was changed. If this was not you, contact the administrator immediately.');
  await deliverNotice(user.email, 'password_changed');
  const newToken = issueSession({ ...user, token_version: newTokenVersion });
  if (!newToken) return res.status(403).json({ error: 'Access deadline has passed for this account' });
  res.json({ ok: true, token: newToken });
});

export default router;
