import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** Sends 21 website-chat messages (limit: 20 a minute per address), each claiming a different address. */
async function burst(app: Awaited<ReturnType<typeof buildApp>>, key: string) {
  const codes: number[] = [];
  for (let i = 0; i < 21; i++) {
    const r = await app.inject({ method: 'POST', url: `/api/v1/public/webchat/${key}/messages`, remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` }, payload: JSON.stringify({ body: `hi ${i}` }) });
    codes.push(r.statusCode);
  }
  return codes;
}

describe('client address for rate limits (TRUST_PROXY)', () => {
  it('by default ignores X-Forwarded-For, so a client can\'t dodge rate limits by faking it', async () => {
    expect(config.trustProxy).toBe(false);
    const { c } = await signup();
    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const codes = await burst(await getApp(), ch.publicKey);
    expect(codes.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('behind a configured proxy, uses the forwarded client address', async () => {
    const { c } = await signup();
    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const prev = config.trustProxy;
    config.trustProxy = ['127.0.0.1'];
    const app = await buildApp({ logger: false });
    try {
      const codes = await burst(app, ch.publicKey);
      expect(codes.every((s) => s === 201)).toBe(true); // 21 different real clients behind the proxy
    } finally { config.trustProxy = prev; await app.close(); }
  });
});
