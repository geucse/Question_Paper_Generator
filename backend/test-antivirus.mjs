// Unit tests: the native clamd protocol client against a fake clamd (no ClamAV needed).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pingClamd, scanBuffer } from './src/antivirus.js';
import { startFakeClamd } from './test/fake-clamd.mjs';

// Hermetic: start without a scanner configured, whatever the calling shell has set (CI sets CLAMD_* for its server).
for (const k of ['CLAMD_HOST', 'CLAMD_PORT', 'CLAMD_SOCKET']) delete process.env[k];

let clam = null;
afterEach(async () => { if (clam) await clam.close(); clam = null; delete process.env.CLAMD_HOST; delete process.env.CLAMD_PORT; delete process.env.CLAMD_SOCKET; });

test('ping: PONG ok; garbage, silence, a closed port and no configuration are all not ok', async () => {
  assert.deepEqual(await pingClamd(), { ok: false, reason: 'not_configured' });
  clam = await startFakeClamd(); clam.env();
  assert.deepEqual(await pingClamd(), { ok: true });
  clam.state.mode = 'garbage'; assert.deepEqual(await pingClamd(), { ok: false, reason: 'unexpected_reply' });
  clam.state.mode = 'hang'; assert.deepEqual(await pingClamd({ timeoutMs: 200 }), { ok: false, reason: 'timeout' });
  const port = clam.port; await clam.close(); clam = null;
  process.env.CLAMD_HOST = '127.0.0.1'; process.env.CLAMD_PORT = String(port);
  assert.deepEqual(await pingClamd(), { ok: false, reason: 'unreachable' });
});

test('INSTREAM: a 200 KB file arrives intact in 64 KiB chunks; OK, FOUND and ERROR replies map to clean, infected, failed', async () => {
  clam = await startFakeClamd(); clam.env();
  const big = crypto.randomBytes(200 * 1024);
  assert.deepEqual(await scanBuffer(big), { status: 'clean' });
  assert.ok(clam.state.received[0].equals(big));
  clam.state.reply = () => 'stream: Eicar-Test-Signature FOUND';
  assert.deepEqual(await scanBuffer(Buffer.from('x')), { status: 'infected', signature: 'Eicar-Test-Signature' });
  clam.state.reply = () => 'INSTREAM size limit exceeded. ERROR';
  assert.deepEqual(await scanBuffer(Buffer.from('x')), { status: 'failed', reason: 'scanner_error' });
  clam.state.mode = 'garbage';
  assert.deepEqual(await scanBuffer(Buffer.from('x')), { status: 'failed', reason: 'unexpected_reply' });
  clam.state.mode = 'hang'; process.env.CLAMD_SCAN_TIMEOUT_MS = '200';
  try { assert.deepEqual(await scanBuffer(Buffer.from('x')), { status: 'failed', reason: 'scan_timeout' }); } finally { delete process.env.CLAMD_SCAN_TIMEOUT_MS; }
});

test('fail-closed without a scanner; reasons are fixed tokens (no paths or scanner output)', async () => {
  assert.deepEqual(await scanBuffer(Buffer.from('x')), { status: 'failed', reason: 'scanner_not_configured' });
  process.env.CLAMD_HOST = '127.0.0.1'; process.env.CLAMD_PORT = '1';
  const r = await scanBuffer(Buffer.from('x'));
  assert.deepEqual(r, { status: 'failed', reason: 'scanner_unavailable' });
});
