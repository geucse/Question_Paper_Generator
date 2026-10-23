import Redis from 'ioredis';
import RedisStore from 'rate-limit-redis';
import { redactUrl } from './redact.js';

// Rate-limit state lives in Redis so every backend replica shares one count per client; a per-process store would
// give an attacker spread across pods a higher effective limit. (Account lockout, suspicious activity and lockdown
// are Postgres-backed and already shared.)
//
// RATE_LIMIT_STORE:
//   redis (default)  Connect at startup. The store fails CLOSED: while Redis is down every rate-limited request
//                    gets 503 (errors.js) and /api/health/ready reports not-ready, instead of silently running
//                    without the shared limit. The client reconnects in the background, so service resumes as
//                    soon as Redis is back. In production this holds from the first second: a Redis that is not
//                    up yet at startup (first deploy, a backend pod restarting during a Redis restart; k8s has no
//                    start ordering) means the backend starts NOT READY and recovers by itself, never a crash loop.
//                    Outside production an unreachable Redis falls back to per-process limits with a warning.
//   memory           Per-process limits, no Redis connection at all: tests, local development, or an explicit
//                    single-replica production deployment.
const CONNECT_TIMEOUT_MS = 2000;

let rateLimitStoreKind = 'unknown';
let client = null;
export const getRateLimitStoreKind = () => rateLimitStoreKind;

class FailClosedRedisStore extends RedisStore {
  async increment(key) {
    try { return await super.increment(key); } catch (e) { throw unavailable(e); }
  }
  async decrement(key) {
    try { return await super.decrement(key); } catch (e) { throw unavailable(e); }
  }
  async resetKey(key) {
    try { return await super.resetKey(key); } catch (e) { throw unavailable(e); }
  }
}
function unavailable(cause) {
  return Object.assign(new Error('rate-limit store unavailable'), { code: 'RATE_LIMIT_STORE_UNAVAILABLE', cause });
}

export async function createRateLimitStoreFactory(env = process.env) {
  const setting = env.RATE_LIMIT_STORE || 'redis';
  const production = env.NODE_ENV === 'production';
  if (setting === 'memory') {
    rateLimitStoreKind = 'memory';
    if (production) console.warn('[rate-limit] RATE_LIMIT_STORE=memory: per-process limits, correct for a single backend replica only.');
    return () => undefined; // express-rate-limit uses its own MemoryStore when store is undefined
  }
  const redisUrl = env.REDIS_URL || 'redis://localhost:6379';
  const shown = redactUrl(redisUrl);
  const newClient = (retryStrategy) => {
    const r = new Redis(redisUrl, {
      lazyConnect: true,
      retryStrategy,
      enableOfflineQueue: false, // while disconnected, commands fail at once (fail closed) instead of queueing
      connectTimeout: CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
    });
    let lastCode = null;
    r.on('error', (err) => {
      const code = err.code || err.name;
      if (code !== lastCode) console.error(`[rate-limit] Redis error (${code})`); // once per kind, not once per retry
      lastCode = code;
    });
    r.on('ready', () => { lastCode = null; });
    return r;
  };
  const c = newClient(() => null); // no background retries until we know whether to fall back
  try {
    await Promise.race([
      c.connect(),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS).unref()),
    ]);
    await c.ping();
  } catch (err) {
    try { c.disconnect(); } catch { /* already closed */ }
    if (production) {
      // Start not-ready (fail closed) and keep reconnecting; readiness turns ready once Redis answers.
      const bg = newClient(RECONNECT);
      bg.on('ready', () => console.log(`[rate-limit] connected to Redis at ${shown}: rate limits are shared across replicas.`));
      bg.connect().catch(() => { /* retried by RECONNECT */ });
      client = bg;
      rateLimitStoreKind = 'redis';
      console.error(`[rate-limit] Redis unreachable at ${shown} (${err.code || err.name}) at startup: rate-limited requests are refused (503) and `
        + '/api/health/ready reports not-ready until Redis is reachable; reconnecting in the background.');
      return storeFactory(bg);
    }
    rateLimitStoreKind = 'memory';
    console.warn(`[rate-limit] Redis unreachable at ${shown} (${err.code || err.name}): using per-process rate limiting (fine for one local instance). `
      + 'Set RATE_LIMIT_STORE=memory to skip this check.');
    return () => undefined;
  }
  // Connected: from now on reconnect after drops (ioredis reads options.retryStrategy on every close).
  c.options.retryStrategy = RECONNECT;
  client = c;
  rateLimitStoreKind = 'redis';
  console.log(`[rate-limit] connected to Redis at ${shown}: rate limits are shared across replicas.`);
  return storeFactory(c);
}

const RECONNECT = (times) => Math.min(times * 500, 5000);

// Each limiter needs its own store instance; the prefix keeps their key spaces apart.
function storeFactory(c) {
  return (prefix) => {
    const store = new FailClosedRedisStore({ prefix, sendCommand: (...args) => (client || c).call(...args) });
    // The store loads its Lua scripts at construction; if Redis is down (or drops before the first request) these
    // promises reject before anyone awaits them. They are re-loaded on the next increment (NOSCRIPT/failure path).
    for (const k of ['incrementScriptSha', 'getScriptSha']) store[k]?.catch?.(() => {});
    return store;
  };
}

export async function pingRateLimitStore(ms = 1000) {
  if (rateLimitStoreKind === 'memory') return { kind: 'memory', ok: true };
  if (rateLimitStoreKind !== 'redis' || !client) return { kind: rateLimitStoreKind, ok: false };
  try {
    const r = await Promise.race([client.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);
    return { kind: 'redis', ok: r === 'PONG' };
  } catch {
    return { kind: 'redis', ok: false };
  }
}

export async function closeRateLimitStore() {
  if (!client) return;
  const c = client; client = null;
  try { await c.quit(); } catch { c.disconnect(); }
}
