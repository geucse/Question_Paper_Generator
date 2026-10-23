// ClamAV over the native clamd protocol (node:net), no clamdscan binary and no temporary copy of the file.
//   zPING\0                -> "PONG"
//   zINSTREAM\0 + chunks   -> "stream: OK" | "stream: <signature> FOUND" | "... ERROR"
// Each chunk is a 4-byte big-endian length followed by the bytes; a zero length ends the stream.
// Target (read per call): CLAMD_SOCKET (unix socket path) or CLAMD_HOST + CLAMD_PORT (default 3310).
//
// FAIL-CLOSED: anything other than an explicit "stream: OK" is never 'clean'. An unreachable, slow or confused
// scanner gives 'failed'; the upload route then quarantines the file, and nothing lets a question with a
// non-clean file move forward (questions.js /submit, the 040 quality gate and the submit trigger). Failed files are
// rescanned later (attachment-scan.js). Reasons are fixed tokens, never raw scanner output or paths.
import net from 'node:net';

export function clamdTarget(env = process.env) {
  if (env.CLAMD_SOCKET) return { path: env.CLAMD_SOCKET };
  if (env.CLAMD_HOST) return { host: env.CLAMD_HOST, port: Number(env.CLAMD_PORT || 3310) };
  return null;
}

function clamdExchange(target, send, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const s = net.createConnection(target);
    s.setTimeout(timeoutMs, () => { s.destroy(); done(reject, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    s.on('connect', () => { try { send(s); } catch (e) { s.destroy(); done(reject, e); } });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes(0)) { s.end(); done(resolve, buf.toString('utf8').replace(/\0[\s\S]*$/, '').trim()); }
    });
    s.on('error', (e) => done(reject, e));
    s.on('close', () => done(resolve, buf.toString('utf8').replace(/\0[\s\S]*$/, '').trim()));
  });
}

export async function pingClamd({ timeoutMs = Number(process.env.CLAMD_PING_TIMEOUT_MS || 2000) } = {}) {
  const t = clamdTarget();
  if (!t) return { ok: false, reason: 'not_configured' };
  try {
    return (await clamdExchange(t, (s) => s.write('zPING\0'), timeoutMs)) === 'PONG' ? { ok: true } : { ok: false, reason: 'unexpected_reply' };
  } catch (e) {
    return { ok: false, reason: e.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable' };
  }
}

const CHUNK = 64 * 1024;
export async function scanBuffer(buffer) {
  const t = clamdTarget();
  if (!t) return { status: 'failed', reason: 'scanner_not_configured' };
  try {
    const reply = await clamdExchange(t, (s) => {
      s.write('zINSTREAM\0');
      for (let i = 0; i < buffer.length; i += CHUNK) {
        const c = buffer.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4); len.writeUInt32BE(c.length);
        s.write(len); s.write(c);
      }
      s.write(Buffer.alloc(4));
    }, Number(process.env.CLAMD_SCAN_TIMEOUT_MS || 15000));
    if (reply === 'stream: OK') return { status: 'clean' };
    const m = /^stream: (.+) FOUND$/.exec(reply);
    if (m) return { status: 'infected', signature: m[1].slice(0, 200) };
    return { status: 'failed', reason: /ERROR$/.test(reply) ? 'scanner_error' : 'unexpected_reply' };
  } catch (e) {
    return { status: 'failed', reason: e.code === 'ETIMEDOUT' ? 'scan_timeout' : 'scanner_unavailable' };
  }
}
