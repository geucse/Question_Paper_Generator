// TOTP step-up (authenticator app): enrolment and verification, shared by the auth routes and COE approval.
//   - Secrets are sealed at rest (secret-box.js, AAD 'totp:<user id>'); a changed server key is detected
//     (totp-key-check.js) and refused, never treated as "set it up again".
//   - A code is accepted once: the step it belongs to is recorded with a conditional UPDATE, so a replayed code
//     (or the same code sent twice concurrently) is refused.
//   - Every attempt is written to step_up_auth_log; 5 failures since the last success within 15 minutes lock
//     step-up for that user (database-backed, so it holds across replicas), on top of the per-IP auth limiter.
//     The lockout check, the verification and the log row run in one transaction under a per-user advisory lock,
//     so concurrent requests cannot all pass the check before any failure is recorded.
//   - Replacing an ENABLED authenticator needs a current code from it: the password alone (which a phished login
//     or a stolen session plus a guessed password provides) never removes the second factor. Password
//     re-authentication enrols only when there is no working authenticator: first set-up, or
//     totp_reenroll_required (after the 040 upgrade, a key rotation, an undecryptable secret, or an audited
//     administrator reset). The active secret keeps working until the new one is confirmed.
import { get, run, withTransaction } from './db.js';
import { totpDelta, currentTotpStep, generateTotpSecret, totpKeyUri } from './auth.js';
import { sealSecret, openSecret, SecretBoxError } from './secret-box.js';
import { logAudit } from './audit.js';
import { notify } from './notifications.js';
import { flagSuspicious } from './security.js';
import { deliverNotice } from './otp-delivery.js';
import { checkAccountPassword, endSessionsAfterLock, LOCKED_SESSION_BODY, LOCK_MINUTES } from './password-attempts.js';
import { ensureTotpKeyChecked } from './totp-key-check.js';

const KEY_UNAVAILABLE = { ok: false, status: 503, error: 'Authenticator verification is unavailable: the server key does not match the stored key check. Contact the administrator.' };

const LOCK_FAILURES = 5;
const aad = (userId) => `totp:${userId}`;

async function logStepUp(db, { userId, action, entityId = null, success, reason = null, ip }) {
  await db.run(`INSERT INTO step_up_auth_log (user_id, action, entity_id, success, failure_reason, ip_address, method)
                VALUES ($1, $2, $3, $4, $5, $6, 'totp')`, [userId, action, entityId, success, reason, ip ?? null]);
}

async function lockedOut(db, userId) {
  const row = await db.get(`
    SELECT COUNT(*)::int AS n FROM step_up_auth_log
    WHERE user_id = $1 AND NOT success
      AND created_at > GREATEST(now() - interval '15 minutes',
            COALESCE((SELECT MAX(created_at) FROM step_up_auth_log WHERE user_id = $1 AND success), '-infinity'::timestamptz))`, [userId]);
  return (row?.n ?? 0) >= LOCK_FAILURES;
}

// Consume the step of a valid code. False when that step (or a later one) was already used.
async function consumeStep(db, userId, step) {
  const r = await db.run(`UPDATE users SET totp_last_used_step = $2 WHERE id = $1 AND (totp_last_used_step IS NULL OR totp_last_used_step < $2) RETURNING id`, [userId, step]);
  return r.rowCount > 0;
}

// Serialises step-up attempts of one user (transaction-scoped; released at COMMIT/ROLLBACK).
const lockUser = (txn, userId) => txn.run("SELECT pg_advisory_xact_lock(hashtextextended('totp-step-up:' || $1::text, 0))", [userId]);

// Returns { ok: true } or { ok: false, status, error, needs_totp_setup? }. Runs in its own transaction.
export async function verifyStepUp(_db, user, code, { action, entityId = null, ip = null }) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { ok: false, status: 400, error: 'Enter the 6-digit code from your authenticator app' };
  if ((await ensureTotpKeyChecked()) === 'mismatch') return KEY_UNAVAILABLE;
  const out = await withTransaction(async (txn) => {
    await lockUser(txn, user.id);
    if (await lockedOut(txn, user.id)) return { ok: false, status: 429, error: 'Too many incorrect authenticator codes; wait 15 minutes' };
    const row = await txn.get('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [user.id]);
    if (!row?.totp_enabled || !row.totp_secret) {
      return { ok: false, status: 400, error: 'TOTP must be enabled for this action. Set up your authenticator first.', needs_totp_setup: true };
    }
    let secret;
    try {
      secret = openSecret(row.totp_secret, aad(user.id));
    } catch (e) {
      if (!(e instanceof SecretBoxError)) throw e;
      // The key itself is right (checked above), so this one stored secret is damaged: the user may enrol again
      // with the password (totp_reenroll_required), and the event is audited.
      await txn.run('UPDATE users SET totp_reenroll_required = TRUE WHERE id = $1', [user.id]);
      await logAudit({ userId: user.id, action: 'totp_secret_unreadable', entityId: user.id, details: { action }, ip }, txn);
      return { ok: false, status: 409, error: 'Your authenticator must be set up again', needs_totp_setup: true, unreadable: true };
    }
    const delta = totpDelta(secret, code);
    let reason = null;
    if (delta === null) reason = 'invalid_code';
    else if (!(await consumeStep(txn, user.id, currentTotpStep() + delta))) reason = 'replayed';
    await logStepUp(txn, { userId: user.id, action, entityId, success: !reason, reason, ip });
    if (!reason) return { ok: true };
    return reason === 'replayed'
      ? { ok: false, status: 401, error: 'This authenticator code was already used; wait for the next code', failed: true }
      : { ok: false, status: 401, error: 'Invalid authenticator code', failed: true };
  });
  if (out.unreadable) console.error('[totp] the stored authenticator secret of user', user.id, 'cannot be decrypted; re-enrolment required');
  if (out.failed) await flagSuspicious({ ip }, 'invalid_totp', { action });
  delete out.failed; delete out.unreadable;
  return out;
}

// POST /auth/totp/setup. Re-authentication first; the new secret is only pending (10 minutes) until confirmed.
//   enabled authenticator (and not flagged for re-enrolment): a current code from it is required
//   otherwise: the current password, counted against the account's password budget (password-attempts.js)
export async function startEnrolment(user, { current_password: password, current_totp: totp } = {}, ip) {
  if ((await ensureTotpKeyChecked()) === 'mismatch') return { status: 503, body: { error: KEY_UNAVAILABLE.error } };
  const enabled = !!user.totp_enabled;
  const replacing = enabled && !user.totp_reenroll_required;
  let reauth = null;
  if (replacing) {
    if (typeof totp !== 'string' || !totp) {
      await logAudit({ userId: user.id, action: 'totp_setup_reauth_failed', entityId: user.id, details: { reenroll: true, reason: 'current_code_missing' }, ip });
      return { status: 401, body: { error: 'Enter a current code from your authenticator app to replace it. If you no longer have it, ask the administrator to reset your authenticator.', needs_current_totp: true } };
    }
    const r = await verifyStepUp(null, user, totp, { action: 'totp_reenroll_reauth', ip });
    if (!r.ok) {
      await logAudit({ userId: user.id, action: 'totp_setup_reauth_failed', entityId: user.id, details: { reenroll: true, reason: 'current_code_invalid' }, ip });
      return { status: r.status, body: { error: r.error, needs_current_totp: true, ...(r.needs_totp_setup ? { needs_totp_setup: true } : {}) } };
    }
    reauth = 'totp';
  } else {
    if (typeof password !== 'string' || !password) {
      return { status: 401, body: { error: 'Confirm your identity: enter your current password' } };
    }
    const pw = await checkAccountPassword(user, password);
    if (!pw.ok) {
      await flagSuspicious({ ip }, 'failed_login', { action: 'totp_setup' });
      await logAudit({ userId: user.id, action: 'totp_setup_reauth_failed', entityId: user.id, details: { reenroll: enabled, reason: pw.locked ? 'locked' : 'wrong_password' }, ip });
      if (pw.lockedNow) {
        await endSessionsAfterLock(user, { ip, context: 'authenticator setup' });
        return { status: 401, body: LOCKED_SESSION_BODY };
      }
      if (pw.locked) return { status: 429, body: { error: `Too many incorrect passwords: the account is locked; try again in ${LOCK_MINUTES} minutes.` } };
      return { status: 401, body: { error: 'Confirm your identity: the current password is incorrect' } };
    }
    reauth = 'password';
  }
  const secret = generateTotpSecret();
  await run(`UPDATE users SET totp_pending_secret = $2, totp_pending_expires_at = now() + interval '10 minutes' WHERE id = $1`,
    [user.id, sealSecret(secret, aad(user.id))]);
  await logAudit({ userId: user.id, action: 'totp_setup_initiated', entityId: user.id, details: { reenroll: enabled, reauth }, ip });
  return { status: 200, body: { secret, otpauth_url: totpKeyUri(secret, user.email), expires_in_seconds: 600 } };
}

// POST /auth/totp/confirm: the pending secret becomes the active one only after a valid code from it.
export async function confirmEnrolment(user, code, ip) {
  const row = await get('SELECT totp_pending_secret, totp_enabled, (totp_pending_expires_at > now()) AS pending_valid FROM users WHERE id = $1', [user.id]);
  if (!row?.totp_pending_secret || !row.pending_valid) return { status: 400, body: { error: 'Start authenticator setup again (the setup expired or was not started)' } };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { status: 400, body: { error: 'Enter the 6-digit code from your authenticator app' } };
  let secret;
  try { secret = openSecret(row.totp_pending_secret, aad(user.id)); } catch (e) {
    if (!(e instanceof SecretBoxError)) throw e;
    return { status: 400, body: { error: 'Start authenticator setup again' } };
  }
  const delta = totpDelta(secret, code);
  const wasEnabled = !!row.totp_enabled;
  // The lockout check, the failure record and the switch run under the same per-user lock as step-up.
  const done = await withTransaction(async (txn) => {
    await lockUser(txn, user.id);
    if (await lockedOut(txn, user.id)) return 'locked';
    if (delta === null) {
      await logStepUp(txn, { userId: user.id, action: 'totp_enrol_confirm', success: false, reason: 'invalid_code', ip });
      return 'invalid';
    }
    const u = await txn.get(`UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_pending_expires_at = NULL,
                               totp_enabled = TRUE, totp_reenroll_required = FALSE, totp_enrolled_at = now(), totp_last_used_step = $2
                             WHERE id = $1 AND totp_pending_secret IS NOT NULL RETURNING id`, [user.id, currentTotpStep() + delta]);
    if (!u) return false;
    await logStepUp(txn, { userId: user.id, action: 'totp_enrol_confirm', success: true, ip });
    await logAudit({ userId: user.id, action: wasEnabled ? 'totp_reenrolled' : 'totp_enabled', entityId: user.id, ip }, txn);
    return true;
  });
  if (done === 'locked') return { status: 429, body: { error: 'Too many incorrect authenticator codes; wait 15 minutes' } };
  if (done === 'invalid') {
    await flagSuspicious({ ip }, 'invalid_totp', { action: 'totp_enrol_confirm' });
    return { status: 401, body: { error: 'Invalid authenticator code' } };
  }
  if (!done) return { status: 400, body: { error: 'Start authenticator setup again' } };
  await notify(user.id, 'security_totp_changed', 'Your authenticator app was changed. If this was not you, contact the administrator immediately.');
  const noticed = await deliverNotice(user.email, 'totp_changed');
  return { status: 200, body: { ok: true, notice_sent: noticed } };
}
