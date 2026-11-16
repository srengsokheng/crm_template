/**
 * File storage for attachments. Disk is the default (FILES_DIR, outside the web root); the small interface makes it
 * easy to add S3-compatible storage later. Keys are generated here — never built from user input.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { config } from '../config.ts';

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
export function files(): FileStore { return (store ??= diskStore(config.files.dir)); }
/** Tests: use another store (e.g. a temp dir). */
export function setFileStore(s: FileStore | null) { store = s; }

export const newStorageKey = (workspaceId: number) => `${workspaceId}/${randomUUID()}`;

/** Images that are safe to show inline (no SVG: it can carry scripts). */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
