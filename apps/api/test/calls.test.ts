import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { callSubscriberCount, endEmptyCalls, MAX_PEERS } from '../src/calls/calls.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

let base = '';
beforeAll(async () => {
  const app = await getApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => { await (await getApp()).close(); await pool.end(); });

type Ev = { event: string; data: any };
/** Opens an event stream and records its events. */
function stream(url: string, cookie = ''): Promise<{ status: number; events: Ev[]; close: () => void; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: cookie ? { cookie } : {} }, (res) => {
      const events: Ev[] = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)) events.push({ event: m[1], data: JSON.parse(m[2]) });
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      });
      resolve({ status: res.statusCode!, events, close: () => req.destroy(), res });
    });
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}
async function login(email: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'crm' }, body: JSON.stringify({ email, password: 'password123' }) });
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('crm_session='))!;
}
const pub = (path: string, body?: unknown) => fetch(`${base}/api/v1/public/calls/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const settle = () => new Promise((r) => setTimeout(r, 300));
const tokenOf = (guestUrl: string) => guestUrl.split('/join/')[1];

describe('video calls', () => {
  it('starts calls on their own, on a meeting, or from a conversation; only people who may see them get in', async () => {
    const admin = await signup('Sreng Sokheng');
    const c = admin.c;
    const solo = await c.post('/calls', {});
    expect(solo.status).toBe(201);
    expect(solo.body).toMatchObject({ title: 'Video call', status: 'open' });
    expect(solo.body.guestUrl).toMatch(/\/join\/[A-Za-z0-9_-]{32}$/);
    const row = (await pool.query('SELECT guest_token_hash, guest_token_sealed FROM calls WHERE id = $1', [solo.body.id])).rows[0];
    expect(JSON.stringify(row)).not.toContain(tokenOf(solo.body.guestUrl)); // stored hashed and encrypted only
    expect((await c.get(`/calls/${solo.body.id}`)).body.guestUrl).toBe(solo.body.guestUrl); // the team can copy it again

    const meeting = (await c.post('/activities', { kind: 'meeting', subject: 'Demo for Umbrella Foods' })).body;
    const onMeeting = await c.post('/calls', { activityId: meeting.id });
    expect(onMeeting.body).toMatchObject({ title: 'Demo for Umbrella Foods', activityId: meeting.id });

    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    await fetch(`${base}/api/v1/public/webchat/${ch.publicKey}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Hi', name: 'Grace' }) });
    const conv = (await c.get('/inbox/conversations')).body.data[0];
    expect((await c.post('/calls', { conversationId: conv.id })).body.title).toBe('Call with Grace');

    // Viewers can read the conversation but not invite the customer; other workspaces see nothing.
    const viewer = await inviteUser(c, 'Viewer');
    expect((await viewer.c.post('/calls', { conversationId: conv.id })).status).toBe(403);
    const other = await signup();
    expect((await other.c.get(`/calls/${solo.body.id}`)).status).toBe(404);
    expect((await other.c.post(`/calls/${solo.body.id}/join`)).status).toBe(404);
    expect((await other.c.post('/calls', { activityId: meeting.id })).status).toBe(404);
    // A made-up guest link finds nothing.
    expect((await pub('x'.repeat(32))).status).toBe(404);
    expect((await pub(tokenOf(solo.body.guestUrl))).status).toBe(200);
  });

  it('relays set-up messages only to the participant they are for, and keeps everyone’s list of participants current', async () => {
    const admin = await signup('Sreng Sokheng');
    const call = (await admin.c.post('/calls', { title: 'Quote review' })).body;
    const tok = tokenOf(call.guestUrl);
    const other = (await admin.c.post('/calls', {})).body;
    expect((await (await pub(tok)).json())).toMatchObject({ title: 'Quote review', status: 'open', host: 'Sreng Sokheng Inc' });

    // The host joins and opens the stream (with their session); a guest joins with the link; a second guest too.
    const host = (await admin.c.post(`/calls/${call.id}/join`)).body;
    expect(host).toMatchObject({ peers: [], iceServers: expect.any(Array) });
    const cookie = await login(admin.email);
    const hs = await stream(`${base}/api/v1/calls/${call.id}/events?peer=${host.peerId}&secret=${host.secret}`, cookie);
    expect(hs.status).toBe(200);
    expect((await stream(`${base}/api/v1/calls/${call.id}/events?peer=${host.peerId}&secret=wrong-secret-xxxxxxxxxxxxxx`, cookie)).status).toBe(403);
    expect((await pub(`${tok}/join`, { name: '' })).status).toBe(400);
    const guest = await (await pub(`${tok}/join`, { name: 'Grace' })).json();
    expect(guest.peers.map((p: any) => p.name)).toEqual(['Sreng Sokheng']);
    const gs = await stream(`${base}/api/v1/public/calls/${tok}/events?peer=${guest.peerId}&secret=${guest.secret}`);
    const guest2 = await (await pub(`${tok}/join`, { name: 'Dara' })).json();
    const g2s = await stream(`${base}/api/v1/public/calls/${tok}/events?peer=${guest2.peerId}&secret=${guest2.secret}`);
    await settle();
    const lastPeers = (s: { events: Ev[] }) => s.events.filter((e) => e.event === 'peers').at(-1)!.data.peers.map((p: any) => `${p.name}${p.guest ? ' (guest)' : ''}`);
    expect(lastPeers(hs)).toEqual(['Sreng Sokheng', 'Grace (guest)', 'Dara (guest)']);

    // Grace sends an offer to the host: only the host gets it, from Grace.
    const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
    const sent = await pub(`${tok}/signal`, { peer: guest.peerId, secret: guest.secret, to: host.peerId, kind: 'offer', data: offer });
    expect(sent.status).toBe(204);
    await admin.c.post(`/calls/${call.id}/signal`, { peer: host.peerId, secret: host.secret, to: guest.peerId, kind: 'answer', data: { type: 'answer', sdp: 'v=0' } });
    await settle();
    const signals = (s: { events: Ev[] }) => s.events.filter((e) => e.event === 'signal').map((e) => e.data);
    expect(signals(hs)).toEqual([{ from: guest.peerId, kind: 'offer', data: offer }]);
    expect(signals(gs)).toEqual([{ from: host.peerId, kind: 'answer', data: { type: 'answer', sdp: 'v=0' } }]);
    expect(signals(g2s)).toEqual([]);

    // Not to people in another call; not with a wrong secret; not to someone who isn't there.
    expect((await pub(`${tok}/signal`, { peer: guest.peerId, secret: 'x'.repeat(32), to: host.peerId, kind: 'offer', data: offer })).status).toBe(403);
    const elsewhere = (await admin.c.post(`/calls/${other.id}/join`)).body;
    expect((await pub(`${tok}/signal`, { peer: guest.peerId, secret: guest.secret, to: elsewhere.peerId, kind: 'offer', data: offer })).status).toBe(404);
    expect((await pub(`${tok}/signal`, { peer: guest.peerId, secret: guest.secret, to: host.peerId, kind: 'offer', data: { sdp: 'x'.repeat(40_000) } })).status).toBe(400);

    // Leaving (closing the page) updates everyone's list.
    g2s.close();
    await settle();
    expect(lastPeers(hs)).toEqual(['Sreng Sokheng', 'Grace (guest)']);
    hs.close(); gs.close();
    await settle();
    expect(callSubscriberCount()).toBe(0);
  });

  it('ends: the host ends it for everyone, or it ends a minute after the last person left; the meeting gets the length', async () => {
    const admin = await signup('Sreng Sokheng');
    const rep = await inviteUser(admin.c, 'Sales rep', 'Rita');
    const meeting = (await admin.c.post('/activities', { kind: 'meeting', subject: 'Site visit follow-up' })).body;
    const call = (await admin.c.post('/calls', { activityId: meeting.id })).body;
    const tok = tokenOf(call.guestUrl);
    const host = (await admin.c.post(`/calls/${call.id}/join`)).body;
    const guest = await (await pub(`${tok}/join`, { name: 'Grace' })).json();
    const gs = await stream(`${base}/api/v1/public/calls/${tok}/events?peer=${guest.peerId}&secret=${guest.secret}`);
    await pool.query(`UPDATE calls SET started_at = now() - interval '12 minutes' WHERE id = $1`, [call.id]);

    expect((await rep.c.post(`/calls/${call.id}/end`)).status).toBe(404); // the rep can't see the admin's meeting, nor its call
    const open = (await admin.c.post('/calls', {})).body; // a call on its own: anyone in the workspace with the link
    expect((await rep.c.get(`/calls/${open.id}`)).status).toBe(200);
    expect((await rep.c.post(`/calls/${open.id}/end`)).status).toBe(403); // but only the host (or an admin) ends it
    const ended = await admin.c.post(`/calls/${call.id}/end`);
    expect(ended.body).toMatchObject({ status: 'ended', minutes: 12 });
    await settle();
    expect(gs.events.some((e) => e.event === 'ended')).toBe(true);
    const a = (await pool.query('SELECT status, duration_minutes, outcome, completed_by FROM activities WHERE id = $1', [meeting.id])).rows[0];
    expect(a).toEqual({ status: 'done', duration_minutes: 12, outcome: 'Video call, 12 min, with Grace, Sreng Sokheng', completed_by: admin.me.user.id });
    expect((await pub(`${tok}/join`, { name: 'Late' })).status).toBe(410);
    expect((await admin.c.post(`/calls/${call.id}/join`)).status).toBe(410);
    expect((await (await pub(tok)).json()).status).toBe('ended');
    gs.close();
    void host;

    // A call everyone left ends by itself (after the grace period), timed until the last person left.
    const c2 = (await admin.c.post('/calls', {})).body;
    const p = (await admin.c.post(`/calls/${c2.id}/join`)).body;
    await admin.c.post(`/calls/${c2.id}/leave`, { peer: p.peerId, secret: p.secret });
    expect((await admin.c.get(`/calls/${c2.id}`)).body.status).toBe('open'); // a refreshed page can still rejoin
    await pool.query(`UPDATE call_peers SET left_at = now() - interval '2 minutes' WHERE call_id = $1`, [c2.id]);
    await pool.query(`UPDATE calls SET started_at = now() - interval '7 minutes' WHERE id = $1`, [c2.id]);
    expect((await endEmptyCalls(60)).map((x) => x.id)).toContain(c2.id);
    expect((await admin.c.get(`/calls/${c2.id}`)).body).toMatchObject({ status: 'ended', minutes: 5 });
  });

  it(`holds up to ${MAX_PEERS} people`, async () => {
    const admin = await signup();
    const call = (await admin.c.post('/calls', {})).body;
    const tok = tokenOf(call.guestUrl);
    for (let i = 0; i < MAX_PEERS; i++) expect((await pub(`${tok}/join`, { name: `Guest ${i}` })).status).toBe(200);
    const full = await pub(`${tok}/join`, { name: 'One too many' });
    expect(full.status).toBe(409);
    expect((await full.json()).error.message).toMatch(/up to 6 people/);
  });
});
