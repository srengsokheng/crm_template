import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { subscriberCount } from '../src/inbox/events.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

let base = '';
beforeAll(async () => {
  const app = await getApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => { await (await getApp()).close(); await pool.end(); });

async function login(email: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'crm' }, body: JSON.stringify({ email, password: 'password123' }) });
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('crm_session='))!;
}

/** Opens the event stream and records the conversation ids it announces. */
function stream(cookie: string): Promise<{ status: number; ids: number[]; close: () => void; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/v1/inbox/events`, { headers: { cookie } }, (res) => {
      const ids: number[] = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        for (const m of buf.matchAll(/data: \{"conversationId":(\d+)\}\n\n/g)) ids.push(Number(m[1]));
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      });
      resolve({ status: res.statusCode!, ids, close: () => req.destroy(), res });
    });
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('inbox real-time events', () => {
  it('announces changed conversations only to users who may see them', async () => {
    const admin = await signup();
    const rep = await inviteUser(admin.c, 'Sales rep', 'Rita');
    const outsider = await signup();
    const noInbox = await (async () => { await admin.c.post('/roles', { name: 'No inbox', grants: { contact: { view: 'all' } } }); return inviteUser(admin.c, 'No inbox', 'Nora'); })();
    const ch = (await admin.c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;

    const sa = await stream(await login(admin.email));
    const sr = await stream(await login(rep.email));
    const so = await stream(await login(outsider.email));
    expect([sa.status, sr.status, so.status]).toEqual([200, 200, 200]);
    expect(sa.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const denied = await stream(await login(noInbox.email));
    expect(denied.status).toBe(403);
    denied.close();

    // A visitor writes: the admin and the rep (unassigned = everyone's) hear about it; the other workspace doesn't.
    const visit = (body: unknown) => fetch(`${base}/api/v1/public/webchat/${ch.publicKey}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = await (await visit({ body: 'Hello', name: 'Grace' })).json();
    await settle();
    const conv = (await admin.c.get('/inbox/conversations')).body.data[0];
    expect(sa.ids).toEqual([conv.id]);
    expect(sr.ids).toEqual([conv.id]);
    expect(so.ids).toEqual([]);

    // Assigned to the admin (not in the rep's team): further changes reach the admin only.
    await admin.c.patch(`/inbox/conversations/${conv.id}`, { assigneeId: admin.me.user.id });
    await visit({ token: first.token, body: 'Still there?' });
    await admin.c.post(`/inbox/conversations/${conv.id}/messages`, { body: 'Yes!' });
    await admin.c.post(`/inbox/conversations/${conv.id}/read`);
    await settle();
    expect(sa.ids).toEqual([conv.id, conv.id, conv.id, conv.id, conv.id]);
    expect(sr.ids).toEqual([conv.id]);
    expect(so.ids).toEqual([]);

    // Closing the stream unsubscribes.
    const before = subscriberCount();
    sa.close(); sr.close(); so.close();
    await settle();
    expect(subscriberCount()).toBe(before - 3);
  });
});
