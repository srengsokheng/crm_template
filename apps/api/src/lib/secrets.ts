/**
 * Encrypts credentials kept in the database (Telegram bot tokens, later other channel credentials) with AES-256-GCM.
 * The key comes from SECRETS_KEY; outside production a random key is created once in data/secrets.key so development
 * works without setup. Losing the key means reconnecting the channels — the data itself is not affected.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.ts';
import { AppError } from './errors.ts';

let cached: Buffer | null = null;

function parseKey(v: string): Buffer | null {
  const t = v.trim();
  const b = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  return b.length === 32 ? b : null;
}

function key(): Buffer {
  if (cached) return cached;
  if (config.secretsKey) {
    const k = parseKey(config.secretsKey);
    if (!k) throw new AppError(500, 'SECRETS_KEY_INVALID', 'SECRETS_KEY must be 32 bytes, as 64 hex characters or base64');
    return (cached = k);
  }
  if (config.isProd) throw new AppError(503, 'SECRETS_KEY_MISSING', 'The server has no SECRETS_KEY set, so it cannot store channel credentials. Ask your administrator.');
  const file = config.secretsKeyFile;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    try { writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } // another process created it first
  }
  const k = parseKey(readFileSync(file, 'utf8'));
  if (!k) throw new AppError(500, 'SECRETS_KEY_INVALID', `${file} does not hold a valid 32-byte key`);
  return (cached = k);
}

/** "v1:" + base64(iv 12 | tag 16 | ciphertext). */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function openSecret(sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('Unknown secret format');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
