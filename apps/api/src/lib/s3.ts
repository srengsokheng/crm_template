/**
 * Minimal S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, Backblaze B2, DigitalOcean Spaces…) with
 * AWS Signature Version 4 — no SDK dependency. Only what attachments need: PUT, GET and DELETE of single objects.
 * Credentials come from the environment (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY), never from the repository.
 */
import { createHash, createHmac } from 'node:crypto';
import type { FileStore } from './files.ts';

export interface S3Config {
  endpoint: string;        // e.g. https://s3.eu-central-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com
  region: string;          // e.g. eu-central-1 ("auto" for R2)
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** true: https://endpoint/bucket/key (MinIO and most self-hosted); false: https://bucket.endpoint/key (AWS default). */
  forcePathStyle: boolean;
  /** Optional key prefix inside the bucket, e.g. "crm/". */
  prefix?: string;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding as SigV4 wants it (each path segment; "/" kept between segments). */
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs a request (SigV4, header-based). Returns the headers to send. `amzDate` is YYYYMMDDTHHMMSSZ.
 * Exported for tests (checked against AWS's documented example).
 */
export function signV4(o: {
  method: string; url: URL; region: string; service?: string; accessKeyId: string; secretAccessKey: string;
  amzDate: string; payloadHash: string; headers?: Record<string, string>;
}): Record<string, string> {
  const service = o.service ?? 's3';
  const date = o.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...(o.headers ?? {}), host: o.url.host, 'x-amz-content-sha256': o.payloadHash, 'x-amz-date': o.amzDate };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalQuery = [...o.url.searchParams.entries()].map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`).sort().join('&');
  const canonicalRequest = [
    o.method, o.url.pathname, canonicalQuery,
    names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), o.payloadHash,
  ].join('\n');
  const scope = `${date}/${o.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

export function s3Store(cfg: S3Config, fetchImpl: typeof fetch = fetch): FileStore {
  const base = new URL(cfg.endpoint);
  const urlOf = (key: string) => {
    const path = `${cfg.prefix ?? ''}${key}`.split('/').map(encodeSegment).join('/');
    return cfg.forcePathStyle
      ? new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/${encodeSegment(cfg.bucket)}/${path}`)
      : new URL(`${base.protocol}//${cfg.bucket}.${base.host}${base.pathname.replace(/\/$/, '')}/${path}`);
  };
  const call = async (method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer) => {
    const url = urlOf(key);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const extra: Record<string, string> = body ? { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } : {};
    const headers = signV4({ method, url, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate, payloadHash: sha256hex(body ?? ''), headers: extra });
    delete headers.host; // set by fetch
    return fetchImpl(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) });
  };
  const fail = async (what: string, res: Response): Promise<never> => {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(`Storage ${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
  };
  return {
    async put(key, data) { const res = await call('PUT', key, data); if (!res.ok) await fail('upload', res); await res.arrayBuffer(); },
    async get(key) {
      const res = await call('GET', key);
      if (res.status === 404) { await res.arrayBuffer(); return null; }
      if (!res.ok) await fail('download', res);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(key) { const res = await call('DELETE', key); if (!res.ok && res.status !== 404) await fail('delete', res); await res.arrayBuffer(); },
  };
}
