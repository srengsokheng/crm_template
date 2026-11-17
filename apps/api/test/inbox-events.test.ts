import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { subscriberCount, visitorCount } from '../src/inbox/events.ts';
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

type Ev = { event: string; data: any };
/** Opens an event stream; records the conversation ids it announces and every event. */
function stream(cookie: string, url = `${base}/api/v1/inbox/events`, headers: Record<string, string> = {}): Promise<{ status: number; ids: number[]; events: Ev[]; close: () => void; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      const ids: number[] = [];
      const events: Ev[] = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)) {
          const data = JSON.parse(m[2]);
          events.push({ event: m[1], data });
          if (m[1] === 'conversation') ids.push(data.conversationId);
        }
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      });
      resolve({ status: res.statusCode!, ids, events, close: () => req.destroy(), res });
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

  it('website visitors get live replies and "typing…"; the team sees who is typing', async () => {
    const admin = await signup('Sreng Sokheng');
    const rep = await inviteUser(admin.c, 'Sales rep', 'Rita Rep');
    const viewer = await inviteUser(admin.c, 'Viewer', 'Vic');
    const outsider = await signup();
    const ch = (await admin.c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const pub = `${base}/api/v1/public/webchat/${ch.publicKey}`;
    const post = (path: string, body: unknown) => fetch(pub + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // No conversation yet (or a made-up token): no stream, no typing.
    const fake = 'x'.repeat(40);
    expect((await stream('', `${pub}/events?token=${fake}`)).status).toBe(404);
    expect((await stream('', `${pub}/events`)).status).toBe(404);
    expect((await post('/typing', { token: fake })).status).toBe(404);

    const first = await (await post('/messages', { body: 'Hi', name: 'Grace' })).json();
    const conv = (await admin.c.get('/inbox/conversations')).body.data[0];
    const v = await stream('', `${pub}/events?token=${first.token}`, { origin: 'https://shop.example' });
    expect(v.status).toBe(200);
    expect(v.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(v.res.headers['access-control-allow-origin']).toBe('*');
    // A second visitor's stream never hears about the first visitor's conversation.
    const other = await (await post('/messages', { body: 'Me too' })).json();
    const v2 = await stream('', `${pub}/events?token=${other.token}`);
    expect(v2.status).toBe(200);

    const sa = await stream(await login(admin.email));
    const sr = await stream(await login(rep.email));
    const so = await stream(await login(outsider.email));

    // The visitor types: the team sees "Grace is typing…"; the other workspace doesn't.
    expect((await post('/typing', { token: first.token })).status).toBe(204);
    // The admin types a reply: the visitor and the colleague see it, the admin's own stream doesn't.
    expect((await admin.c.post(`/inbox/conversations/${conv.id}/typing`)).status).toBe(204);
    await settle();
    const typingOf = (s: { events: Ev[] }) => s.events.filter((e) => e.event === 'typing').map((e) => e.data);
    expect(typingOf(sa)).toEqual([{ conversationId: conv.id, name: 'Grace', side: 'customer' }]);
    expect(typingOf(sr)).toEqual([{ conversationId: conv.id, name: 'Grace', side: 'customer' }, { conversationId: conv.id, name: 'Sreng', side: 'team' }]);
    expect(typingOf(so)).toEqual([]);
    expect(typingOf(v)).toEqual([{ name: 'Sreng' }]);
    expect(typingOf(v2)).toEqual([]);

    // The reply reaches the visitor's stream as "messages" (they then fetch it); not the other visitor's.
    await admin.c.post(`/inbox/conversations/${conv.id}/messages`, { body: 'Hello Grace' });
    await settle();
    expect(v.events.filter((e) => e.event === 'messages')).toHaveLength(1);
    expect(v2.events.filter((e) => e.event === 'messages')).toHaveLength(0);

    // Permissions: a viewer can't signal typing; another workspace can't even see the conversation.
    expect((await viewer.c.post(`/inbox/conversations/${conv.id}/typing`)).status).toBe(403);
    expect((await outsider.c.post(`/inbox/conversations/${conv.id}/typing`)).status).toBe(404);

    // Disabling the channel ends access for visitors.
    await admin.c.patch(`/channels/${ch.id}`, { status: 'disabled' });
    expect((await stream('', `${pub}/events?token=${first.token}`)).status).toBe(404);

    const before = visitorCount();
    v.close(); v2.close(); sa.close(); sr.close(); so.close();
    await settle();
    expect(visitorCount()).toBe(before - 2);
  });
});
