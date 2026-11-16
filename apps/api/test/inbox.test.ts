import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { pool } from '../src/db/pool.ts';
import { processJobs } from '../src/automation/engine.ts';
import { pollTelegram } from '../src/inbox/telegram.ts';
import { openSecret, sealSecret } from '../src/lib/secrets.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

/**
 * A fake Telegram Bot API: valid tokens start with the bot id 7000…; updates are queued per token; sendMessage to the
 * chat "403" fails like a bot blocked by the user.
 */
const TOKEN = '7000001:AAFakeTokenForTestsOnly_0123456789';
const TOKEN2 = '7000002:AAAnotherFakeTokenForTests_98765432';
const fake = { updates: new Map<string, any[]>(), sent: [] as any[], webhooks: [] as any[], calls: [] as string[], nextMessageId: 500 };
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!m || !m[1].startsWith('7000')) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const [, token, method] = m;
      const p = raw ? JSON.parse(raw) : {};
      fake.calls.push(method);
      if (method === 'getMe') return reply(200, { ok: true, result: { id: Number(token.split(':')[0]), is_bot: true, first_name: 'Acme Bot', username: `acme_${token.slice(4, 7)}_bot` } });
      if (method === 'setWebhook') { fake.webhooks.push(p); return reply(200, { ok: true, result: true }); }
      if (method === 'deleteWebhook') return reply(200, { ok: true, result: true });
      if (method === 'getUpdates') return reply(200, { ok: true, result: (fake.updates.get(token) ?? []).filter((u) => u.update_id >= (p.offset ?? 0)) });
      if (method === 'sendMessage') {
        if (String(p.chat_id) === '403') return reply(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
        fake.sent.push(p);
        return reply(200, { ok: true, result: { message_id: fake.nextMessageId++, chat: { id: p.chat_id }, text: p.text } });
      }
      reply(404, { ok: false, description: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.telegram.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await (await getApp()).close(); await pool.end(); });

let updateId = 1;
const tgMessage = (token: string, chat: Record<string, unknown>, from: Record<string, unknown>, extra: Record<string, unknown>) => {
  const u = { update_id: updateId++, message: { message_id: updateId * 10, date: 1, chat, from, ...extra } };
  fake.updates.set(token, [...(fake.updates.get(token) ?? []), u]);
  return u;
};
const ada = { id: 111, first_name: 'Ada', last_name: 'Lovelace', username: 'ada_l' };

describe('inbox channels (admin)', () => {
  it('connects website chat and Telegram bots; tokens are encrypted and never returned', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.get('/channels')).status).toBe(403);
    expect((await rep.c.post('/channels', { kind: 'webchat', name: 'Site' })).status).toBe(403);

    const web = await c.post('/channels', { kind: 'webchat', name: 'Website', greeting: 'Hello!', color: '#112233' });
    expect(web.status, JSON.stringify(web.body)).toBe(201);
    expect(web.body).toMatchObject({ kind: 'webchat', name: 'Website', status: 'active', config: { greeting: 'Hello!', color: '#112233', allowedOrigins: [] } });
    expect(web.body.publicKey).toMatch(/^[0-9a-f]{32}$/);

    const bad = await c.post('/channels', { kind: 'telegram_bot', token: '9999999:AAWrongTokenWrongTokenWrong123' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/did not accept this token/);
    expect((await c.post('/channels', { kind: 'telegram_bot', token: 'nonsense' })).status).toBe(400);

    const bot = await c.post('/channels', { kind: 'telegram_bot', token: TOKEN });
    expect(bot.status, JSON.stringify(bot.body)).toBe(201);
    expect(bot.body).toMatchObject({ kind: 'telegram_bot', name: '@acme_001_bot', config: { username: 'acme_001_bot', botName: 'Acme Bot', mode: 'polling' } });
    expect(JSON.stringify(bot.body)).not.toContain('AAFakeToken');
    const row = (await pool.query('SELECT secret, webhook_secret FROM channels WHERE id = $1', [bot.body.id])).rows[0];
    expect(row.secret).toMatch(/^v1:/);
    expect(row.secret).not.toContain('AAFakeToken');
    expect(openSecret(row.secret)).toBe(TOKEN);
    expect((await c.post('/channels', { kind: 'telegram_bot', token: TOKEN })).status).toBe(409);

    const list = (await c.get('/channels')).body.data;
    expect(list.map((x: any) => x.kind)).toEqual(['webchat', 'telegram_bot']);
    expect(JSON.stringify(list)).not.toMatch(/AAFakeToken|webhookSecret|"secret"/);

    // Another workspace can't see or change them.
    const other = await signup();
    expect((await other.c.get('/channels')).body.data).toEqual([]);
    expect((await other.c.patch(`/channels/${bot.body.id}`, { name: 'x' })).status).toBe(404);
    expect((await other.c.del(`/channels/${bot.body.id}`)).status).toBe(404);

    // Disable / enable a bot; delete a channel with its conversations.
    expect((await c.patch(`/channels/${bot.body.id}`, { status: 'disabled' })).body.status).toBe('disabled');
    expect((await c.patch(`/channels/${bot.body.id}`, { status: 'active' })).body.status).toBe('active');
    expect((await c.del(`/channels/${web.body.id}`)).status).toBe(204);
    expect((await c.get('/channels')).body.data).toHaveLength(1);
  });

  it('uses a webhook when APP_URL is https', async () => {
    const { c } = await signup();
    const prev = config.appUrl;
    config.appUrl = 'https://crm.example.com';
    try {
      const bot = await c.post('/channels', { kind: 'telegram_bot', token: TOKEN2 });
      expect(bot.body.config.mode).toBe('webhook');
      const hook = fake.webhooks.at(-1);
      expect(hook.url).toBe(`https://crm.example.com/api/v1/hooks/telegram/${bot.body.publicKey}`);
      expect(hook.secret_token).toMatch(/^[0-9a-f]{48}$/);
    } finally { config.appUrl = prev; }
  });
});

describe('inbox: Telegram', () => {
  it('stores private and group messages (polling), skips bots and service messages, never twice', async () => {
    const { c } = await signup();
    await pool.query(`UPDATE channels SET status = 'disabled' WHERE kind = 'telegram_bot'`); // other tests' bots
    const bot = (await c.post('/channels', { kind: 'telegram_bot', token: '7000003:AAThirdFakeTokenForInboxTests_1234' })).body;
    const T = '7000003:AAThirdFakeTokenForInboxTests_1234';
    tgMessage(T, { id: 111, type: 'private', first_name: 'Ada', last_name: 'Lovelace', username: 'ada_l' }, ada, { text: 'Hi, do you ship to Siem Reap?' });
    tgMessage(T, { id: -500, type: 'supergroup', title: 'Wholesale buyers' }, { id: 222, first_name: 'Bob' }, { photo: [{}], caption: 'This one' });
    tgMessage(T, { id: -500, type: 'supergroup', title: 'Wholesale buyers' }, { id: 9, is_bot: true, first_name: 'Other bot' }, { text: 'beep' });
    tgMessage(T, { id: -500, type: 'supergroup', title: 'Wholesale buyers' }, { id: 222, first_name: 'Bob' }, { new_chat_members: [{}] });
    expect(await pollTelegram()).toBe(2);
    expect(await pollTelegram()).toBe(0); // offset moved on

    const list = (await c.get('/inbox/conversations')).body.data;
    expect(list).toHaveLength(2);
    const group = list.find((x: any) => x.kind === 'group');
    const direct = list.find((x: any) => x.kind === 'direct');
    expect(group).toMatchObject({ title: 'Wholesale buyers', channelKind: 'telegram_bot', channelName: bot.name, unread: 1, lastMessagePreview: '[Photo] This one' });
    expect(direct).toMatchObject({ title: 'Ada Lovelace', unread: 1, lastDirection: 'in', assigneeId: null });
    const detail = (await c.get(`/inbox/conversations/${direct.id}`)).body;
    expect(detail.profile).toMatchObject({ name: 'Ada Lovelace', username: 'ada_l', platformId: '111' });
    expect(detail.messages).toMatchObject([{ direction: 'in', senderName: 'Ada Lovelace', body: 'Hi, do you ship to Siem Reap?' }]);
    expect((await c.get('/inbox/summary')).body).toEqual({ unread: 2, canView: true });
    await c.post(`/inbox/conversations/${direct.id}/read`);
    expect((await c.get('/inbox/summary')).body.unread).toBe(1);

    // The same update delivered again (webhook retry) is not stored twice.
    const ch = (await pool.query('SELECT webhook_secret, public_key FROM channels WHERE id = $1', [bot.id])).rows[0];
    const again = fake.updates.get(T)![0];
    const app = await getApp();
    const post = (secret: string, key = ch.public_key, payload: unknown = again) => app.inject({ method: 'POST', url: `/api/v1/hooks/telegram/${key}`,
      headers: { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    expect((await post(ch.webhook_secret)).statusCode).toBe(200);
    expect((await c.get(`/inbox/conversations/${direct.id}`)).body.messages).toHaveLength(1);
    // Webhook: wrong secret / unknown key are refused; a new message arrives (no CSRF header needed).
    expect((await post('wrong')).statusCode).toBe(401);
    expect((await post(ch.webhook_secret, 'nope')).statusCode).toBe(404);
    const next = { update_id: 999, message: { message_id: 77, date: 1, chat: { id: 111, type: 'private', first_name: 'Ada', last_name: 'Lovelace' }, from: ada, text: 'Also, prices?' } };
    expect((await post(ch.webhook_secret, ch.public_key, next)).statusCode).toBe(200);
    expect((await c.get(`/inbox/conversations/${direct.id}`)).body.messages.map((m: any) => m.body)).toEqual(['Hi, do you ship to Siem Reap?', 'Also, prices?']);
  });

  it('replies through the bot (job), assigns the replier, and reports refusals', async () => {
    const { c, me } = await signup();
    const T = '7000004:AAFourthFakeTokenForInboxTests_123';
    await c.post('/channels', { kind: 'telegram_bot', token: T });
    tgMessage(T, { id: 111, type: 'private', first_name: 'Ada' }, ada, { text: 'Hello?' });
    tgMessage(T, { id: 403, type: 'private', first_name: 'Blocker' }, { id: 403, first_name: 'Blocker' }, { text: 'bye' });
    await pollTelegram();
    const convs = (await c.get('/inbox/conversations')).body.data;
    const adaConv = convs.find((x: any) => x.title === 'Ada');
    const blocker = convs.find((x: any) => x.title === 'Blocker');

    const r = await c.post(`/inbox/conversations/${adaConv.id}/messages`, { body: 'Yes, we deliver nationwide.' });
    expect(r.status).toBe(201);
    let d = (await c.get(`/inbox/conversations/${adaConv.id}`)).body;
    expect(d.messages.at(-1)).toMatchObject({ direction: 'out', status: 'pending', authorName: 'Admin', body: 'Yes, we deliver nationwide.' });
    expect(d).toMatchObject({ assigneeId: me.user.id, unread: 0 });
    await processJobs();
    d = (await c.get(`/inbox/conversations/${adaConv.id}`)).body;
    expect(d.messages.at(-1).status).toBe('sent');
    expect(fake.sent.at(-1)).toEqual({ chat_id: '111', text: 'Yes, we deliver nationwide.' });

    await c.post(`/inbox/conversations/${blocker.id}/messages`, { body: 'Are you there?' });
    await processJobs();
    const failed = (await c.get(`/inbox/conversations/${blocker.id}`)).body.messages.at(-1);
    expect(failed).toMatchObject({ status: 'failed', error: 'Telegram refused the message: Forbidden: bot was blocked by the user' });
    expect((await c.post(`/inbox/conversations/${blocker.id}/messages/${failed.id}/retry`)).status).toBe(200);
    expect((await c.get(`/inbox/conversations/${blocker.id}`)).body.messages.at(-1).status).toBe('pending');
    expect((await c.post(`/inbox/conversations/${blocker.id}/messages/${failed.id}/retry`)).status).toBe(404); // not failed any more

    // Disabled channel: no replies.
    const ch = (await c.get('/channels')).body.data[0];
    await c.patch(`/channels/${ch.id}`, { status: 'disabled' });
    const blocked = await c.post(`/inbox/conversations/${adaConv.id}/messages`, { body: 'x' });
    expect(blocked.status).toBe(409);
    expect((await c.get(`/inbox/conversations/${adaConv.id}`)).body.canReply).toBe(false);
  });
});

describe('inbox: website chat', () => {
  it('visitors chat through the public API; replies come back; email links the contact; origins are enforced', async () => {
    const { c } = await signup();
    const contact = (await c.post('/contacts', { firstName: 'Grace', lastName: 'Hopper', methods: [{ kind: 'email', value: 'grace@navy.test' }] })).body;
    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Acme support', greeting: 'Hi there' })).body;
    const app = await getApp();
    const pub = async (method: 'GET' | 'POST' | 'OPTIONS', path: string, body?: unknown, origin = 'https://shop.example') => {
      const r = await app.inject({ method, url: `/api/v1/public/webchat/${ch.publicKey}${path}`, payload: body ? JSON.stringify(body) : undefined,
        headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}) } });
      return { status: r.statusCode, headers: r.headers, body: r.body ? JSON.parse(r.body) : null };
    };
    const settings = await pub('GET', '');
    expect(settings.status).toBe(200);
    expect(settings.body).toEqual({ name: 'Acme support', greeting: 'Hi there', color: '#4f46e5' });
    expect(settings.headers['access-control-allow-origin']).toBe('*');
    expect(settings.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect((await pub('OPTIONS', '/messages')).status).toBe(204);

    const first = await pub('POST', '/messages', { body: 'Is the blue model in stock?', name: 'Grace', email: 'GRACE@navy.test' });
    expect(first.status).toBe(201);
    const token = first.body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first.body.messages).toMatchObject([{ direction: 'in', body: 'Is the blue model in stock?' }]);
    await pub('POST', '/messages', { token, body: 'Size M' });

    const conv = (await c.get('/inbox/conversations')).body.data[0];
    expect(conv).toMatchObject({ title: 'Grace', channelKind: 'webchat', unread: 2, contactId: contact.id, contactName: 'Grace Hopper' });
    expect((await c.get(`/inbox/conversations?contactId=${contact.id}`)).body.data).toHaveLength(1);
    await c.post(`/inbox/conversations/${conv.id}/messages`, { body: 'Yes — 3 left in M.' });
    const seen = await pub('GET', `/messages?token=${token}`);
    expect(seen.body.messages.map((m: any) => [m.direction, m.body, m.agent ?? null])).toEqual([
      ['in', 'Is the blue model in stock?', null], ['in', 'Size M', null], ['out', 'Yes — 3 left in M.', 'Admin'],
    ]);
    // Another visitor (no or wrong token) sees nothing of it.
    expect((await pub('GET', '/messages?token=' + 'x'.repeat(32))).body.messages).toEqual([]);
    expect((await pub('GET', '/messages')).body.messages).toEqual([]);
    const second = await pub('POST', '/messages', { body: 'hello' });
    expect(second.body.messages).toHaveLength(1);
    expect((await c.get('/inbox/conversations')).body.data[0].title).toMatch(/^Website visitor [0-9A-F]{4}$/);

    // Allowed websites only.
    await c.patch(`/channels/${ch.id}`, { allowedOrigins: ['https://www.acme.test'] });
    expect((await pub('POST', '/messages', { body: 'hi' })).status).toBe(403);
    const ok = await pub('POST', '/messages', { body: 'hi' }, 'https://www.acme.test');
    expect(ok.status).toBe(201);
    expect(ok.headers['access-control-allow-origin']).toBe('https://www.acme.test');
    expect((await c.patch(`/channels/${ch.id}`, { allowedOrigins: ['not a url'] })).status).toBe(400);

    // Disabled / unknown channel.
    await c.patch(`/channels/${ch.id}`, { status: 'disabled' });
    expect((await pub('GET', '')).status).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/public/webchat/nope' })).statusCode).toBe(404);
    // Validation.
    await c.patch(`/channels/${ch.id}`, { status: 'active', allowedOrigins: [] });
    expect((await pub('POST', '/messages', { body: '' })).status).toBe(400);
    expect((await pub('POST', '/messages', { body: 'x'.repeat(4001) })).status).toBe(400);
  });

  it('serves the widget script for other websites', async () => {
    const app = await getApp();
    const r = await app.inject({ method: 'GET', url: '/widget.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.body).toContain('/api/v1/public/webchat/');
  });
});

describe('inbox: permissions and links', () => {
  it('scopes by assignee, hides other workspaces, and checks reply rights', async () => {
    const { c, me } = await signup();
    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const app = await getApp();
    const visit = (body: string, name: string) => app.inject({ method: 'POST', url: `/api/v1/public/webchat/${ch.publicKey}/messages`,
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ body, name }) });
    await visit('one', 'Unassigned visitor');
    await visit('two', 'Admin visitor');
    await visit('three', 'Rep visitor');
    const all = (await c.get('/inbox/conversations')).body.data;
    const byTitle = (t: string) => all.find((x: any) => x.title === t);
    const rep = await inviteUser(c, 'Sales rep', 'Rita Rep');
    const viewer = await inviteUser(c, 'Viewer', 'Vic Viewer');
    expect((await c.patch(`/inbox/conversations/${byTitle('Admin visitor').id}`, { assigneeId: me.user.id })).status).toBe(200);
    expect((await c.patch(`/inbox/conversations/${byTitle('Rep visitor').id}`, { assigneeId: rep.id })).status).toBe(200);
    expect((await c.patch(`/inbox/conversations/${byTitle('Rep visitor').id}`, { assigneeId: 999999 })).status).toBe(400);

    // Sales rep (team scope, no shared team with the admin): unassigned + own only.
    const repList = (await rep.c.get('/inbox/conversations')).body.data.map((x: any) => x.title).sort();
    expect(repList).toEqual(['Rep visitor', 'Unassigned visitor']);
    expect((await rep.c.get(`/inbox/conversations/${byTitle('Admin visitor').id}`)).status).toBe(404);
    expect((await rep.c.post(`/inbox/conversations/${byTitle('Admin visitor').id}/messages`, { body: 'x' })).status).toBe(404);
    expect((await rep.c.get('/inbox/conversations?assignee=me')).body.data.map((x: any) => x.title)).toEqual(['Rep visitor']);
    expect((await rep.c.get('/inbox/conversations?assignee=unassigned')).body.data.map((x: any) => x.title)).toEqual(['Unassigned visitor']);
    // The rep got a notification for the assignment.
    const notes = (await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND entity_type = 'conversation'`, [rep.id])).rows;
    expect(notes.map((n) => n.title)).toEqual(['Admin assigned you a conversation']);
    // Replying to the unassigned one takes it.
    expect((await rep.c.post(`/inbox/conversations/${byTitle('Unassigned visitor').id}/messages`, { body: 'Hi!' })).status).toBe(201);
    expect((await c.get(`/inbox/conversations/${byTitle('Unassigned visitor').id}`)).body.assigneeName).toBe('Rita Rep');

    // Viewer: reads everything, can't reply or change.
    expect((await viewer.c.get('/inbox/conversations')).body.data).toHaveLength(3);
    const vd = (await viewer.c.get(`/inbox/conversations/${byTitle('Admin visitor').id}`)).body;
    expect(vd).toMatchObject({ canEdit: false, canReply: false });
    expect((await viewer.c.post(`/inbox/conversations/${byTitle('Admin visitor').id}/messages`, { body: 'x' })).status).toBe(403);
    expect((await viewer.c.patch(`/inbox/conversations/${byTitle('Admin visitor').id}`, { status: 'closed' })).status).toBe(403);

    // A custom role without the inbox permission.
    const role = (await c.post('/roles', { name: 'No inbox', grants: { contact: { view: 'all' } } })).body;
    const none = await inviteUser(c, 'No inbox', 'Nora');
    expect(role.id).toBeTruthy();
    expect((await none.c.get('/inbox/conversations')).status).toBe(403);
    expect((await none.c.get('/inbox/summary')).body).toEqual({ unread: 0, canView: false });
    expect((await none.c.get('/auth/me')).body.permissions.conversation.view).toBe('none');

    // Another workspace.
    const other = await signup();
    expect((await other.c.get('/inbox/conversations')).body.data).toEqual([]);
    expect((await other.c.get(`/inbox/conversations/${byTitle('Admin visitor').id}`)).status).toBe(404);
    expect((await other.c.patch(`/inbox/conversations/${byTitle('Admin visitor').id}`, { status: 'closed' })).status).toBe(404);

    // Close / reopen; closed list; a new visitor message reopens it.
    const id = byTitle('Admin visitor').id;
    expect((await c.patch(`/inbox/conversations/${id}`, { status: 'closed' })).status).toBe(200);
    expect((await c.get('/inbox/conversations?status=closed')).body.data.map((x: any) => x.id)).toEqual([id]);
    const tokenless = await pool.query(`SELECT external_id FROM conversations WHERE id = $1`, [id]);
    expect(tokenless.rows[0].external_id).toMatch(/^[0-9a-f]{64}$/); // only the token's hash is stored
    const audits = (await pool.query(`SELECT action FROM audit_events WHERE entity_type = 'conversation' AND entity_id = $1 ORDER BY id`, [id])).rows;
    expect(audits.map((a) => a.action)).toEqual(['updated', 'updated']);
  });

  it('links contacts and leads (only ones the user may see) and creates a contact from a Telegram chat', async () => {
    const { c } = await signup();
    const T = '7000005:AAFifthFakeTokenForInboxTests_12345';
    await c.post('/channels', { kind: 'telegram_bot', token: T });
    tgMessage(T, { id: 321, type: 'private', first_name: 'Sok', last_name: 'Dara', username: 'sokdara' }, { id: 321, first_name: 'Sok', last_name: 'Dara', username: 'sokdara' }, { text: 'Hello' });
    tgMessage(T, { id: -9, type: 'group', title: 'Group chat' }, { id: 5, first_name: 'X' }, { text: 'Hey all' });
    await pollTelegram();
    const convs = (await c.get('/inbox/conversations')).body.data;
    const dm = convs.find((x: any) => x.kind === 'direct');
    const grp = convs.find((x: any) => x.kind === 'group');

    const made = await c.post(`/inbox/conversations/${dm.id}/contact`);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const contact = (await c.get(`/contacts/${made.body.id}`)).body;
    expect(contact).toMatchObject({ firstName: 'Sok', lastName: 'Dara' });
    expect(contact.methods).toMatchObject([{ kind: 'messenger', label: 'telegram', value: '@sokdara' }]);
    expect((await c.get(`/inbox/conversations/${dm.id}`)).body).toMatchObject({ contactId: made.body.id, contactName: 'Sok Dara' });
    expect((await c.post(`/inbox/conversations/${dm.id}/contact`)).status).toBe(409);
    expect((await c.post(`/inbox/conversations/${grp.id}/contact`)).status).toBe(422);

    // Link a lead, unlink; records of another workspace are refused.
    const lead = (await c.post('/leads', { title: 'Bulk order', firstName: 'Sok' })).body;
    expect((await c.patch(`/inbox/conversations/${grp.id}`, { leadId: lead.id, contactId: made.body.id })).status).toBe(200);
    expect((await c.get(`/inbox/conversations?leadId=${lead.id}`)).body.data.map((x: any) => x.id)).toEqual([grp.id]);
    const other = await signup();
    const foreign = (await other.c.post('/contacts', { firstName: 'Foreign' })).body;
    expect((await c.patch(`/inbox/conversations/${grp.id}`, { contactId: foreign.id })).status).toBe(400);
    expect((await c.patch(`/inbox/conversations/${grp.id}`, { leadId: null })).status).toBe(200);
    expect((await c.get(`/inbox/conversations/${grp.id}`)).body.leadId).toBeNull();

    // A rep who can't see a private contact can't link it, and doesn't see its name on conversations.
    const priv = (await c.post('/contacts', { firstName: 'Secret', visibility: 'private' })).body;
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.patch(`/inbox/conversations/${dm.id}`, { contactId: priv.id })).status).toBe(400);
    await c.patch(`/inbox/conversations/${dm.id}`, { contactId: priv.id });
    const seenByRep = (await rep.c.get(`/inbox/conversations/${dm.id}`)).body;
    expect(seenByRep.contactId).toBe(priv.id);
    expect(seenByRep.contactName).toBeNull();
  });
});

describe('secrets', () => {
  it('encrypts with AES-GCM and detects tampering', () => {
    const s = sealSecret('hello');
    expect(s).not.toBe(sealSecret('hello')); // random IV
    expect(openSecret(s)).toBe('hello');
    const raw = Buffer.from(s.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => openSecret('v1:' + raw.toString('base64'))).toThrow();
  });
});
