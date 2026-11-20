import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { pool } from '../src/db/pool.ts';
import { processJobs } from '../src/automation/engine.ts';

/** Runs every due job (earlier test files may have left some ahead of ours in the queue). */
const drainJobs = async () => { for (let i = 0; i < 50 && (await processJobs(100)) > 0; i++); };
import { metaFileUrlAllowed, splitText } from '../src/inbox/meta.ts';
import { openSecret } from '../src/lib/secrets.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

/**
 * A fake Graph API. Tokens starting with "GOOD" are accepted, "EXPIRED…" answer like an expired token (190).
 * Accounts: Page 1111111, Instagram 2222222, WhatsApp number 3333333. Recipients "5550024" (Messenger) and
 * "85500000024" (WhatsApp) are outside the 24-hour window.
 */
const PAGE = '1111111', IG = '2222222', WA = '3333333', WABA = '4444444';
const GOOD = 'GOOD_token_abcdefghijklmnopqrstuvwxyz';
const SECRET = '0123456789abcdef0123456789abcdef';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const fake = {
  sent: [] as any[], uploads: [] as { path: string; fields: Record<string, string>; file: { name: string; size: number } | null }[],
  subscribed: [] as string[], typing: [] as any[], expired: false,
};
let server: Server;
let base = '';

/** Minimal multipart reader (fields and one file) for the fake's upload endpoints. */
function readMultipart(req: IncomingMessage, raw: Buffer) {
  const boundary = /boundary=(.+)$/.exec(String(req.headers['content-type']))?.[1] ?? '';
  const fields: Record<string, string> = {};
  let file: { name: string; size: number } | null = null;
  for (const part of raw.toString('latin1').split(`--${boundary}`)) {
    const m = /name="([^"]+)"(?:; filename="([^"]*)")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/.exec(part);
    if (!m) continue;
    if (m[2] !== undefined) file = { name: m[2], size: Buffer.from(m[3], 'latin1').length };
    else fields[m[1]] = Buffer.from(m[3], 'latin1').toString('utf8');
  }
  return { fields, file };
}

beforeAll(async () => {
  let n = 1;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url ?? '/', 'http://x');
      const auth = String(req.headers.authorization ?? '');
      if (url.pathname === '/cdn/msg-img') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
      if (url.pathname === '/cdn/wa-doc') {
        if (auth !== `Bearer ${GOOD}`) return reply(401, {});
        res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from('%PDF-1.4 fake'));
      }
      if (fake.expired || auth.startsWith('Bearer EXPIRED')) return reply(400, { error: { message: 'Error validating access token: Session has expired', code: 190 } });
      if (!auth.startsWith('Bearer GOOD')) return reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
      const path = url.pathname.slice(1);
      const isJson = String(req.headers['content-type']).startsWith('application/json');
      const body = isJson && raw.length ? JSON.parse(raw.toString('utf8')) : null;
      if (req.method === 'GET') {
        if (path === PAGE) return reply(200, { id: PAGE, name: 'Acme Robotics' });
        if (path === IG) return reply(200, { id: IG, username: 'acme.robotics' });
        if (path === WA) return reply(200, { id: WA, verified_name: 'Acme', display_phone_number: '+855 23 999 000' });
        if (path === '5550001') return reply(200, { first_name: 'Ada', last_name: 'Lovelace' });
        if (path === '7770001') return reply(200, { name: 'Ina Insta', username: 'ina' });
        if (path === 'media-in-1') return reply(200, { url: `${base}/cdn/wa-doc`, mime_type: 'application/pdf', file_size: 13 });
        if (path === WABA) return reply(200, { id: WABA, name: 'Acme WABA' });
        if (path === `${WABA}/message_templates`) {
          expect(url.searchParams.get('status')).toBe('APPROVED');
          return reply(200, { data: [
            { name: 'order_ready', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [
              { type: 'HEADER', format: 'TEXT', text: 'Acme Robotics' },
              { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is ready for pickup.' },
              { type: 'FOOTER', text: 'Reply STOP to opt out' }] },
            { name: 'follow_up', language: 'km', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'សួស្តី! Still interested?' }] },
            { name: 'gone', language: 'en_US', status: 'APPROVED', components: [{ type: 'BODY', text: 'Old one' }] },
            { name: 'with_image', language: 'en_US', status: 'APPROVED', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Look' }] },
            { name: 'pending_review', language: 'en_US', status: 'PENDING', components: [{ type: 'BODY', text: 'Not yet' }] },
          ] });
        }
        return reply(400, { error: { message: 'Unsupported get request', code: 100 } });
      }
      if (path === `${PAGE}/subscribed_apps`) { fake.subscribed.push(PAGE); return reply(200, { success: true }); }
      if (path === 'me/messages') {
        if (!isJson) { const mp = readMultipart(req, raw); fake.uploads.push({ path, ...mp }); return reply(200, { recipient_id: '1', message_id: `m_file_${n++}` }); }
        if (body.sender_action) { fake.typing.push(body); return reply(200, { recipient_id: body.recipient.id }); }
        if (body.recipient.id === '5550024') return reply(400, { error: { message: 'This message is sent outside of allowed window.', code: 10, error_subcode: 2018278 } });
        fake.sent.push({ path, ...body });
        return reply(200, { recipient_id: body.recipient.id, message_id: `m_out_${n++}` });
      }
      if (path === `${WA}/media`) { const mp = readMultipart(req, raw); fake.uploads.push({ path, ...mp }); return reply(200, { id: 'media-up-1' }); }
      if (path === `${WA}/messages`) {
        if (body.to === '85500000024' && body.type !== 'template') return reply(400, { error: { message: 'Re-engagement message', code: 131047 } });
        if (body.type === 'template' && body.template.name === 'gone') return reply(400, { error: { message: 'Template name does not exist in the translation', code: 132001 } });
        fake.sent.push({ path, ...body });
        return reply(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.out.${n++}` }] });
      }
      reply(404, { error: { message: 'Unknown path', code: 803 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.meta.graphUrl = base;
});
afterAll(async () => { server.close(); await (await getApp()).close(); await pool.end(); });

const connect = (c: any, kind: string, accountId: string, extra: Record<string, unknown> = {}) =>
  c.post('/channels', { kind, accountId, accessToken: GOOD, appSecret: SECRET, ...extra });

/** Posts a webhook signed with the app secret (or a wrong one). */
async function hook(key: string, payload: unknown, secret = SECRET) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return (await getApp()).inject({ method: 'POST', url: `/api/v1/hooks/meta/${key}`, payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
}
let mid = 1;
const messenger = (page: string, sender: string, message: Record<string, unknown>, object = 'page') =>
  ({ object, entry: [{ id: page, time: 1, messaging: [{ sender: { id: sender }, recipient: { id: page }, timestamp: 1, message: { mid: `m_${mid++}`, ...message } }] }] });
const whatsapp = (value: Record<string, unknown>) =>
  ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: WA }, ...value } }] }] });

describe('inbox: Facebook Messenger, Instagram, WhatsApp', () => {
  it('connects each account after checking the credentials with Meta; never shows the token or app secret', async () => {
    const { c } = await signup();
    const ms = await connect(c, 'messenger', PAGE);
    expect(ms.status).toBe(201);
    expect(ms.body).toMatchObject({ kind: 'messenger', name: 'Acme Robotics', status: 'active', config: { accountId: PAGE, accountName: 'Acme Robotics' } });
    expect(ms.body.config.webhookUrl).toBe(`${config.appUrl.replace(/\/$/, '')}/api/v1/hooks/meta/${ms.body.publicKey}`);
    expect(ms.body.config.verifyToken).toMatch(/^[0-9a-f]{48}$/);
    expect(fake.subscribed).toContain(PAGE); // the Page is subscribed to the app's webhook
    expect((await connect(c, 'instagram', IG)).body).toMatchObject({ name: '@acme.robotics' });
    expect((await connect(c, 'whatsapp', WA)).body).toMatchObject({ name: 'Acme · +855 23 999 000' });

    const listed = JSON.stringify((await c.get('/channels')).body);
    expect(listed).not.toContain(GOOD);
    expect(listed).not.toContain(SECRET);
    const row = (await pool.query(`SELECT secret FROM channels WHERE id = $1`, [ms.body.id])).rows[0];
    expect(row.secret).not.toContain(GOOD);
    expect(JSON.parse(openSecret(row.secret))).toEqual({ accessToken: GOOD, appSecret: SECRET });
    const audit = JSON.stringify((await pool.query(`SELECT changes FROM audit_events WHERE entity_type = 'channel' AND entity_id = $1`, [ms.body.id])).rows);
    expect(audit).not.toContain(GOOD);

    // Explained refusals.
    expect((await connect(c, 'messenger', PAGE)).status).toBe(409);
    const bad = await c.post('/channels', { kind: 'messenger', accountId: '1212121', accessToken: 'EXPIRED_token_abcdefghijklmnop', appSecret: SECRET });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/did not accept this access token/);
    const wrongId = await connect(c, 'whatsapp', '9999999');
    expect(wrongId.status).toBe(422);
    expect(wrongId.body.error.message).toMatch(/couldn’t find this phone number ID/);
    expect((await connect(c, 'whatsapp', WA, { appSecret: 'nothex' })).status).toBe(400);
    const rep = await inviteUser(c, 'Sales rep');
    expect((await connect(rep.c, 'whatsapp', '4444444')).status).toBe(403);
  });

  it('answers Meta’s webhook check and refuses unsigned or wrongly signed events', async () => {
    const { c } = await signup();
    const ch = (await connect(c, 'messenger', PAGE)).body;
    const app = await getApp();
    const verify = (token: string) => app.inject({ method: 'GET', url: `/api/v1/hooks/meta/${ch.publicKey}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345` });
    const ok = await verify(ch.config.verifyToken);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    expect((await verify('wrong')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/hooks/meta/nope?hub.mode=subscribe` })).statusCode).toBe(404);
    expect((await hook(ch.publicKey, messenger(PAGE, '5550001', { text: 'hi' }), 'f'.repeat(32))).statusCode).toBe(401);
    const unsigned = await app.inject({ method: 'POST', url: `/api/v1/hooks/meta/${ch.publicKey}`, payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(401);
    expect((await c.get('/inbox/conversations')).body.data).toHaveLength(0);
  });

  it('receives messages from all three, routed by account within the workspace only; links WhatsApp numbers to contacts', async () => {
    const { c } = await signup();
    const ms = (await connect(c, 'messenger', PAGE)).body;
    const ig = (await connect(c, 'instagram', IG)).body;
    await connect(c, 'whatsapp', WA);
    const dara = (await c.post('/contacts', { firstName: 'Sok', lastName: 'Dara', methods: [{ kind: 'phone', value: '+855 12 345 678' }] })).body;
    // Another workspace connected the same Page (e.g. a test workspace): it must never see this workspace's events.
    const other = await signup();
    const otherMs = (await connect(other.c, 'messenger', PAGE)).body;

    // Messenger: text (name looked up), a photo, our own echo (skipped), a retry of the same message (skipped).
    const first = messenger(PAGE, '5550001', { text: 'Do you ship to Siem Reap?' });
    expect((await hook(ms.publicKey, first)).statusCode).toBe(200);
    await hook(ms.publicKey, first);
    await hook(ms.publicKey, messenger(PAGE, '5550001', { attachments: [{ type: 'image', payload: { url: `${base}/cdn/msg-img` } }] }));
    await hook(ms.publicKey, messenger(PAGE, '5550001', { text: 'Our reply', is_echo: true }));
    // Instagram, delivered to the Messenger channel's URL (one Meta app, one callback URL): routed by account id.
    await hook(ms.publicKey, messenger(IG, '7770001', { text: 'Price of the X2 arm?' }, 'instagram'));
    // WhatsApp: name from the webhook; the number matches a contact.
    await hook(ig.publicKey, whatsapp({ contacts: [{ wa_id: '85512345678', profile: { name: 'Dara' } }], messages: [{ from: '85512345678', id: 'wamid.in.1', type: 'text', text: { body: 'Hello from WhatsApp' } }] }));
    await hook(ms.publicKey, whatsapp({ messages: [{ from: '85512345678', id: 'wamid.in.2', type: 'document', document: { id: 'media-in-1', filename: 'po.pdf', mime_type: 'application/pdf', caption: 'Our order' } }] }));
    // Unknown accounts are ignored (Meta still gets 200).
    expect((await hook(ms.publicKey, messenger('8888888', '5550001', { text: 'elsewhere' }))).statusCode).toBe(200);

    const convs = (await c.get('/inbox/conversations')).body.data;
    expect(convs.map((x: any) => [x.channelKind, x.title]).sort()).toEqual([['instagram', 'Ina Insta'], ['messenger', 'Ada Lovelace'], ['whatsapp', 'Dara']]);
    const wa = convs.find((x: any) => x.channelKind === 'whatsapp');
    expect(wa.contactId).toBe(dara.id);
    const msConv = convs.find((x: any) => x.channelKind === 'messenger');
    let thread = (await c.get(`/inbox/conversations/${msConv.id}`)).body;
    expect(thread.messages.map((m: any) => m.body)).toEqual(['Do you ship to Siem Reap?', '[Photo]']);
    expect(thread.messages[1].files[0]).toMatchObject({ status: 'pending', contentType: 'image/jpeg' });
    expect((await c.get(`/inbox/conversations/${wa.id}`)).body.messages.map((m: any) => m.body)).toEqual(['Hello from WhatsApp', '[File: po.pdf] Our order']);

    // Files are downloaded by the job queue (the WhatsApp one through the media endpoint, with the token).
    await drainJobs();
    thread = (await c.get(`/inbox/conversations/${msConv.id}`)).body;
    expect(thread.messages[1].files[0]).toMatchObject({ status: 'stored', contentType: 'image/png', sizeBytes: PNG.length });
    const doc = (await c.get(`/inbox/conversations/${wa.id}`)).body.messages[1].files[0];
    expect(doc).toMatchObject({ status: 'stored', fileName: 'po.pdf', contentType: 'application/pdf' });

    // The other workspace got nothing from these; its own URL and secret only reach its own channel.
    expect((await other.c.get('/inbox/conversations')).body.data).toHaveLength(0);
    await hook(otherMs.publicKey, messenger(PAGE, '5550001', { text: 'to the other workspace' }));
    expect((await other.c.get('/inbox/conversations')).body.data).toHaveLength(1);
    expect((await c.get('/inbox/conversations')).body.data).toHaveLength(3);

    // A disabled channel stores nothing.
    await c.patch(`/channels/${ms.id}`, { status: 'disabled' });
    await hook(ig.publicKey, messenger(PAGE, '5550001', { text: 'while disabled' }));
    expect((await c.get(`/inbox/conversations/${msConv.id}`)).body.messages).toHaveLength(2);
  });

  it('replies (text and files), shows typing, and explains Meta’s refusals; an expired token flags the channel', async () => {
    const { c } = await signup();
    const ms = (await connect(c, 'messenger', PAGE)).body;
    const wa = (await connect(c, 'whatsapp', WA)).body;
    await hook(ms.publicKey, messenger(PAGE, '5550001', { text: 'Hi' }));
    await hook(ms.publicKey, messenger(PAGE, '5550024', { text: 'Old chat' }));
    await hook(ms.publicKey, whatsapp({ contacts: [{ wa_id: '85511111111', profile: { name: 'Vibol' } }], messages: [{ from: '85511111111', id: 'wamid.in.9', type: 'text', text: { body: 'Hi' } }] }));
    await hook(ms.publicKey, whatsapp({ messages: [{ from: '85500000024', id: 'wamid.in.10', type: 'text', text: { body: 'Hi' } }] }));
    const convs = (await c.get('/inbox/conversations')).body.data;
    const conv = (title: string) => convs.find((x: any) => x.title === title).id;
    const ada = conv('Ada Lovelace'), old = conv('Messenger user 0024'), vibol = conv('Vibol'), late = conv('+85500000024');

    // Typing shows on Messenger (once per 4 s).
    await c.post(`/inbox/conversations/${ada}/typing`);
    await c.post(`/inbox/conversations/${ada}/typing`);
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.typing.filter((t) => t.recipient.id === '5550001')).toEqual([{ recipient: { id: '5550001' }, sender_action: 'typing_on' }]);

    await c.post(`/inbox/conversations/${ada}/messages`, { body: 'Yes, we do.' });
    await c.post(`/inbox/conversations/${vibol}/messages`, { body: 'Sues sdei! ' + 'ក'.repeat(10) });
    await c.post(`/inbox/conversations/${old}/messages`, { body: 'Hello again' });
    await c.post(`/inbox/conversations/${late}/messages`, { body: 'Hello again' });
    await c.upload(`/inbox/conversations/${vibol}/files?fileName=arm.png&caption=${encodeURIComponent('The X2 arm')}`, PNG, { 'x-file-type': 'image/png' });
    await drainJobs();
    expect(fake.sent.find((s) => s.recipient?.id === '5550001')).toEqual({ path: 'me/messages', recipient: { id: '5550001' }, messaging_type: 'RESPONSE', message: { text: 'Yes, we do.' } });
    expect(fake.sent.find((s) => s.to === '85511111111' && s.type === 'text')).toMatchObject({ path: `${WA}/messages`, messaging_product: 'whatsapp', text: { body: 'Sues sdei! ' + 'ក'.repeat(10), preview_url: false } });
    // The file: uploaded to WhatsApp's media endpoint, then sent as an image with the caption.
    expect(fake.uploads.find((u) => u.path === `${WA}/media`)).toMatchObject({ fields: { messaging_product: 'whatsapp', type: 'image/png' }, file: { name: 'arm.png', size: PNG.length } });
    expect(fake.sent.find((s) => s.type === 'image')).toMatchObject({ to: '85511111111', image: { id: 'media-up-1', caption: 'The X2 arm' } });

    const last = async (id: number) => (await c.get(`/inbox/conversations/${id}`)).body.messages.at(-1);
    expect(await last(ada)).toMatchObject({ status: 'sent', body: 'Yes, we do.' });
    expect((await last(old)).status).toBe('failed');
    expect((await last(old)).error).toMatch(/within 24 hours of the customer’s last message/);
    expect((await last(late)).error).toMatch(/24 hours.*approved template/);

    // WhatsApp reports a delivery failure later: the message turns failed with the reason.
    const sentText = (await c.get(`/inbox/conversations/${vibol}`)).body.messages.find((m: any) => m.body.startsWith('Sues'));
    const wamid = (await pool.query('SELECT external_id FROM messages WHERE id = $1', [sentText.id])).rows[0].external_id;
    expect(wamid).toMatch(/^wamid\.out\./);
    await hook(wa.publicKey, whatsapp({ statuses: [{ id: wamid, status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }] }));
    expect((await c.get(`/inbox/conversations/${vibol}`)).body.messages.find((m: any) => m.id === sentText.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not deliver/) });

    // The token expires: the reply fails, the channel needs attention; new credentials bring it back.
    fake.expired = true;
    await c.post(`/inbox/conversations/${ada}/messages`, { body: 'Still there?' });
    await drainJobs();
    expect((await last(ada)).error).toMatch(/no longer accepts this channel’s access token/);
    expect((await c.get('/channels')).body.data.find((x: any) => x.id === ms.id)).toMatchObject({ status: 'error', lastError: expect.stringMatching(/access token/) });
    fake.expired = false;
    const fixed = await c.patch(`/channels/${ms.id}`, { accessToken: 'GOOD_new_token_abcdefghijklmnopqr', appSecret: SECRET });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ status: 'active', lastError: null });
    expect(JSON.parse(openSecret((await pool.query('SELECT secret FROM channels WHERE id = $1', [ms.id])).rows[0].secret)).accessToken).toBe('GOOD_new_token_abcdefghijklmnopqr');
    expect((await c.patch(`/channels/${ms.id}`, { accessToken: 'GOOD_only_token_abcdefghijklmnop' })).status).toBe(400); // both together
  });

  it('WhatsApp templates: list the approved ones, send one after the 24-hour window, explain refusals', async () => {
    const { c } = await signup();
    // Without the business account id: explained. With a wrong one: refused.
    const wa = (await connect(c, 'whatsapp', WA)).body;
    expect(wa.config.businessAccountId).toBeNull();
    await hook(wa.publicKey, whatsapp({ contacts: [{ wa_id: '85500000024', profile: { name: 'Late Customer' } }], messages: [{ from: '85500000024', id: 'wamid.t.1', type: 'text', text: { body: 'Hi' } }] }));
    const conv = (await c.get('/inbox/conversations')).body.data[0].id;
    const noWaba = await c.get(`/inbox/conversations/${conv}/templates`);
    expect(noWaba.status).toBe(409);
    expect(noWaba.body.error.message).toMatch(/Add the WhatsApp Business Account ID/);
    expect((await c.patch(`/channels/${wa.id}`, { businessAccountId: '9999999' })).status).toBe(422);
    expect((await c.patch(`/channels/${wa.id}`, { businessAccountId: WABA })).body.config.businessAccountId).toBe(WABA);

    // Only approved templates with text the Inbox can fill (no image headers).
    const list = (await c.get(`/inbox/conversations/${conv}/templates`)).body.data;
    expect(list.map((t: any) => `${t.name}/${t.language}`)).toEqual(['follow_up/km', 'gone/en_US', 'order_ready/en_US']);
    expect(list.find((t: any) => t.name === 'order_ready')).toMatchObject({ header: 'Acme Robotics', footer: 'Reply STOP to opt out', params: 2, category: 'UTILITY' });

    // Checked before queueing: the right number of values, an approved template.
    expect((await c.post(`/inbox/conversations/${conv}/templates`, { name: 'order_ready', language: 'en_US', params: ['Dara'] })).status).toBe(400);
    expect((await c.post(`/inbox/conversations/${conv}/templates`, { name: 'pending_review', language: 'en_US' })).status).toBe(422);
    const sent = await c.post(`/inbox/conversations/${conv}/templates`, { name: 'order_ready', language: 'en_US', params: ['Dara', '#1042'] });
    expect(sent.status).toBe(201);
    await c.post(`/inbox/conversations/${conv}/templates`, { name: 'gone', language: 'en_US' });
    await drainJobs();
    // Delivered as a template (allowed after 24 hours), shown in the thread as the customer sees it.
    expect(fake.sent.find((s) => s.type === 'template' && s.template.name === 'order_ready')).toEqual({
      path: `${WA}/messages`, messaging_product: 'whatsapp', recipient_type: 'individual', to: '85500000024', type: 'template',
      template: { name: 'order_ready', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Dara' }, { type: 'text', text: '#1042' }] }] },
    });
    const msgs = (await c.get(`/inbox/conversations/${conv}`)).body.messages;
    const tm = msgs.find((m: any) => m.id === sent.body.id);
    expect(tm).toMatchObject({ status: 'sent', isTemplate: true, body: 'Acme Robotics\n\nHi Dara, your order #1042 is ready for pickup.\n\nReply STOP to opt out' });
    expect(msgs.at(-1)).toMatchObject({ status: 'failed', error: expect.stringMatching(/doesn’t exist \(any more\)/) });

    // Not for other channels; not for people who can only read; not across workspaces.
    const ms = (await connect(c, 'messenger', PAGE)).body;
    await hook(ms.publicKey, messenger(PAGE, '5550001', { text: 'hi' }));
    const msConv = (await c.get('/inbox/conversations')).body.data.find((x: any) => x.channelKind === 'messenger').id;
    expect((await c.get(`/inbox/conversations/${msConv}/templates`)).status).toBe(409);
    const viewer = await inviteUser(c, 'Viewer');
    expect((await viewer.c.post(`/inbox/conversations/${conv}/templates`, { name: 'follow_up', language: 'km' })).status).toBe(403);
    const other = await signup();
    expect((await other.c.get(`/inbox/conversations/${conv}/templates`)).status).toBe(404);
  });

  it('splits long replies by character, never inside an emoji', () => {
    expect(splitText('ab😀cd', 3)).toEqual(['ab😀', 'cd']);
    expect(splitText('', 10)).toEqual(['']);
  });
});

describe('incoming Meta file URLs (they come from a payload signed with the workspace’s own app secret)', () => {
  it('only Meta CDN hosts over https, or the configured Graph origin', () => {
    for (const ok of ['https://scontent.xx.fbcdn.net/v/t1/a.jpg?x=1', 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1', 'https://scontent.cdninstagram.com/a.jpg', `${config.meta.graphUrl}/cdn/x`]) {
      expect(metaFileUrlAllowed(ok)).toBe(true);
    }
    for (const bad of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:5432/', 'https://127.0.0.1/x', 'http://scontent.xx.fbcdn.net/a.jpg',
      'https://fbcdn.net.evil.example/a.jpg', 'https://evilfbcdn.net/a.jpg', 'https://scontent.fbcdn.net:8443/a.jpg', 'https://u:p@scontent.fbcdn.net/a', 'file:///etc/passwd', 'not a url']) {
      expect(metaFileUrlAllowed(bad)).toBe(false);
    }
  });
});
