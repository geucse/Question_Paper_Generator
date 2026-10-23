// Detects a changed TOTP_ENCRYPTION_KEY (or, in development, a changed JWT_SECRET the key is derived from).
// A key of the right length but the wrong value passes every format check, yet no stored authenticator secret
// opens with it: every COE approval would then fail, and treating that as "set it up again" would let a
// password alone replace every authenticator. So a key check value (an HMAC of a fixed label under the key; it
// reveals nothing about the key) is stored in system_state on first start and compared afterwards:
//   - match              ok
//   - mismatch           production refuses to start (server.js); readiness reports totp_encryption_key:
//                        'mismatch' (503 in production); step-up and enrolment are refused (503), never downgraded
//   - TOTP_KEY_ROTATE=yes on a mismatch: an explicit, audited rotation. The new check value is stored, every
//                        stored secret (unreadable under the new key) is cleared and its owner must enrol again
//                        (password re-authentication is allowed for them, totp_reenroll_required). Remove the
//                        flag after the rotation: while it is set, a later accidental key change rotates too.
// When the database is unreachable at startup the check stays 'unknown' and is retried by readiness and by the
// first step-up, so a database restart never crash-loops the app.
import crypto from 'crypto';
import { get, withTransaction } from './db.js';
import { loadTotpKey } from './secret-box.js';
import { logAudit } from './audit.js';

const STATE_KEY = 'totp_key_check';
let state = 'unknown'; // 'unknown' | 'ok' | 'mismatch'

export const totpKeyCheckState = () => state;
export const rotationRequested = (env = process.env) => String(env.TOTP_KEY_ROTATE || '').toLowerCase() === 'yes';

export function keyCheckValue(key = loadTotpKey()) {
  return `v1:${crypto.createHmac('sha256', key).update('exam-portal totp key check v1').digest('hex').slice(0, 32)}`;
}

// Returns 'ok' | 'initialised' | 'rotated' | 'mismatch'. Throws on a database error (state stays as it was).
export async function verifyTotpKeyCheck({ env = process.env } = {}) {
  const want = keyCheckValue();
  const row = await get('SELECT value FROM system_state WHERE key = $1', [STATE_KEY]);
  if (!row) {
    // First start with this table: record the running key. A concurrent replica may win; compare with its value.
    const ins = await get(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now())
                           ON CONFLICT (key) DO NOTHING RETURNING value`, [STATE_KEY, want]);
    if (ins) { state = 'ok'; return 'initialised'; }
    return verifyTotpKeyCheck({ env });
  }
  if (row.value === want) { state = 'ok'; return 'ok'; }
  if (!rotationRequested(env)) { state = 'mismatch'; return 'mismatch'; }
  const cleared = await withTransaction(async (txn) => {
    await txn.run('UPDATE system_state SET value = $2, updated_at = now() WHERE key = $1', [STATE_KEY, want]);
    const users = await txn.all(`
      UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_pending_secret = NULL, totp_pending_expires_at = NULL,
             totp_last_used_step = NULL, totp_reenroll_required = TRUE
       WHERE totp_secret IS NOT NULL OR totp_pending_secret IS NOT NULL
      RETURNING id`);
    for (const u of users) {
      await txn.run(`INSERT INTO notifications (user_id, type, message) VALUES ($1, 'security_totp_reenroll', $2)`,
        [u.id, 'The server key protecting authenticator secrets was rotated. Set up your authenticator again (Authenticator tab) before your next approval.']);
    }
    await logAudit({ userId: null, action: 'totp_key_rotated', entityId: null, details: { authenticators_cleared: users.length }, ip: 'system' }, txn);
    return users.length;
  });
  console.warn(`[totp] TOTP_KEY_ROTATE=yes: the authenticator key was rotated; ${cleared} authenticator(s) must be set up again. Remove TOTP_KEY_ROTATE now.`);
  state = 'ok';
  return 'rotated';
}

// For readiness and step-up: run the check once if it has not succeeded yet (the database was down at startup).
export async function ensureTotpKeyChecked() {
  if (state !== 'unknown') return state;
  try { await verifyTotpKeyCheck(); } catch { /* database unavailable: stays unknown */ }
  return state;
}

export function resetTotpKeyCheckForTests() { state = 'unknown'; }
