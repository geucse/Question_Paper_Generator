// Runtime configuration rules shared by startup (server.js), readiness (/api/health/ready) and the tests.
// Pure: no database, no network. Problem messages name the variable, never its value.
//
// Production (NODE_ENV=production) refuses to start on a configuration error that never heals by itself
// (missing CORS allowlist, OTP delivery not SMTP, missing TOTP key, no ClamAV endpoint, ...). Transient outages
// (database, Redis, clamd) are reported by readiness instead, so a dependency restart never crash-loops the app.
import { otpDeliveryProblems } from './otp-delivery.js';

export const isProduction = (env = process.env) => env.NODE_ENV === 'production';

export function parseAllowedOrigins(str) {
  return String(str || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Express 'trust proxy': a hop count (default 1), 'false', or a comma list of addresses/CIDRs/keywords.
// 'true' (trust every hop) lets any client spoof req.ip and is refused in production.
export function parseTrustProxy(str) {
  const v = String(str ?? '').trim();
  if (v === '') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'false') return false;
  if (v === 'true') return true;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// A 32-byte key given as 64 hex characters or as base64 (openssl rand -hex 32 / openssl rand -base64 32).
export function parseKey32(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.length === 32 ? buf : null;
}

export const clamdConfigured = (env = process.env) => !!(env.CLAMD_SOCKET || env.CLAMD_HOST);

const PLACEHOLDER_SECRET = /replace-with|your-jwt-secret|change-?me/i;

export function productionConfigProblems(env = process.env) {
  if (!isProduction(env)) return [];
  const problems = [];
  const origins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  if (!origins.length) problems.push('CORS_ALLOWED_ORIGINS must list the allowed frontend origins (comma-separated)');
  for (const o of origins) {
    let ok = false;
    try { ok = o !== '*' && new URL(o).origin === o; } catch { ok = false; }
    if (!ok) { problems.push('CORS_ALLOWED_ORIGINS entries must be bare origins such as https://portal.example.edu (no "*", paths or trailing slashes)'); break; }
  }
  problems.push(...otpDeliveryProblems(env));
  if (!env.TOTP_ENCRYPTION_KEY) problems.push('TOTP_ENCRYPTION_KEY is required (32 bytes, hex or base64: openssl rand -hex 32)');
  else if (!parseKey32(env.TOTP_ENCRYPTION_KEY)) problems.push('TOTP_ENCRYPTION_KEY must be exactly 32 bytes, given as 64 hex characters or base64');
  if (!clamdConfigured(env)) {
    problems.push(env.CLAMD_CONFIG_PATH
      ? 'CLAMD_CONFIG_PATH is no longer used; set CLAMD_HOST/CLAMD_PORT (or CLAMD_SOCKET) to reach clamd'
      : 'CLAMD_HOST (with CLAMD_PORT) or CLAMD_SOCKET must point at the ClamAV daemon');
  }
  if (String(env.TRUST_PROXY).trim() === 'true') problems.push('TRUST_PROXY=true trusts every proxy hop and lets clients spoof their address; set the hop count (e.g. 1 or 2)');
  if (![undefined, '', 'redis', 'memory'].includes(env.RATE_LIMIT_STORE)) problems.push('RATE_LIMIT_STORE must be "redis" or "memory"');
  if (env.RATE_LIMIT_STORE !== 'memory' && !env.REDIS_URL) problems.push('REDIS_URL is required for shared rate limiting (or set RATE_LIMIT_STORE=memory for a single replica)');
  if (PLACEHOLDER_SECRET.test(env.JWT_SECRET || '')) problems.push('JWT_SECRET is still the example placeholder; generate one with: openssl rand -base64 48');
  if (!(env.APP_DATABASE_URL || env.DATABASE_URL)) problems.push('DATABASE_URL (or APP_DATABASE_URL) is required');
  return problems;
}

// raw: { database: 'ok'|'fail', rateLimit: { kind, ok }, clamav: 'ok'|'unavailable'|'not_configured',
//        otp: { provider, configured }, totpKey: boolean, totpKeyDerived?: boolean (development key from JWT_SECRET),
//        totpKeyMismatch?: boolean (the key differs from the database's key check, totp-key-check.js) }
// 503 only when a REQUIRED check fails. A reachable-but-down ClamAV is 'degraded', not 503: uploads stay
// quarantined (fail-closed), and a 503 would pull every backend pod out of service on an AV restart.
export function evaluateReadiness(raw, { production = isProduction() } = {}) {
  const checks = {
    database: raw.database === 'ok' ? 'ok' : 'fail',
    rate_limit_store: raw.rateLimit?.ok ? 'ok' : 'fail',
    clamav: raw.clamav,
    otp_delivery: raw.otp?.configured ? 'ok' : 'not_configured',
    totp_encryption_key: !raw.totpKey ? 'missing' : raw.totpKeyMismatch ? 'mismatch' : raw.totpKeyDerived ? 'development_key' : 'ok',
  };
  const required = production
    ? {
      database: checks.database === 'ok',
      rate_limit_store: checks.rate_limit_store === 'ok',
      otp_delivery: !!raw.otp?.configured && raw.otp?.provider === 'smtp',
      totp_encryption_key: !!raw.totpKey && !raw.totpKeyMismatch,
      clamav: raw.clamav !== 'not_configured',
    }
    : { database: checks.database === 'ok' };
  const failing = Object.entries(required).filter(([, ok]) => !ok).map(([name]) => name);
  const anyNonOk = Object.values(checks).some((v) => v !== 'ok');
  const kind = raw.rateLimit?.kind;
  const body = {
    status: failing.length ? 'not_ready' : anyNonOk ? 'degraded' : 'ready',
    checks,
    protections: {
      rate_limiting: kind === 'redis' ? (raw.rateLimit.ok ? 'shared (Redis)' : 'unavailable: requests are refused')
        : kind === 'memory' ? 'per-process (single replica only)' : 'unknown',
      upload_scanning: raw.clamav === 'ok' ? 'active (ClamAV)'
        : raw.clamav === 'unavailable' ? 'scanner unavailable: new uploads are quarantined and cannot be used until rescanned clean'
          : 'not configured: uploads are quarantined and cannot be used',
      otp_delivery: raw.otp?.provider === 'smtp' ? 'email (SMTP)' : raw.otp?.provider === 'console' ? 'development console' : 'none',
      totp_secrets: !raw.totpKey ? 'encryption key missing'
        : raw.totpKeyMismatch ? 'key does not match the stored key check: authenticator step-up is refused until the previous key is restored or rotated (TOTP_KEY_ROTATE=yes)'
        : raw.totpKeyDerived ? 'encrypted with a development key derived from JWT_SECRET (set TOTP_ENCRYPTION_KEY)' : 'encrypted at rest',
    },
    failing,
    timestamp: new Date().toISOString(),
  };
  return { httpStatus: failing.length ? 503 : 200, body };
}
