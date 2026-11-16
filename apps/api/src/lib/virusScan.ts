/**
 * Virus scanning of uploads with ClamAV's daemon (clamd) over TCP, INSTREAM command — no dependency.
 * Off unless CLAMAV_HOST is set. When on, it fails closed: if clamd can't be reached the upload is refused.
 */
import net from 'node:net';

export type ScanResult = { clean: true } | { clean: false; signature: string };

export class ScannerUnavailable extends Error {}

/** Send the bytes to clamd and read its verdict ("stream: OK" or "stream: <name> FOUND"). */
export function scanBuffer(data: Buffer, o: { host: string; port: number; timeoutMs?: number }): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    let reply = '';
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; sock.destroy(); fn(); } };
    const sock = net.createConnection({ host: o.host, port: o.port });
    sock.setTimeout(o.timeoutMs ?? 30_000);
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const CHUNK = 64 * 1024;
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk = end of stream
    });
    sock.on('data', (d) => {
      reply += d.toString('utf8');
      if (!reply.includes('\0') && !reply.includes('\n')) return;
      const line = reply.replace(/[\0\n]+$/, '').trim();
      if (/:\s*OK$/.test(line)) done(() => resolve({ clean: true }));
      else if (/ FOUND$/.test(line)) done(() => resolve({ clean: false, signature: line.replace(/^[^:]*:\s*/, '').replace(/ FOUND$/, '') }));
      else done(() => reject(new ScannerUnavailable(`Virus scanner error: ${line.slice(0, 200)}`)));
    });
    sock.on('timeout', () => done(() => reject(new ScannerUnavailable('Virus scanner did not answer in time'))));
    sock.on('error', (e) => done(() => reject(new ScannerUnavailable(`Virus scanner unavailable (${(e as NodeJS.ErrnoException).code ?? e.message})`))));
    sock.on('end', () => done(() => reject(new ScannerUnavailable('Virus scanner closed the connection'))));
  });
}
