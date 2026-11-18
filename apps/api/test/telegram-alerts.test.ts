import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { pool } from '../src/db/pool.ts';
import { pollTelegram } from '../src/inbox/telegram.ts';
import { pushNotifications } from '../src/inbox/teamAlerts.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

/** A fake Telegram Bot API (tokens 7100…); chat 403 has blocked the bot. */
const fake = { updates: new Map<string, any[]>(), sent: [] as any[] };
let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      const reply = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (!m || !m[1].startsWith('7100')) return reply(401, { ok: false, description: 'Unauthorized' });
      const [, token, method] = m;
      const p = raw ? JSON.parse(raw) : {};
      if (method === 'getMe') return reply(200, { ok: true, result: { id: Number(token.split(':')[0]), is_bot: true, first_name: 'Acme Bot', username: `acme${token.slice(4, 7)}_bot` } });
      if (method === 'deleteWebhook') return reply(200, { ok: true, result: true });
      if (method === 'getUpdates') return reply(200, { ok: true, result: (fake.updates.get(token) ?? []).filter((u) => u.update_id >= (p.offset ?? 0)) });
      if (method === 'sendMessage') {
        if (String(p.chat_id) === '403') return reply(403, { ok: false, description: 'Forbidden: bot was blocked by the user' });
        fake.sent.push({ token, ...p });
        return reply(200, { ok: true, result: { message_id: fake.sent.length, chat: { id: p.chat_id } } });
      }
      reply(404, { ok: false, description: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.telegram.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await (await getApp()).close(); await pool.end(); });

let uid = 1;
const start = (token: string, chatId: number, text: string, from = { id: chatId, first_name: 'Rita', last_name: 'Rep' }) =>
  fake.updates.set(token, [...(fake.updates.get(token) ?? []), { update_id: uid++, message: { message_id: uid * 10, date: 1, chat: { id: chatId, type: 'private', first_name: from.first_name }, from, text } }]);
const sentTo = (chatId: number) => fake.sent.filter((s) => String(s.chat_id) === String(chatId)).map((s) => s.text);

describe('team notifications on Telegram', () => {
  it('a person connects their Telegram with a one-time link; then their notifications arrive there', async () => {
    const { c } = await signup();
    const rita = await inviteUser(c, 'Sales rep', 'Rita');
    // No bot yet: explained.
    expect((await rita.c.get('/account/telegram')).body).toEqual({ available: false, botUsername: null, linked: null });
    expect((await rita.c.post('/account/telegram/link')).status).toBe(409);

    const T = '7100001:AAFakeAlertsToken_0123456789abcdef';
    await pool.query(`UPDATE channels SET status = 'disabled' WHERE kind = 'telegram_bot'`); // earlier tests' bots
    fake.updates.set(T, []);
    expect((await c.post('/channels', { kind: 'telegram_bot', token: T })).status).toBe(201);
    // A notification from before linking is not sent later.
    await pool.query(`INSERT INTO notifications (workspace_id, user_id, kind, title) VALUES ((SELECT workspace_id FROM memberships WHERE user_id = $1 LIMIT 1), $1, 'test', 'Before linking')`, [rita.id]);

    const link = (await rita.c.post('/account/telegram/link')).body;
    expect(link.url).toMatch(/^https:\/\/t\.me\/acme\w+_bot\?start=[A-Za-z0-9_-]{16}$/);
    const code = link.url.split('start=')[1];

    // A wrong code, then the right one, through the bot: answered there, and not added to the Inbox.
    start(T, 7001, '/start wrongcode123');
    start(T, 7001, `/start ${code}`);
    await pollTelegram();
    expect(sentTo(7001)).toEqual([expect.stringMatching(/expired or was already used/), expect.stringMatching(/^✅ Connected to /)]);
    expect((await c.get('/inbox/conversations')).body.data).toHaveLength(0);
    expect((await rita.c.get('/account/telegram')).body).toMatchObject({ available: true, linked: { tgName: 'Rita Rep' } });
    // The code works once.
    start(T, 7002, `/start ${code}`);
    await pollTelegram();
    expect(sentTo(7002)).toEqual([expect.stringMatching(/expired or was already used/)]);

    // Something happens for Rita (a conversation is assigned to her): it arrives on Telegram with a link.
    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const app = await getApp();
    await app.inject({ method: 'POST', url: `/api/v1/public/webchat/${ch.publicKey}/messages`, payload: { body: 'Hi', name: 'Grace' } });
    const conv = (await c.get('/inbox/conversations')).body.data[0];
    await c.patch(`/inbox/conversations/${conv.id}`, { assigneeId: rita.id });
    expect(await pushNotifications()).toBeGreaterThanOrEqual(1);
    const msgs = sentTo(7001);
    expect(msgs.at(-1)).toMatch(new RegExp(`^🔔 .*assigned you a conversation\\nGrace\\n${config.appUrl.replace(/\/$/, '')}/inbox/${conv.id}$`));
    expect(msgs.join('\n')).not.toContain('Before linking');
    expect(await pushNotifications()).toBe(0); // each notification once

    // Disconnecting stops it.
    expect((await rita.c.del('/account/telegram')).status).toBe(204);
    await pool.query(`INSERT INTO notifications (workspace_id, user_id, kind, title) VALUES ((SELECT workspace_id FROM memberships WHERE user_id = $1 LIMIT 1), $1, 'test', 'After disconnecting')`, [rita.id]);
    await pushNotifications();
    expect(sentTo(7001).join('\n')).not.toContain('After disconnecting');
  });

  it('codes are per workspace and per person; a blocked bot removes the link', async () => {
    const a = await signup();
    const b = await signup();
    await pool.query(`UPDATE channels SET status = 'disabled' WHERE kind = 'telegram_bot'`);
    const TA = '7100002:AAFakeAlertsTokenA_0123456789abcdef';
    const TB = '7100003:AAFakeAlertsTokenB_0123456789abcdef';
    fake.updates.set(TA, []); fake.updates.set(TB, []);
    await a.c.post('/channels', { kind: 'telegram_bot', token: TA });
    await b.c.post('/channels', { kind: 'telegram_bot', token: TB });
    // A's code sent to B's bot doesn't link anyone.
    const codeA = (await a.c.post('/account/telegram/link')).body.url.split('start=')[1];
    start(TB, 8001, `/start ${codeA}`);
    await pollTelegram();
    expect(sentTo(8001)).toEqual([expect.stringMatching(/expired/)]);
    expect((await a.c.get('/account/telegram')).body.linked).toBeNull();

    // Linked to chat 403, which blocks the bot: the first failed send removes the link.
    start(TA, 403, `/start ${codeA}`);
    await pollTelegram();
    expect((await a.c.get('/account/telegram')).body.linked).not.toBeNull();
    await pool.query(`INSERT INTO notifications (workspace_id, user_id, kind, title) VALUES ((SELECT workspace_id FROM memberships WHERE user_id = $1 LIMIT 1), $1, 'test', 'Hello')`, [a.me.user.id]);
    await pushNotifications();
    expect((await a.c.get('/account/telegram')).body.linked).toBeNull();
  });
});
