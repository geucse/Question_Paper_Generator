// Unit tests: in production an unreachable Redis at startup means a fail-closed, reconnecting store (not a crash
// loop), REDIS_URL credentials never reach the log, and RATE_LIMIT_STORE=memory skips Redis entirely.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRateLimitStoreFactory, getRateLimitStoreKind, pingRateLimitStore, closeRateLimitStore } from './src/redis.js';

const quiet = async (fn) => {
  const out = []; const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.join(' '));
  try { return { r: await fn().catch((e) => e), out: out.join('\n') }; } finally { Object.assign(console, orig); }
};

// Just enough of the Redis protocol for ioredis to connect (ready check: INFO) and for a PING.
function fakeRedis() {
  return net.createServer((sock) => {
    sock.on('data', (buf) => {
      for (const cmd of buf.toString().match(/\*\d+\r\n\$\d+\r\n([A-Za-z]+)/g) || []) {
        const name = /([A-Za-z]+)$/.exec(cmd)[1].toUpperCase();
        if (name === 'INFO') { const body = '# Server\r\nloading:0\r\n'; sock.write(`$${body.length}\r\n${body}\r\n`); }
        else if (name === 'PING') sock.write('+PONG\r\n');
        else if (name === 'QUIT') { sock.end('+OK\r\n'); return; }
        else sock.write('+OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
}
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('production with Redis down at startup: starts fail-closed (503s, not ready), hides the password, and recovers by itself', async () => {
  const port = await freePort();
  const { r, out } = await quiet(() => createRateLimitStoreFactory({ NODE_ENV: 'production', REDIS_URL: `redis://:s3cretpw@127.0.0.1:${port}` }));
  try {
    assert.equal(typeof r, 'function', 'no crash: a store factory is returned');
    assert.equal(getRateLimitStoreKind(), 'redis', 'never silently per-process');
    assert.match(out, /reconnecting in the background/); assert.equal(out.includes('s3cretpw'), false);
    assert.equal((await pingRateLimitStore(300)).ok, false, 'readiness: not ready');
    const store = r('rl:test:');
    store.init?.({ windowMs: 60000 });
    const err = await store.increment('k').then(() => null, (e) => e);
    assert.equal(err?.code, 'RATE_LIMIT_STORE_UNAVAILABLE', 'requests are refused (fail closed)');
    // Redis comes up on that address: the client reconnects and readiness turns ready without a restart.
    const srv = fakeRedis().listen(port, '127.0.0.1');
    const conns = new Set(); srv.on('connection', (c) => { conns.add(c); c.on('close', () => conns.delete(c)); });
    try {
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) { await new Promise((res) => setTimeout(res, 250)); ok = (await pingRateLimitStore(300)).ok; }
      assert.equal(ok, true, 'reconnected');
    } finally { await closeRateLimitStore(); for (const c of conns) c.destroy(); srv.close(); }
  } finally { await closeRateLimitStore(); }
});

test('RATE_LIMIT_STORE=memory: no connection attempt, reported as per-process', async () => {
  const t = Date.now();
  const { r } = await quiet(() => createRateLimitStoreFactory({ NODE_ENV: 'production', RATE_LIMIT_STORE: 'memory', REDIS_URL: 'redis://127.0.0.1:1' }));
  assert.equal(typeof r, 'function'); assert.ok(Date.now() - t < 500);
  assert.equal(getRateLimitStoreKind(), 'memory'); assert.deepEqual(await pingRateLimitStore(), { kind: 'memory', ok: true });
});

test('outside production an unreachable Redis falls back to per-process limits with a warning', async () => {
  const { r, out } = await quiet(() => createRateLimitStoreFactory({ NODE_ENV: 'test', REDIS_URL: 'redis://:pw@127.0.0.1:1' }));
  assert.equal(typeof r, 'function'); assert.equal(getRateLimitStoreKind(), 'memory');
  assert.match(out, /per-process/); assert.equal(out.includes(':pw@'), false);
});
