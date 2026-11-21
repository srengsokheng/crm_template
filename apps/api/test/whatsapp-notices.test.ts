import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { pool } from '../src/db/pool.ts';
import { runPaymentReminders } from '../src/routes/reminders.ts';
import { forgetTemplates } from '../src/inbox/meta.ts';
import { drainJobs, getApp, signup } from './helpers.ts';

/** Fake Graph API: number 3333333, business account 4444444 with two approved templates. */
const WA = '3333333', WABA = '4444444', GOOD = 'GOOD_token_wa_notices_abcdefghijklmn', SECRET = '0123456789abcdef0123456789abcdef';
const TEMPLATES = [
  { name: 'payment_due', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} is due. Pay here: {{3}}' }] },
  { name: 'booking_confirmed', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, you are booked for {{2}}. Change or cancel: {{3}}' }] },
];
const fake = { sent: [] as any[], templates: TEMPLATES };
let server: Server;

beforeAll(async () => {
  let n = 1;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!String(req.headers.authorization).startsWith('Bearer GOOD')) return reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
      const path = new URL(req.url ?? '/', 'http://x').pathname.slice(1);
      if (req.method === 'GET') {
        if (path === WA) return reply(200, { id: WA, verified_name: 'Acme', display_phone_number: '+855 23 999 000' });
        if (path === WABA) return reply(200, { id: WABA, name: 'Acme WABA' });
        if (path === `${WABA}/message_templates`) return reply(200, { data: fake.templates });
        return reply(400, { error: { message: 'Unsupported', code: 100 } });
      }
      if (path === `${WA}/messages`) { fake.sent.push(JSON.parse(raw)); return reply(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.n.${n++}` }] }); }
      reply(404, { error: { message: 'Unknown path', code: 803 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.meta.graphUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await (await getApp()).close(); await pool.end(); });

async function whatsappChannel(c: any) {
  const ch = (await c.post('/channels', { kind: 'whatsapp', accountId: WA, accessToken: GOOD, appSecret: SECRET })).body;
  expect((await c.patch(`/channels/${ch.id}`, { businessAccountId: WABA })).status).toBe(200);
  return ch;
}
const params = (m: any) => m.template.components?.[0]?.parameters?.map((p: any) => p.text) ?? [];
const DUE = '2026-12-15';
const at = (day: string) => new Date(`${day}T10:00:00Z`);

describe('WhatsApp payment reminders and booking confirmations', () => {
  it('reminders: to the contact’s number (a chat is started) or their chat, blanks filled; email or not', async () => {
    const { c } = await signup();
    const ch = await whatsappChannel(c);
    const s = (await c.get('/settings/documents')).body;
    // A template must be picked with the channel.
    expect((await c.put('/settings/documents', { ...s, reminders: { ...s.reminders, whatsapp: { channelId: ch.id } } })).status).toBe(400);
    await c.put('/settings/documents', { ...s, reminders: { ...s.reminders, enabled: true, onDue: true,
      whatsapp: { channelId: ch.id, name: 'payment_due', language: 'en_US', params: ['name', 'amount', 'link'] } } });

    const dara = (await c.post('/contacts', { firstName: 'Dara', lastName: 'Sok', methods: [{ kind: 'phone', value: '+855 12 345 678' }] })).body;
    const deal = (await c.post('/deals', { title: 'Arms', contactIds: [dara.id] })).body;
    await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: '100', quantity: 1, unit: 'pcs' }] });
    const inv = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
    await c.patch(`/documents/${inv.id}`, { billToName: 'Umbrella Foods' });
    await c.post(`/documents/${inv.id}/status`, { status: 'sent' }); // not emailed: WhatsApp is the only way to reach them
    await pool.query(`UPDATE documents SET due_date = $1, issue_date = '2026-11-20' WHERE id = $2`, [DUE, inv.id]);
    expect((await c.get(`/documents/${inv.id}/reminders`)).body).toMatchObject({ emailTo: [], whatsapp: 1 });

    fake.sent.length = 0;
    await runPaymentReminders(at(DUE));
    await drainJobs();
    const msg = fake.sent.find((m) => m.to === '85512345678');
    expect(msg).toMatchObject({ type: 'template', template: { name: 'payment_due', language: { code: 'en_US' } } });
    const [name, amount, link] = params(msg);
    expect([name, amount]).toEqual(['Umbrella Foods', '$100.00']);
    expect(link).toMatch(/\/d\/[\w-]+$/);
    // The chat was started in the Inbox, linked to Dara, with the message in it.
    const conv = (await pool.query(`SELECT id, contact_id::int AS contact FROM conversations WHERE channel_id = $1 AND external_id = '85512345678'`, [ch.id])).rows[0];
    expect(conv.contact).toBe(dara.id);
    const thread = (await c.get(`/inbox/conversations/${conv.id}`)).body.messages;
    expect(thread.at(-1)).toMatchObject({ direction: 'out', status: 'sent', isTemplate: true, body: expect.stringContaining('$100.00 is due') });
    expect((await c.get(`/documents/${inv.id}/reminders`)).body.sent[0]).toMatchObject({ whatsapp: 1, sentTo: [] });

    // Sent by hand later: the existing chat is used (no second chat for the same number).
    await pool.query(`UPDATE invoice_reminders SET sent_at = now() - interval '1 hour' WHERE document_id = $1`, [inv.id]);
    expect((await c.post(`/documents/${inv.id}/remind`)).status).toBe(200);
    await drainJobs();
    expect((await pool.query(`SELECT count(*)::int AS n FROM conversations WHERE channel_id = $1`, [ch.id])).rows[0].n).toBe(1);
    expect(fake.sent.filter((m) => m.to === '85512345678')).toHaveLength(2);

    // The template withdrawn by Meta: no WhatsApp message, the email still goes.
    fake.templates = TEMPLATES.filter((t) => t.name !== 'payment_due');
    forgetTemplates(ch.id);
    try {
      const deal2 = (await c.post('/deals', { title: 'Arms 2', contactIds: [dara.id] })).body;
      await c.put(`/deals/${deal2.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: '50', quantity: 1, unit: 'pcs' }] });
      const inv2 = (await c.post(`/deals/${deal2.id}/documents`, { kind: 'invoice' })).body;
      await c.post(`/documents/${inv2.id}/email`, { to: ['ap@umbrella.test'], subject: 'Invoice', message: 'Hi' });
      await pool.query(`UPDATE documents SET due_date = $1, issue_date = '2026-11-20' WHERE id = $2`, [DUE, inv2.id]);
      const sentBefore = fake.sent.length;
      await runPaymentReminders(at(DUE));
      await drainJobs();
      expect(fake.sent.length).toBe(sentBefore);
      const row = (await pool.query(`SELECT whatsapp, sent_to FROM invoice_reminders WHERE document_id = $1`, [inv2.id])).rows[0];
      expect(row).toEqual({ whatsapp: 0, sent_to: ['ap@umbrella.test'] });
      const mail = (await pool.query(`SELECT 1 FROM jobs WHERE type = 'email.send' AND payload->>'to' = 'ap@umbrella.test' AND payload->>'subject' LIKE 'Payment reminder%'
        AND workspace_id = (SELECT workspace_id FROM documents WHERE id = $1)`, [inv2.id])).rows;
      expect(mail.length).toBeGreaterThan(0);
    } finally { fake.templates = TEMPLATES; forgetTemplates(ch.id); }
  });

  it('booking pages: confirmation and moves by WhatsApp to the number typed when booking', async () => {
    const { c, me } = await signup();
    const ch = await whatsappChannel(c);
    const slug = `wa-${Date.now().toString(36)}`;
    const p = (await c.post('/booking-pages', { title: 'Showroom visit', slug, hostId: me.user.id, durationMinutes: 30, days: [1, 2, 3, 4, 5, 6, 7],
      start: '00:00', end: '23:30', minNoticeHours: 1, daysAhead: 3, video: false,
      whatsapp: { channelId: ch.id, name: 'booking_confirmed', language: 'en_US', params: ['name', 'when', 'link'] } })).body;
    expect(p.whatsapp).toMatchObject({ channelId: ch.id, name: 'booking_confirmed' });
    const app = await getApp();
    const slots = (await app.inject({ method: 'GET', url: `/api/v1/public/book/${slug}` })).json().days.flatMap((d: any) => d.slots);
    fake.sent.length = 0;
    const r = await app.inject({ method: 'POST', url: `/api/v1/public/book/${slug}`, headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ start: slots[0], name: 'Vanna Chea', email: 'vanna@wa.test', phone: '+855 98 765 432' }) });
    expect(r.statusCode).toBe(201);
    await drainJobs();
    const confirm = fake.sent.find((m) => m.to === '85598765432');
    expect(confirm?.template?.name).toBe('booking_confirmed');
    const [name, when, link] = params(confirm);
    expect(name).toBe('Vanna Chea');
    expect(when).toMatch(/\d\d:\d\d$/);
    expect(link).toMatch(/\/booking\/[\w-]+$/);
    // Moved by the customer: told again on WhatsApp, same chat.
    const token = link.split('/booking/')[1];
    const free = (await app.inject({ method: 'GET', url: `/api/v1/public/bookings/${token}/slots` })).json().days.flatMap((d: any) => d.slots);
    expect((await app.inject({ method: 'POST', url: `/api/v1/public/bookings/${token}/reschedule`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ start: free[2] }) })).statusCode).toBe(200);
    await drainJobs();
    expect(fake.sent.filter((m) => m.to === '85598765432')).toHaveLength(2);
    expect((await pool.query(`SELECT count(*)::int AS n FROM conversations WHERE channel_id = $1`, [ch.id])).rows[0].n).toBe(1);
    // Pages without WhatsApp don't send anything.
    const quiet = `quiet-${Date.now().toString(36)}`;
    await c.post('/booking-pages', { title: 'Quiet', slug: quiet, hostId: me.user.id, durationMinutes: 30, days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:30', minNoticeHours: 1, daysAhead: 3, video: false });
    const qs = (await app.inject({ method: 'GET', url: `/api/v1/public/book/${quiet}` })).json().days.flatMap((d: any) => d.slots);
    const before = fake.sent.length;
    await app.inject({ method: 'POST', url: `/api/v1/public/book/${quiet}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ start: qs[5], name: 'Bo', email: 'bo@wa.test', phone: '+855 11 111 111' }) });
    await drainJobs();
    expect(fake.sent.length).toBe(before);
  });
});
