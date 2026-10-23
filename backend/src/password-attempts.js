// Per-account password attempts: one budget of MAX_PASSWORD_ATTEMPTS per LOCK_MINUTES, shared by every place that
// checks an account's password (sign-in, change-password, authenticator enrolment). The per-IP limiter alone does
// not stop an attacker spread over many addresses, and a stolen session must not become an unlimited password
// oracle.
//
// The attempt is RESERVED atomically before the password is verified: one conditional UPDATE counts it and, when it
// is the last one of the budget, sets the lock at once. Concurrent requests therefore cannot evaluate more than
// MAX_PASSWORD_ATTEMPTS passwords per window (each must win a reservation first), and a correct password only
// clears a lock that its own reservation set.
import { get, run } from './db.js';
import { verifyPassword, dummyPasswordHash } from './auth.js';
import { logAudit } from './audit.js';
import { notify } from './notifications.js';
import { deliverNotice } from './otp-delivery.js';

export const MAX_PASSWORD_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

// An expired lock starts a fresh budget; reaching the budget locks in the same statement.
const RESERVE_SQL = `
  UPDATE users SET
    failed_login_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_login_attempts + 1 END,
    locked_until = CASE
      WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_login_attempts + 1 END) >= $2
        THEN now() + make_interval(mins => $3)
      WHEN locked_until IS NOT NULL AND locked_until <= now() THEN NULL
      ELSE locked_until END
  WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now())
  RETURNING failed_login_attempts AS attempt, (locked_until IS NOT NULL) AS locks`;

// Returns one of
//   { ok: true }                                   the password is right (the budget is reset)
//   { ok: false, locked: true, correct }           the account is locked; nothing was evaluated against it
//                                                  (correct: true only when a concurrent attempt locked it
//                                                  after this one reserved: the password was right but refused)
//   { ok: false, locked: false, lockedNow }        wrong password; lockedNow when this attempt used up the budget
export async function checkAccountPassword(user, password) {
  const pw = typeof password === 'string' ? password : '';
  const r = await get(RESERVE_SQL, [user.id, MAX_PASSWORD_ATTEMPTS, LOCK_MINUTES]);
  if (!r) {
    await verifyPassword(await dummyPasswordHash(), pw); // same cost as a real check
    return { ok: false, locked: true, correct: false };
  }
  if (!(await verifyPassword(user.password_hash, pw))) return { ok: false, locked: false, lockedNow: !!r.locks };
  // Right password: reset the budget, unless a later reservation (a concurrent wrong guess) locked the account;
  // a lock set by this attempt's own reservation (the count is still ours) is cleared.
  const cleared = await get(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL
                             WHERE id = $1 AND (locked_until IS NULL OR failed_login_attempts = $2) RETURNING id`, [user.id, r.attempt]);
  return cleared ? { ok: true } : { ok: false, locked: true, correct: true };
}

// A signed-in session exhausted the budget (change-password, authenticator enrolment): whoever holds the token
// is guessing the password. Every session of the account ends, and the owner is told in the app and by email.
export async function endSessionsAfterLock(user, { ip, context }) {
  await run('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [user.id]);
  await logAudit({ userId: user.id, action: 'account_locked_sessions_revoked', entityId: user.id, details: { context, minutes: LOCK_MINUTES }, ip });
  await notify(user.id, 'security_account_locked',
    `Too many incorrect passwords were entered from a signed-in session (${context}). Sign-in is paused for ${LOCK_MINUTES} minutes and every session was signed out. If this was not you, reset your password and contact the administrator.`);
  await deliverNotice(user.email, 'account_locked');
}

export const LOCKED_SESSION_BODY = {
  error: `Too many incorrect passwords: the account is locked for ${LOCK_MINUTES} minutes and every session was signed out.`,
  session_invalid: true,
};
