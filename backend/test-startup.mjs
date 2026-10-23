// Spawned-process tests: production refuses to start on unsafe configuration (before touching Redis or the
// database) but starts not-ready (never a crash loop) when only a dependency is down, seed.js refuses production,
// and CORS denies unknown origins without a 500.
// Every process runs in an empty temporary directory, so backend/.env is never loaded; every database URL points at
// a closed port (127.0.0.1:1). No real database is ever reachable from these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SERVER = path.join(HERE, 'src', 'server.js');
const SEED = path.join(HERE, 'src', 'seed.js');
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-portal-startup-'));
const FAKE_DB = 'postgres://f:f@127.0.0.1:1/f';
const PROD = {
  PATH: process.env.PATH, NODE_ENV: 'production', JWT_SECRET: 'Zq8'.repeat(16), DATABASE_URL: FAKE_DB, APP_DATABASE_URL: FAKE_DB,
  CORS_ALLOWED_ORIGINS: 'https://exam.example.edu', OTP_DELIVERY_PROVIDER: 'smtp', SMTP_HOST: 'mail.example.edu', SMTP_PORT: '587',
  SMTP_FROM: 'noreply@example.edu', TOTP_ENCRYPTION_KEY: '0f'.repeat(32), CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '1', REDIS_URL: 'redis://127.0.0.1:1',
};
const run = (file, env) => spawnSync(process.execPath, [file], { cwd: CWD, env, encoding: 'utf8', timeout: 20000 });

test('production refuses to start with console OTP delivery, without a TOTP key, or without a CORS allowlist', () => {
  for (const [over, re] of [[{ OTP_DELIVERY_PROVIDER: 'console', DEV_OTP_CONSOLE: 'reveal' }, /OTP_DELIVERY_PROVIDER/], [{ TOTP_ENCRYPTION_KEY: '' }, /TOTP_ENCRYPTION_KEY/],
    [{ CORS_ALLOWED_ORIGINS: '' }, /CORS_ALLOWED_ORIGINS/], [{ CLAMD_HOST: '', CLAMD_CONFIG_PATH: '/app/deploy/clamd-client.conf' }, /CLAMD_CONFIG_PATH is no longer used/],
    [{ JWT_SECRET: 'replace-with-a-long-random-string-0123456789' }, /JWT_SECRET/]]) {
    const r = run(SERVER, { ...PROD, ...over });
    assert.equal(r.status, 1, `${JSON.stringify(over)}: ${r.stderr}`);
    assert.match(r.stderr, /Refusing to start in production/); assert.match(r.stderr, re);
    assert.doesNotMatch(r.stderr + r.stdout, /ECONNREFUSED|Redis/, 'refused before any connection');
    assert.equal((r.stderr + r.stdout).includes('0f0f0f'), false, 'no secret values');
  }
});

test('a complete production configuration starts even with Redis and the database down: not ready, and the anonymous readiness body is only the status', async () => {
  const port = 4990 + (process.pid % 9);
  let out = '';
  const child = spawn(process.execPath, [SERVER], { cwd: CWD, env: { ...PROD, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/api/health/live`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(up, `started (no crash loop): ${out}`);
    assert.match(out, /Redis unreachable .* at startup: rate-limited requests are refused/);
    assert.match(out, /key check deferred until the database is reachable/);
    const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'not_ready' }, 'which protection is down is not public in production');
    const limited = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    assert.equal(limited.status, 503, 'fail closed while Redis is down');
    assert.equal(out.includes('0f0f0f'), false, 'no secret values');
  } finally { child.kill('SIGKILL'); }
});

test('seed.js refuses NODE_ENV=production before any connection and prints no credentials', () => {
  const r = run(SEED, { PATH: process.env.PATH, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), DATABASE_URL: FAKE_DB });
  assert.equal(r.status, 1); assert.match(r.stderr, /Refusing to seed/);
  assert.doesNotMatch(r.stderr, /Seed failed|ECONNREFUSED/); assert.doesNotMatch(r.stdout, /password:/);
});

test('CORS: an unknown origin gets no CORS headers (and no 500); an allowed origin is echoed', async () => {
  const port = 4900 + (process.pid % 90);
  const child = spawn(process.execPath, [SERVER], { cwd: CWD, env: { PATH: process.env.PATH, NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(40), DATABASE_URL: FAKE_DB,
    PORT: String(port), RATE_LIMIT_STORE: 'memory', CORS_ALLOWED_ORIGINS: 'https://ok.example.edu', DEV_OTP_CONSOLE: 'masked', ATTACHMENT_RESCAN_INTERVAL_MS: '0' }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/api/health/live`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(up, 'dev server started without Redis or a database');
    const bad = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { Origin: 'https://evil.example.com' } });
    // No database here: the IP blocklist lookup fails, which is a 503 (service unavailable), never a CORS 500.
    assert.equal(bad.status, 503); assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const good = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { Origin: 'https://ok.example.edu' } });
    assert.equal(good.headers.get('access-control-allow-origin'), 'https://ok.example.edu');
    const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
    const body = await ready.json();
    assert.equal(ready.status, 503); assert.deepEqual(body.failing, ['database']); assert.equal(body.checks.otp_delivery, 'ok');
  } finally { child.kill('SIGKILL'); }
});
