import { verifyJwt } from './auth.js';
import { get } from './db.js';
import { lockdownRefusal } from './security.js';

// Endpoints that stay reachable even while an account is force-flagged to
// change its password: enough to change it, to fetch identity info for the
// frontend to know it needs to show that screen, and to sign out.
const ALLOWED_DURING_FORCED_PASSWORD_CHANGE = [
  '/api/auth/change-password',
  '/api/auth/me',
  '/api/auth/logout',
];

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  // session_invalid: true marks specifically "your bearer token itself is
  // no good" (missing/malformed/expired/revoked/account gone) — as opposed
  // to a 401 a route returns for a business-logic reason with a perfectly
  // valid token still attached (wrong current password, wrong TOTP code
  // during step-up approval, etc). The frontend only auto-clears the
  // stored token and forces a re-login on this specific flag, never on a
  // bare 401 status, so those legitimate-token-but-wrong-answer cases
  // aren't mistaken for a dead session.
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token', session_invalid: true });
  }
  let payload;
  try {
    payload = verifyJwt(header.slice(7));
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token', session_invalid: true });
  }
  // Outside the token try: a database error is not a bad session. It reaches the error handler (503/500), so a
  // database blip never logs every user out.
  const user = await get('SELECT * FROM users WHERE id = $1', [payload.sub]);
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Account inactive or not found', session_invalid: true });
  }
  // Real revocation: every token carries the token_version that was
  // current when it was issued. Logging out, changing password, deactivation,
  // a role change or an admin forcing a session dead all bump users.token_version — any
  // token minted before that bump fails this check immediately,
  // regardless of its own expiry. See /auth/logout and /auth/users/:id/force-logout.
  if (payload.tv !== user.token_version) {
    return res.status(401).json({ error: 'Session has been revoked, please log in again', session_invalid: true });
  }
  // Deadline enforcement happens here, not just in the UI: an account past its
  // access_deadline (whatever its role) cannot perform any authenticated action at all.
  if (user.access_deadline && new Date(user.access_deadline) < new Date()) {
    return res.status(403).json({ error: 'Access deadline has passed for this account' });
  }
  // Enforced here, not just as a frontend prompt: an account that must choose a new password
  // cannot call any other endpoint until it does, regardless of what the client does.
  if (user.must_change_password && !ALLOWED_DURING_FORCED_PASSWORD_CHANGE.includes(req.originalUrl.split('?')[0])) {
    return res.status(403).json({ error: 'You must change your temporary password before continuing', must_change_password: true });
  }
  // Security lockdown (security.js): non-admin changes are paused; reads, sign-out and password change still work.
  const lock = await lockdownRefusal(req, user);
  if (lock) return res.status(503).json(lock);
  req.user = user;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
