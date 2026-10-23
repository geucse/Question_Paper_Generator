// A minimal clamd for tests: speaks the zPING / zINSTREAM protocol on 127.0.0.1 (random port unless one is given;
// the smoke test uses a fixed one that run-checks.sh also gives the server).
// reply(buffer) decides the INSTREAM answer; mode 'hang' never answers; 'garbage' answers nonsense.
import net from 'node:net';

export async function startFakeClamd({ reply = () => 'stream: OK', mode = 'normal', port: wantPort = 0 } = {}) {
  const state = { received: [], pings: 0, mode, reply };
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (state.mode === 'hang') return;
      if (buf.subarray(0, 6).toString() === 'zPING\0') {
        state.pings += 1;
        sock.end(state.mode === 'garbage' ? 'HELLO\0' : 'PONG\0');
        return;
      }
      if (buf.subarray(0, 10).toString() === 'zINSTREAM\0') {
        // Parse 4-byte big-endian length-prefixed chunks until a zero length.
        let off = 10; const chunks = [];
        while (off + 4 <= buf.length) {
          const len = buf.readUInt32BE(off);
          if (len === 0) {
            const data = Buffer.concat(chunks);
            state.received.push(data);
            sock.end(`${state.mode === 'garbage' ? 'what?' : state.reply(data)}\0`);
            return;
          }
          if (off + 4 + len > buf.length) return; // wait for more bytes
          chunks.push(buf.subarray(off + 4, off + 4 + len));
          off += 4 + len;
        }
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(wantPort, '127.0.0.1', r); });
  const port = server.address().port;
  return {
    port, state,
    env: () => { process.env.CLAMD_HOST = '127.0.0.1'; process.env.CLAMD_PORT = String(port); },
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
