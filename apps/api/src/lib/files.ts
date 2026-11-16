/**
 * File storage for attachments: disk (FILES_DIR, outside the web root; default) or any S3-compatible service
 * (FILES_STORAGE=s3, see lib/s3.ts). Keys are generated here — never built from user input.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { config } from '../config.ts';
import { s3Store } from './s3.ts';

export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

function diskStore(root: string): FileStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    const p = resolve(join(base, key));
    if (!p.startsWith(base + sep)) throw new Error('Invalid storage key'); // defence in depth: keys are server-generated
    return p;
  };
  return {
    async put(key, data) { const p = pathOf(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data, { flag: 'wx' }); },
    async get(key) { try { return await readFile(pathOf(key)); } catch { return null; } },
    async remove(key) { await rm(pathOf(key), { force: true }); },
  };
}

let store: FileStore | null = null;
export function files(): FileStore {
  if (store) return store;
  if (config.files.storage === 's3') {
    const c = config.files.s3;
    const missing = (['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).filter((k) => !c[k]);
    if (missing.length) throw new Error(`FILES_STORAGE=s3 needs ${missing.map((m) => ({ endpoint: 'S3_ENDPOINT', bucket: 'S3_BUCKET', accessKeyId: 'S3_ACCESS_KEY_ID', secretAccessKey: 'S3_SECRET_ACCESS_KEY' })[m]).join(', ')}`);
    store = s3Store(c);
  } else store = diskStore(config.files.dir);
  return store;
}
/** What admins may see about storage — never credentials. */
export function storageStatus() {
  return config.files.storage === 's3'
    ? { storage: 's3' as const, location: `${config.files.s3.bucket} at ${new URL(config.files.s3.endpoint || 'https://invalid').host}`, scanning: !!config.files.clamav.host }
    : { storage: 'disk' as const, location: 'server disk', scanning: !!config.files.clamav.host };
}
/** Tests: use another store (e.g. a temp dir). */
export function setFileStore(s: FileStore | null) { store = s; }

export const newStorageKey = (workspaceId: number) => `${workspaceId}/${randomUUID()}`;

/** Images that are safe to show inline (no SVG: it can carry scripts). */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
