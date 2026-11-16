import net from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { setFileStore } from '../src/lib/files.ts';
import { s3Store, signV4 } from '../src/lib/s3.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
afterEach(() => { config.files.clamav.host = ''; setFileStore(null); });

describe('S3 signing (AWS Signature V4)', () => {
  it('matches the GET Object example from the AWS documentation', () => {
    const h = signV4({
      method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z', payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      headers: { Range: 'bytes=0-9' },
    });
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

/** An in-memory S3 behind a fake fetch: records requests, stores objects by URL path. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ method, url: url.toString(), auth: headers.get('authorization') });
    if (!headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=test-key/')) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    if (method === 'PUT') { objects.set(url.pathname, Buffer.from(init!.body as Uint8Array)); return new Response('', { status: 200 }); }
    if (method === 'GET') { const o = objects.get(url.pathname); return o ? new Response(new Uint8Array(o)) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }); }
    objects.delete(url.pathname);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { objects, calls, fetchImpl };
}
const cfg = { endpoint: 'https://s3.example.test', region: 'eu-central-1', bucket: 'crm-files', accessKeyId: 'test-key', secretAccessKey: 'test-secret', forcePathStyle: true, prefix: 'crm/' };

describe('S3 storage', () => {
  it('stores, reads and deletes objects (path style and virtual-host style URLs)', async () => {
    const s3 = fakeS3();
    const store = s3Store(cfg, s3.fetchImpl);
    await store.put('7/abc', Buffer.from('hello'));
    expect(s3.calls[0]).toMatchObject({ method: 'PUT', url: 'https://s3.example.test/crm-files/crm/7/abc' });
    expect(s3.calls[0].auth).toMatch(/^AWS4-HMAC-SHA256 Credential=test-key\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect((await store.get('7/abc'))!.toString()).toBe('hello');
    expect(await store.get('7/missing')).toBeNull();
    await store.remove('7/abc');
    expect(s3.objects.size).toBe(0);
    const vhost = fakeS3();
    await s3Store({ ...cfg, forcePathStyle: false, prefix: '' }, vhost.fetchImpl).put('1/x', Buffer.from('y'));
    expect(vhost.calls[0].url).toBe('https://crm-files.s3.example.test/1/x');
    // Errors carry the S3 error code, not the body.
    const bad = s3Store({ ...cfg, accessKeyId: 'wrong' }, s3.fetchImpl);
    await expect(bad.put('1/y', Buffer.from('z'))).rejects.toThrow('Storage upload failed: HTTP 403 AccessDenied');
  });

  it('attachments work end to end on S3 storage', async () => {
    const s3 = fakeS3();
    setFileStore(s3Store(cfg, s3.fetchImpl));
    const { c } = await signup();
    const d = (await c.post('/deals', { title: 'S3 deal' })).body;
    const up = (await c.upload(`/attachments?entityType=deal&entityId=${d.id}&fileName=a.pdf`, Buffer.from('%PDF-1.4 s3'))).body;
    const [row] = await q<{ storage_key: string }>(sql`SELECT storage_key FROM attachments WHERE id = ${up.id}`);
    expect([...s3.objects.keys()]).toEqual([`/crm-files/crm/${row.storage_key}`]);
    expect((await c.download(`/attachments/${up.id}`)).body.toString()).toBe('%PDF-1.4 s3');
    await c.del(`/attachments/${up.id}`);
    expect(s3.objects.size).toBe(0);
  });
});

/** Fake clamd: answers INSTREAM with OK, or FOUND when the stream contains "EICAR". */
async function fakeClamd() {
  let connections = 0;
  const server = net.createServer((sock) => {
    connections++;
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, Buffer.from(d)]);
      // Done when the zero-length terminator arrived (last 4 bytes are 0 after at least the command).
      if (buf.length >= 14 && buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) {
        sock.end(buf.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close(), get connections() { return connections; } };
}

describe('virus scanning', () => {
  it('stores clean files, refuses flagged ones (audited, nothing stored), fails closed when the scanner is down', async () => {
    const clamd = await fakeClamd();
    config.files.clamav.host = '127.0.0.1';
    config.files.clamav.port = clamd.port;
    try {
      const { c } = await signup();
      const d = (await c.post('/deals', { title: 'Scanned' })).body;
      const base = `/attachments?entityType=deal&entityId=${d.id}`;
      const ok = await c.upload(`${base}&fileName=clean.pdf`, Buffer.from('%PDF-1.4 fine'));
      expect(ok.status).toBe(201);
      expect((await c.get(base)).body.scanned).toBe(true);

      const bad = await c.upload(`${base}&fileName=invoice.exe`, Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'));
      expect(bad.status).toBe(422);
      expect(bad.body.error).toMatchObject({ code: 'FILE_INFECTED', message: '“invoice.exe” was flagged by the virus scanner (Eicar-Test-Signature) and was not uploaded.' });
      expect((await c.get(base)).body.data.map((f: any) => f.fileName)).toEqual(['clean.pdf']);
      const hist = (await c.get(`/history/deal/${d.id}`)).body.data.find((h: any) => h.action === 'file_blocked');
      expect(hist.changes).toMatchObject({ file: { name: 'invoice.exe' }, signature: 'Eicar-Test-Signature' });

      // A viewer is refused before anything is sent to the scanner.
      const viewer = await inviteUser(c, 'Viewer');
      const before = clamd.connections;
      expect((await viewer.c.upload(`${base}&fileName=x.pdf`, Buffer.from('x'))).status).toBe(403);
      expect(clamd.connections).toBe(before);

      // Scanner down → refused (fail closed).
      clamd.close();
      config.files.clamav.port = 1; // nothing listens there
      const down = await c.upload(`${base}&fileName=later.pdf`, Buffer.from('%PDF'));
      expect(down.status).toBe(503);
      expect(down.body.error.code).toBe('SCANNER_UNAVAILABLE');
    } finally { clamd.close(); }
  });
});
