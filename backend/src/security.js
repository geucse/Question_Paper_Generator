import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { get, run } from './db.js';
import { logAudit } from './audit.js';
import { createRateLimitStoreFactory } from './redis.js';

export const securityHeaders = helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
  hsts: { maxAge: 31536000, includeSubDomains: true },
});

// Built once at server startup (see server.js) using a Redis-backed store
// when available, so counts are shared correctly across every backend
// replica rather than each process keeping its own independent tally. See
// redis.js for the fallback behavior if Redis is unreachable.
export async function createRateLimiters() {
  const makeStore = await createRateLimitStoreFactory();

  // General ceiling on requests per IP — blunt but effective against
  // application-layer DoS (rapid-fire scripted requests). True volumetric DDoS
  // needs to be stopped upstream (e.g. Cloudflare) before it reaches this
  // process at all; this only protects the app once traffic gets here.
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.GLOBAL_RATE_MAX || 300), // default unchanged; raised only for automated tests
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this address. Please slow down.' },
    store: makeStore('rl:global:'),
  });

  // Much tighter limit specifically on auth endpoints — this is where
  // brute-forcing and credential stuffing would happen.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_MAX || 15), // default unchanged; raised only for automated tests
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts from this address. Please slow down.' },
    store: makeStore('rl:auth:'),
  });

  return { globalLimiter, authLimiter };
}

// Every path that takes a password, a one-time code or an authenticator code gets the strict per-IP limiter
// (server.js). Per-account limits are enforced in the routes themselves (login lockout, OTP and TOTP counters).
export const AUTH_LIMITED_PATHS = ['/api/auth/login', '/api/auth/password-reset', '/api/auth/totp', '/api/auth/change-password', '/api/coe/papers/:paperId/coe-approve'];

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const THRESHOLDS = {
  failed_login: 8,
  invalid_otp: 6,
  invalid_totp: 4,
  invalid_dual_control: 3,
  malformed_request: 15,
  not_found_scan: 20,
  invalid_reset_token: 10,
};

// Automatic blocks expire (AUTO_BLOCK_MINUTES, default 60): a shared campus NAT whose users mistype passwords, or an
// address an attacker spoofed through a misconfigured proxy, is never shut out for good. Blocks without an expiry
// (expires_at NULL) stay until an admin removes them.
const AUTO_BLOCK_MINUTES = () => Math.max(1, Number(process.env.AUTO_BLOCK_MINUTES) || 60);

// Lockdown (a global freeze of non-admin writes) is a response to an attack by someone who already holds a valid
// session: wrong authenticator codes at step-up, failed dual-control approvals. Unauthenticated noise (failed logins
// with any email, OTP or reset-code guessing, malformed requests, 404 scans) blocks the offending address for a while
// but never freezes the institution: anyone could produce it from a handful of addresses.
export const LOCKDOWN_TRIGGERS = ['invalid_totp', 'invalid_dual_control'];

export async function checkBlocklist(req, res, next) {
  try {
    const blocked = await get('SELECT ip FROM blocked_ips WHERE ip = $1 AND (expires_at IS NULL OR expires_at > now())', [req.ip]);
    if (blocked) {
      // Deliberately vague response — don't confirm to the caller *why* they're
      // blocked, that just helps them iterate around it.
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  } catch (e) {
    next(e);
  }
}

export async function flagSuspicious(req, activityType, details = {}) {
  const ip = req.ip;

  // Ignore 404 scans from common proxy/scanner IPs to avoid false lockdowns
  // Only track if it's actually suspicious (non-API paths, weird patterns)
  if (activityType === 'not_found_scan') {
    const path = details.path || '';
    // Ignore common scanner/proxy health checks
    const ignoredPaths = [
      '/health', '/status', '/ping', '/robots.txt', '/favicon.ico',
      '/.well-known/', '/sitemap.xml'
    ];
    if (ignoredPaths.some(p => path.startsWith(p))) {
      return; // Don't track these
    }
  }

  await run('INSERT INTO suspicious_activity (ip, activity_type, details) VALUES ($1, $2, $3)',
    [ip, activityType, JSON.stringify(details)]);

  const recentRow = await get(`
    SELECT COUNT(*)::int as c FROM suspicious_activity
    WHERE ip = $1 AND activity_type = $2 AND created_at > now() - interval '1 hour'
  `, [ip, activityType]);
  const recentCount = recentRow?.c ?? 0;

  const threshold = THRESHOLDS[activityType] || 10;
  // The loopback address is recorded but never auto-blocked: behind a misconfigured proxy every request looks like
  // it comes from there, and one block would lock everybody out.
  if (recentCount >= threshold && ip && !LOOPBACK.has(ip)) {
    // New block, or renewal of an EXPIRED automatic block; an active block or a manual one is left alone.
    const minutes = AUTO_BLOCK_MINUTES();
    const blocked = await get(`
      INSERT INTO blocked_ips (ip, reason, blocked_at, auto_blocked, expires_at)
      VALUES ($1, $2, now(), TRUE, now() + make_interval(mins => $3))
      ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason, blocked_at = now(), auto_blocked = TRUE, expires_at = EXCLUDED.expires_at
        WHERE blocked_ips.expires_at IS NOT NULL AND blocked_ips.expires_at <= now()
      RETURNING ip`, [ip, `Auto-blocked: ${recentCount}x ${activityType} within 1 hour`, minutes]);
    if (blocked) {
      await logAudit({ userId: null, action: 'ip_auto_blocked', entityId: ip, details: { activityType, recentCount, minutes }, ip });
      // PIVOT_SPEC_V2 §37.4: only real attacks count toward lockdown (see LOCKDOWN_TRIGGERS).
      if (LOCKDOWN_TRIGGERS.includes(activityType)) await checkForLockdown();
    }
  }
}

// If several distinct IPs get auto-blocked for authenticated attacks in a short window, that looks like a
// coordinated attack with stolen sessions rather than one confused user: flip the system into a stricter posture.
async function checkForLockdown() {
  const row = await get(`
    SELECT COUNT(DISTINCT ip)::int as c FROM blocked_ips
    WHERE blocked_at > now() - interval '10 minutes' AND auto_blocked
      AND reason ~ ('x (' || $1 || ') within')
  `, [LOCKDOWN_TRIGGERS.join('|')]);
  const recentBlocks = row?.c ?? 0;

  if (recentBlocks >= 3) {
    await run(`
      INSERT INTO system_state (key, value, updated_at) VALUES ('lockdown_mode', '1', now())
      ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = now()
    `);
    await logAudit({ userId: null, action: 'system_lockdown_triggered', entityId: null, details: { recentBlocks }, ip: 'system' });
  }
}

export async function isLockdownActive() {
  const row = await get("SELECT value, updated_at FROM system_state WHERE key = 'lockdown_mode'");
  if (!row || row.value !== '1') return false;

  // Auto-expire lockdown after 1 hour
  const lockdownAge = Date.now() - new Date(row.updated_at).getTime();
  const ONE_HOUR = 60 * 60 * 1000;

  if (lockdownAge > ONE_HOUR) {
    await run("UPDATE system_state SET value = '0' WHERE key = 'lockdown_mode'");
    await logAudit({
      userId: null,
      action: 'system_lockdown_auto_expired',
      entityId: null,
      details: { duration_ms: lockdownAge },
      ip: 'system'
    });
    return false;
  }

  return true;
}

// Lockdown (spec §37.4): while active, non-admin users cannot change anything; reads keep working, and so do
// signing in (protected by the auth limiter and the account lockout), signing out and changing one's own password.
// Enforced in requireAuth (middleware.js) once the user is known. Auto-expires after an hour (isLockdownActive).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOCKDOWN_EXEMPT = ['/api/auth/logout', '/api/auth/change-password'];
export async function lockdownRefusal(req, user) {
  if (SAFE_METHODS.has(req.method) || user?.role === 'admin' || LOCKDOWN_EXEMPT.includes(req.originalUrl.split('?')[0])) return null;
  if (!(await isLockdownActive())) return null;
  return {
    error: 'The system is temporarily in a restricted security mode: changes are paused for non-administrators. Please try again later or contact the administrator.',
    lockdown: true,
  };
}
