// Health endpoints, mounted before the blocklist, rate limiter and request logger (server.js) so probes work while
// the database is down, are never rate-limited against the node's address, and do not flood the log.
//   GET /api/health/live   process only, always 200 (k8s liveness: a DB outage never restarts pods)
//   GET /api/health/ready  dependencies and the protections actually active (k8s readiness, compose healthcheck).
//                          In production an anonymous caller gets only { status } and the status code: which
//                          protection is degraded is for the administrator (GET /api/admin/system embeds the full
//                          report), not for an attacker timing a window. Outside production the full body is public.
//   GET /api/health        legacy { ok, db } (run-checks.sh and the test harness poll it)
// Bodies hold fixed tokens only, never error text, hosts or URLs; state changes are logged with the error code.
import express from 'express';
import { pool } from '../db.js';
import { pingRateLimitStore } from '../redis.js';
import { pingClamd } from '../antivirus.js';
import { otpDeliveryStatus } from '../otp-delivery.js';
import { evaluateReadiness, parseKey32, isProduction } from '../runtime-config.js';
import { ensureTotpKeyChecked } from '../totp-key-check.js';

const router = express.Router();

const withTimeout = (p, ms) => Promise.race([
  p, new Promise((_, r) => setTimeout(() => r(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms).unref()),
]);

const last = {};
function note(name, state, err) {
  if (last[name] !== state) {
    if (last[name] !== undefined || state !== 'ok') console.warn(`[readiness] ${name}: ${last[name] ?? 'start'} -> ${state}${err ? ` (${err.code || err.name || 'error'})` : ''}`);
    last[name] = state;
  }
}

async function collect() {
  const [database, rateLimit, clam, keyCheck] = await Promise.all([
    withTimeout(pool.query('SELECT 1'), 2000).then(() => 'ok', (e) => { note('database', 'fail', e); return 'fail'; }),
    pingRateLimitStore(1000),
    pingClamd(),
    withTimeout(ensureTotpKeyChecked(), 2000).catch(() => 'unknown'),
  ]);
  if (database === 'ok') note('database', 'ok');
  const clamav = clam.ok ? 'ok' : clam.reason === 'not_configured' ? 'not_configured' : 'unavailable';
  note('rate_limit_store', rateLimit.ok ? 'ok' : 'fail');
  note('clamav', clamav);
  // Outside production an unset key is fine (a development key is derived); a malformed one is not.
  const configured = !!process.env.TOTP_ENCRYPTION_KEY;
  const keyOk = configured ? !!parseKey32(process.env.TOTP_ENCRYPTION_KEY) : !isProduction();
  note('totp_key_check', keyCheck);
  return evaluateReadiness({ database, rateLimit, clamav, otp: otpDeliveryStatus(), totpKey: keyOk, totpKeyDerived: keyOk && !configured,
    totpKeyMismatch: keyCheck === 'mismatch' },
    { production: isProduction() });
}

// Cached briefly (READINESS_CACHE_MS, default 2000) so a public /ready cannot amplify load onto the dependencies.
let cache = { at: 0, p: null };
export function getReadiness() {
  const ttl = Number(process.env.READINESS_CACHE_MS ?? 2000);
  if (!cache.p || Date.now() - cache.at >= ttl) cache = { at: Date.now(), p: collect() };
  return cache.p;
}

router.get('/', async (req, res) => {
  try {
    await withTimeout(pool.query('SELECT 1'), 2000);
    res.json({ ok: true, db: 'connected' });
  } catch {
    res.status(503).json({ ok: false, db: 'unreachable' });
  }
});

router.get('/live', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));

router.get('/ready', async (req, res) => {
  const { httpStatus, body } = await getReadiness();
  res.set('Cache-Control', 'no-store').status(httpStatus).json(isProduction() ? { status: body.status } : body);
});

export default router;
