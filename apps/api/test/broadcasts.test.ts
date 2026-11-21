import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ct, personalize } from '@crm/shared';
import { config } from '../src/config.ts';
import { pool } from '../src/db/pool.ts';
import { processJobs } from '../src/automation/engine.ts';
import { pollTelegram } from '../src/inbox/telegram.ts';
import { drainBroadcasts, runBroadcasts } from '../src/routes/broadcasts.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

/** Runs every due job (earlier test files may have left some ahead of ours in the queue). */
const drainJobs = async () => { for (let i = 0; i < 50 && (await processJobs(100)) > 0; i++); };

/**
 * One fake for both platforms. Telegram Bot API: /bot<token>/<method>; chat "403" is a user who blocked the bot.
 * Graph API (WhatsApp): number 3333333, business account 4444444 with two approved templates.
 */
const TOKEN = '7000088:AABroadcastFakeTokenForTests_0123';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const WA = '3333333', WABA = '4444444', GOOD = 'GOOD_token_broadcasts_abcdefghijklmnop';
const fake = { updates: [] as any[], tg: [] as any[], wa: [] as any[] };
let server: Server;

beforeAll(async () => {
  let n = 1;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url ?? '/', 'http://x');
      const p = raw && String(req.headers['content-type']).startsWith('application/json') ? JSON.parse(raw) : {};
      const tg = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
      if (tg) {
        const method = tg[2];
        if (method === 'getMe') return reply(200, { ok: true, result: { id: 7000088, is_bot: true, first_name: 'Shop Bot', username: 'shop_bot' } });
        if (method === 'deleteWebhook' || method === 'setWebhook' || method === 'sendChatAction') return reply(200, { ok: true, result: true });
        if (method === 'getUpdates') return reply(200, { ok: true, result: fake.updates.filter((u) => u.update_id >= (p.offset ?? 0)) });
        if (method === 'sendMessage') {
          if (String(p.chat_id) === '403') return reply(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
          fake.tg.push(p);
          return reply(200, { ok: true, result: { message_id: 900 + n++, chat: { id: p.chat_id }, text: p.text } });
        }
        return reply(404, { ok: false, description: 'Not Found' });
      }
      if (!String(req.headers.authorization).startsWith('Bearer GOOD')) return reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
      const path = url.pathname.slice(1);
      if (req.method === 'GET') {
        if (path === WA) return reply(200, { id: WA, verified_name: 'Acme', display_phone_number: '+855 23 999 000' });
        if (path === WABA) return reply(200, { id: WABA, name: 'Acme WABA' });
        if (path === `${WABA}/message_templates`) {
          return reply(200, { data: [
            { name: 'new_stock', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} is back in stock. Reply STOP to opt out.' }] },
            { name: 'pending_review', language: 'en_US', status: 'PENDING', components: [{ type: 'BODY', text: 'Not yet' }] },
          ] });
        }
        return reply(400, { error: { message: 'Unsupported get request', code: 100 } });
      }
      if (path === `${WA}/messages`) { fake.wa.push(p); return reply(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.b.${n++}` }] }); }
      reply(404, { error: { message: 'Unknown path', code: 803 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.telegram.apiUrl = base;
  config.meta.graphUrl = base;
});
afterAll(async () => { server.close(); await (await getApp()).close(); await pool.end(); });

let updateId = 1;
const tgSays = (chat: Record<string, unknown>, from: Record<string, unknown>, text: string) =>
  fake.updates.push({ update_id: updateId++, message: { message_id: updateId * 10, date: 1, chat, from, text } });
const person = (id: number, first: string, last = '') => ({ chat: { id, type: 'private', first_name: first, last_name: last }, from: { id, first_name: first, last_name: last } });

async function hookWa(key: string, from: string, name: string, text: string, id: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: WA },
      contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] });
  const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return (await getApp()).inject({ method: 'POST', url: `/api/v1/hooks/meta/${key}`, payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
}

describe('broadcasts', () => {
  it('{{name}} and {{first_name}}', () => {
    expect(personalize('Hi {{first_name}} ({{ name }})!', 'Ada Lovelace')).toBe('Hi Ada (Ada Lovelace)!');
    expect(personalize('Hi {{first_name}}', '')).toBe('Hi ');
  });

  it('Telegram: reaches everyone who chatted privately, skips STOP and groups; START undoes it', async () => {
    const { c } = await signup();
    await pool.query(`UPDATE channels SET status = 'disabled' WHERE kind = 'telegram_bot'`); // only our fake bot is polled
    const bot = await c.post('/channels', { kind: 'telegram_bot', token: TOKEN });
    expect(bot.status, JSON.stringify(bot.body)).toBe(201);
    const ada = person(111, 'Ada', 'Lovelace'), bob = person(222, 'Bob'), blocked = person(403, 'Gone');
    tgSays(ada.chat, ada.from, 'Hello');
    tgSays(bob.chat, bob.from, 'Hi');
    tgSays(blocked.chat, blocked.from, 'Hey');
    tgSays({ id: -100, type: 'group', title: 'Resellers' }, ada.from, 'Group hello');
    await pollTelegram();
    tgSays(bob.chat, bob.from, 'STOP');
    await pollTelegram();
    await drainJobs();
    // Bob is told, in the customer language (English by default).
    const ws = (await pool.query(`SELECT w.name FROM workspaces w JOIN channels ch ON ch.workspace_id = w.id WHERE ch.id = $1`, [bot.body.id])).rows[0].name;
    expect(fake.tg.find((m) => String(m.chat_id) === '222')?.text).toBe(ct('en', 'optOutDone', { company: ws }));

    const aud = await c.get(`/broadcasts/audience?channelKind=telegram_bot&channelId=${bot.body.id}`);
    expect(aud.body).toEqual({ count: 2, optedOut: 1 });

    // Drafts need a message and a channel of the right kind.
    expect((await c.post('/broadcasts', { name: 'X', channelKind: 'telegram_bot', channelId: bot.body.id })).status).toBe(400);
    expect((await c.post('/broadcasts', { name: 'X', channelKind: 'whatsapp', channelId: bot.body.id, template: { name: 'a', language: 'en' } })).status).toBe(400);
    const draft = await c.post('/broadcasts', { name: 'New arms', channelKind: 'telegram_bot', channelId: bot.body.id, body: 'Hi {{first_name}}, the X2 arm is back in stock!' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ status: 'draft', channelName: '@shop_bot', recipients: 0 });

    fake.tg.length = 0;
    const sent = await c.post(`/broadcasts/${draft.body.id}/send`, {});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await drainBroadcasts();
    await drainJobs();
    expect(fake.tg.map((m) => [String(m.chat_id), m.text])).toEqual([['111', 'Hi Ada, the X2 arm is back in stock!']]);
    const done = (await c.get(`/broadcasts/${draft.body.id}`)).body;
    expect(done).toMatchObject({ status: 'sent', recipients: 2, stats: { total: 2, delivered: 1, failed: 1, sending: 0 } });
    const failed = (await c.get(`/broadcasts/${draft.body.id}/recipients?status=failed`)).body;
    expect(failed).toMatchObject({ total: 1, data: [{ name: 'Gone', status: 'failed' }] });
    expect(failed.data[0].error).toMatch(/blocked/);
    // The message is in Ada's conversation, by the admin who sent it.
    const conv = (await pool.query(`SELECT id FROM conversations WHERE channel_id = $1 AND external_id = '111'`, [bot.body.id])).rows[0].id;
    const thread = (await c.get(`/inbox/conversations/${conv}`)).body.messages;
    expect(thread.at(-1)).toMatchObject({ direction: 'out', body: 'Hi Ada, the X2 arm is back in stock!', status: 'sent' });
    // A sent broadcast is a record: no edits, no deleting, no second send.
    expect((await c.put(`/broadcasts/${draft.body.id}`, { name: 'Y', channelKind: 'telegram_bot', channelId: bot.body.id, body: 'x' })).status).toBe(409);
    expect((await c.del(`/broadcasts/${draft.body.id}`)).status).toBe(409);
    expect((await c.post(`/broadcasts/${draft.body.id}/send`, {})).status).toBe(409);

    // START: Bob is back in (and told so).
    tgSays(bob.chat, bob.from, 'start');
    await pollTelegram();
    await drainJobs();
    expect(fake.tg.at(-1)).toMatchObject({ chat_id: '222', text: ct('en', 'optInDone', { company: ws }) });
    expect((await c.get(`/broadcasts/audience?channelKind=telegram_bot&channelId=${bot.body.id}`)).body).toEqual({ count: 3, optedOut: 0 });
    // A STOP word inside a normal sentence is just a message.
    tgSays(bob.chat, bob.from, 'please stop by the shop');
    await pollTelegram();
    expect((await c.get(`/broadcasts/audience?channelKind=telegram_bot&channelId=${bot.body.id}`)).body.optedOut).toBe(0);

    const list = (await c.get('/broadcasts')).body;
    expect(list.data.map((b: any) => b.name)).toEqual(['New arms']);
    expect(list.nextCursor).toBeNull();

    // On the contact page: Bob's chat, what he received, and a team member recording his wish.
    const bobConv = (await pool.query(`SELECT id FROM conversations WHERE channel_id = $1 AND external_id = '222'`, [bot.body.id])).rows[0].id;
    const bobContact = (await c.post('/contacts', { firstName: 'Bob' })).body;
    await c.patch(`/inbox/conversations/${bobConv}`, { contactId: bobContact.id });
    let mk = (await c.get(`/contacts/${bobContact.id}/marketing`)).body;
    expect(mk.chats).toMatchObject([{ id: bobConv, channelKind: 'telegram_bot', channelName: '@shop_bot', optedOutAt: null, canEdit: true }]);
    expect(mk.received).toEqual([]); // he had opted out when it went out
    expect((await c.post(`/contacts/${bobContact.id}/chat-opt-out`, { conversationId: bobConv, optedOut: true })).status).toBe(200);
    expect((await c.get(`/broadcasts/audience?channelKind=telegram_bot&channelId=${bot.body.id}`)).body.optedOut).toBe(1);
    // A conversation of another contact can't be changed through Bob.
    const adaConv = (await pool.query(`SELECT id FROM conversations WHERE channel_id = $1 AND external_id = '111'`, [bot.body.id])).rows[0].id;
    expect((await c.post(`/contacts/${bobContact.id}/chat-opt-out`, { conversationId: adaConv, optedOut: true })).status).toBe(404);
    // Bob says START himself: noted on his timeline as his own reply.
    tgSays(bob.chat, bob.from, 'START');
    await pollTelegram();
    mk = (await c.get(`/contacts/${bobContact.id}/marketing`)).body;
    expect(mk.chats[0].optedOutAt).toBeNull();
    const events = (await c.get(`/timeline/contact/${bobContact.id}`)).body.items.filter((i: any) => i.type === 'event').map((i: any) => [i.data.action, i.data.changes.via]);
    expect(events).toEqual(expect.arrayContaining([['chat_opted_out', 'team'], ['chat_opted_in', 'customer']]));
    // Ada's contact lists the broadcast she got.
    const adaContact = (await c.post('/contacts', { firstName: 'Ada' })).body;
    await c.patch(`/inbox/conversations/${adaConv}`, { contactId: adaContact.id });
    expect((await c.get(`/contacts/${adaContact.id}/marketing`)).body.received).toMatchObject([{ name: 'New arms', channelKind: 'telegram_bot', status: 'sent' }]);
  });

  it('WhatsApp: only approved templates, filled in per person; Khmer confirmation for STOP', async () => {
    const { c } = await signup();
    const s = (await c.get('/settings/documents')).body;
    await c.put('/settings/documents', { ...s, customerLanguage: 'km' });
    const wa = (await c.post('/channels', { kind: 'whatsapp', accountId: WA, accessToken: GOOD, appSecret: '0123456789abcdef0123456789abcdef' })).body;
    await hookWa(wa.publicKey, '85512000001', 'Dara Sok', 'Hi', 'wamid.in.b1');
    await hookWa(wa.publicKey, '85512000002', 'Vanna', 'Hello', 'wamid.in.b2');
    await hookWa(wa.publicKey, '85512000002', 'Vanna', 'ឈប់', 'wamid.in.b3');
    await drainJobs();
    const ws = (await pool.query(`SELECT w.name FROM workspaces w JOIN channels ch ON ch.workspace_id = w.id WHERE ch.id = $1`, [wa.id])).rows[0].name;
    expect(fake.wa.find((m) => m.to === '85512000002')?.text?.body).toBe(ct('km', 'optOutDone', { company: ws }));

    const tpl = { name: 'new_stock', language: 'en_US', params: ['{{first_name}}', 'The X2 arm'] };
    // Without the business account ID the templates can't be checked.
    expect((await c.post('/broadcasts', { name: 'Stock', channelKind: 'whatsapp', channelId: wa.id, template: tpl })).status).toBe(409);
    await c.patch(`/channels/${wa.id}`, { businessAccountId: WABA });
    expect((await c.get(`/broadcasts/templates?channelId=${wa.id}`)).body.data.map((t: any) => t.name)).toEqual(['new_stock']);
    expect((await c.post('/broadcasts', { name: 'Stock', channelKind: 'whatsapp', channelId: wa.id, template: { ...tpl, params: ['x'] } })).status).toBe(400);
    expect((await c.post('/broadcasts', { name: 'Stock', channelKind: 'whatsapp', channelId: wa.id, template: { name: 'pending_review', language: 'en_US', params: [] } })).status).toBe(400);
    const b = await c.post('/broadcasts', { name: 'Stock', channelKind: 'whatsapp', channelId: wa.id, template: tpl });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    fake.wa.length = 0;
    await c.post(`/broadcasts/${b.body.id}/send`, {});
    await drainBroadcasts();
    await drainJobs();
    expect(fake.wa).toHaveLength(1);
    expect(fake.wa[0]).toMatchObject({ to: '85512000001', type: 'template', template: { name: 'new_stock', language: { code: 'en_US' } } });
    expect(JSON.stringify(fake.wa[0].template.components)).toContain('"Dara"');
    expect((await c.get(`/broadcasts/${b.body.id}`)).body.stats).toMatchObject({ total: 1, delivered: 1 });
  });

  it('email: contacts with an address, unsubscribe link (page + one-click), scheduled sending, stop', async () => {
    const { c, dict } = await signup();
    const customer = dict('contact_type')[0].id;
    await c.post('/contacts', { firstName: 'Ada', lastName: 'Lovelace', typeId: customer, methods: [{ kind: 'email', value: 'ada@umbrella.test' }] });
    await c.post('/contacts', { firstName: 'Ada (old)', methods: [{ kind: 'email', value: 'ADA@umbrella.test' }] }); // same address twice
    await c.post('/contacts', { firstName: 'Bo', typeId: customer, methods: [{ kind: 'email', value: 'bo@globex.test' }] });
    await c.post('/contacts', { firstName: 'No email' });
    expect((await c.get('/broadcasts/audience?channelKind=email')).body).toEqual({ count: 2, optedOut: 0 });
    expect((await c.get(`/broadcasts/audience?channelKind=email&contactTypeId=${customer}`)).body.count).toBe(2);

    expect((await c.post('/broadcasts', { name: 'News', channelKind: 'email', body: 'x' })).status).toBe(400); // subject
    const b = (await c.post('/broadcasts', { name: 'November news', channelKind: 'email', subject: 'News for {{first_name}}', body: 'Hello {{first_name}},\n\nOur new arm is here.' })).body;
    // Scheduled: nothing goes out before its time.
    const at = new Date(Date.now() + 3_600_000).toISOString();
    expect((await c.post(`/broadcasts/${b.id}/send`, { sendAt: new Date(Date.now() - 3_600_000).toISOString() })).status).toBe(400);
    expect((await c.post(`/broadcasts/${b.id}/send`, { sendAt: at })).body).toMatchObject({ status: 'scheduled' });
    await runBroadcasts();
    expect((await c.get(`/broadcasts/${b.id}`)).body.recipients).toBe(0);
    await pool.query(`UPDATE broadcasts SET send_at = now() - interval '1 minute' WHERE id = $1`, [b.id]);
    const before = (await pool.query(`SELECT coalesce(max(id), 0) AS id FROM jobs`)).rows[0].id;
    await drainBroadcasts();
    const mails = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND id > $1 ORDER BY id`, [before])).rows.map((r) => r.payload);
    expect(mails.map((m) => [m.to, m.subject])).toEqual([['ada@umbrella.test', 'News for Ada'], ['bo@globex.test', 'News for Bo']]);
    expect(mails[0].text).toContain('Hello Ada,');
    expect(mails[0].unsubscribeUrl).toMatch(/\/api\/v1\/public\/unsubscribe\/[\w-]{20,}$/);
    const token = mails[0].unsubscribeUrl.split('/').pop();
    expect(mails[0].text).toContain(`${config.appUrl.replace(/\/$/, '')}/unsubscribe/${token}`);
    expect((await c.get(`/broadcasts/${b.id}`)).body).toMatchObject({ status: 'sent', stats: { total: 2, delivered: 2 } });

    // The unsubscribe page: masked address; unsubscribing covers every contact with that address.
    const app = await getApp();
    const page = (await app.inject({ method: 'GET', url: `/api/v1/public/unsubscribe/${token}` })).json();
    expect(page).toMatchObject({ email: 'ad•@umbrella.test', unsubscribed: false, lang: 'en' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/public/unsubscribe/not-a-real-token-at-all-xx' })).statusCode).toBe(404);
    // One-click from a mail app: a form post, no cookies, no CSRF header.
    const one = await app.inject({ method: 'POST', url: `/api/v1/public/unsubscribe/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(one.statusCode).toBe(200);
    const out = (await pool.query(`SELECT first_name, email_opt_out_at IS NOT NULL AS out FROM contacts WHERE first_name LIKE 'Ada%' AND workspace_id = (SELECT workspace_id FROM broadcasts WHERE id = $1) ORDER BY id`, [b.id])).rows;
    expect(out).toEqual([{ first_name: 'Ada', out: true }, { first_name: 'Ada (old)', out: true }]);
    expect((await c.get('/broadcasts/audience?channelKind=email')).body).toEqual({ count: 1, optedOut: 2 });
    // Changed their mind.
    await app.inject({ method: 'POST', url: `/api/v1/public/unsubscribe/${token}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ subscribe: true }) });
    expect((await c.get('/broadcasts/audience?channelKind=email')).body.count).toBe(2);

    // Stop a scheduled one; delete a draft or a stopped one.
    const b2 = (await c.post('/broadcasts', { name: 'Later', channelKind: 'email', subject: 'S', body: 'B' })).body;
    await c.post(`/broadcasts/${b2.id}/send`, { sendAt: at });
    expect((await c.post(`/broadcasts/${b2.id}/cancel`)).body.status).toBe('canceled');
    expect((await c.del(`/broadcasts/${b2.id}`)).status).toBe(204);
    const b3 = (await c.post('/broadcasts', { name: 'Draft', channelKind: 'email', subject: 'S', body: 'B' })).body;
    expect((await c.post(`/broadcasts/${b3.id}/cancel`)).status).toBe(409);
    expect((await c.del(`/broadcasts/${b3.id}`)).status).toBe(204);
  });

  it('contact page: email opt-out by the team or the customer’s link, on every contact with the address; permissions', async () => {
    const { c } = await signup();
    const a = (await c.post('/contacts', { firstName: 'Ada', methods: [{ kind: 'email', value: 'ada@initech.test' }] })).body;
    const twin = (await c.post('/contacts', { firstName: 'Ada (2)', methods: [{ kind: 'email', value: 'Ada@Initech.test' }] })).body;
    const plain = (await c.post('/contacts', { firstName: 'Nobody' })).body;
    expect((await c.get(`/contacts/${a.id}/marketing`)).body).toEqual({ canEdit: true, email: { addresses: ['ada@initech.test'], optedOutAt: null }, chats: [], received: [] });
    expect((await c.post(`/contacts/${a.id}/email-opt-out`, { optedOut: 'yes' })).status).toBe(400);
    await c.post(`/contacts/${a.id}/email-opt-out`, { optedOut: true });
    expect((await c.get(`/contacts/${twin.id}/marketing`)).body.email.optedOutAt).not.toBeNull();
    expect((await c.get('/broadcasts/audience?channelKind=email')).body).toEqual({ count: 0, optedOut: 2 });
    const tl = (await c.get(`/timeline/contact/${a.id}`)).body.items.filter((i: any) => i.type === 'event' && i.data.action === 'email_unsubscribed');
    expect(tl).toHaveLength(1);
    expect(tl[0].data.changes.via).toBe('team');
    await c.post(`/contacts/${a.id}/email-opt-out`, { optedOut: false });
    expect((await c.get('/broadcasts/audience?channelKind=email')).body.count).toBe(1);
    // A contact without an address keeps the choice too.
    await c.post(`/contacts/${plain.id}/email-opt-out`, { optedOut: true });
    expect((await c.get(`/contacts/${plain.id}/marketing`)).body.email.optedOutAt).not.toBeNull();

    // The customer's own link shows on the timeline as theirs.
    const b = (await c.post('/broadcasts', { name: 'News', channelKind: 'email', subject: 'S', body: 'B' })).body;
    const before = (await pool.query(`SELECT coalesce(max(id), 0) AS id FROM jobs`)).rows[0].id;
    await c.post(`/broadcasts/${b.id}/send`, {});
    await drainBroadcasts();
    const mail = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND id > $1 AND payload->>'to' = 'ada@initech.test'`, [before])).rows[0].payload;
    const app = await getApp();
    await app.inject({ method: 'POST', url: `/api/v1/public/unsubscribe/${mail.unsubscribeUrl.split('/').pop()}`, headers: { 'content-type': 'application/json' }, payload: '{}' });
    const linkEv = (await c.get(`/timeline/contact/${a.id}`)).body.items.filter((i: any) => i.type === 'event' && i.data.action === 'email_unsubscribed');
    expect(linkEv[0]).toMatchObject({ data: { changes: { via: 'link' }, actorType: 'system' } });
    expect((await c.get(`/contacts/${a.id}/marketing`)).body.received).toMatchObject([{ name: 'News', channelKind: 'email', status: 'sent' }]);

    // Viewers see it but can't change it; other workspaces see nothing.
    const { c: viewer } = await inviteUser(c, 'Viewer');
    expect((await viewer.get(`/contacts/${a.id}/marketing`)).body.canEdit).toBe(false);
    expect((await viewer.post(`/contacts/${a.id}/email-opt-out`, { optedOut: false })).status).toBe(403);
    const other = await signup();
    expect((await other.c.get(`/contacts/${a.id}/marketing`)).status).toBe(404);
    expect((await other.c.post(`/contacts/${a.id}/email-opt-out`, { optedOut: false })).status).toBe(404);
  });

  it('admins only; other workspaces see nothing', async () => {
    const { c } = await signup();
    const b = (await c.post('/broadcasts', { name: 'Mine', channelKind: 'email', subject: 'S', body: 'B' })).body;
    const { c: rep } = await inviteUser(c, 'Sales rep');
    expect((await rep.get('/broadcasts')).status).toBe(403);
    expect((await rep.get('/broadcasts/audience?channelKind=email')).status).toBe(403);
    expect((await rep.post('/broadcasts', { name: 'X', channelKind: 'email', subject: 'S', body: 'B' })).status).toBe(403);
    expect((await rep.post(`/broadcasts/${b.id}/send`, {})).status).toBe(403);
    const other = await signup();
    expect((await other.c.get('/broadcasts')).body.data).toEqual([]);
    expect((await other.c.get(`/broadcasts/${b.id}`)).status).toBe(404);
    expect((await other.c.get(`/broadcasts/${b.id}/recipients`)).status).toBe(404);
    expect((await other.c.post(`/broadcasts/${b.id}/send`, {})).status).toBe(404);
    expect((await other.c.put(`/broadcasts/${b.id}`, { name: 'X', channelKind: 'email', subject: 'S', body: 'B' })).status).toBe(404);
    expect((await other.c.del(`/broadcasts/${b.id}`)).status).toBe(404);
    // Nobody to send to yet: explained, nothing scheduled.
    expect((await c.post(`/broadcasts/${b.id}/send`, {})).status).toBe(422);
    // Another workspace's channel can't be used or counted.
    const otherWeb = (await other.c.post('/channels', { kind: 'webchat', name: 'W' })).body;
    expect((await c.get(`/broadcasts/audience?channelKind=telegram_bot&channelId=${otherWeb.id}`)).status).toBe(404);
    expect((await c.post('/broadcasts', { name: 'X', channelKind: 'telegram_bot', channelId: otherWeb.id, body: 'x' })).status).toBe(400);
  });
});
