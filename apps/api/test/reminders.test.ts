import { afterAll, describe, expect, it } from 'vitest';
import { ct } from '@crm/shared';
import { pool } from '../src/db/pool.ts';
import { runPaymentReminders, reminderSteps } from '../src/routes/reminders.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const at = (day: string, hhmm = '10:00') => new Date(`${day}T${hhmm}:00Z`);
const DUE = '2026-12-15';

/** A sent invoice of $100 emailed to ap@umbrella.test, due on DUE; reminders on (3 days before, on the day, 7 after). */
async function setup(opts: { enabled?: boolean } = {}) {
  const s = await signup();
  const { c } = s;
  const settings = (await c.get('/settings/documents')).body;
  expect(settings.reminders).toEqual({ enabled: false, beforeDays: 3, onDue: true, afterDays: [7], telegram: true, whatsapp: { channelId: null, name: '', language: '', params: [] } });
  await c.put('/settings/documents', { ...settings, reminders: { enabled: opts.enabled ?? true, beforeDays: 3, onDue: true, afterDays: [7], telegram: true } });
  const deal = (await c.post('/deals', { title: 'Arms' })).body;
  await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: '100', quantity: 1, unit: 'pcs' }] });
  const inv = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
  await c.post(`/documents/${inv.id}/email`, { to: ['ap@umbrella.test'], subject: 'Invoice', message: 'Hello' });
  await pool.query(`UPDATE documents SET due_date = $1, issue_date = '2026-11-20' WHERE id = $2`, [DUE, inv.id]);
  return { ...s, deal, inv };
}
const remindersOf = async (docId: number) => (await pool.query(`SELECT step FROM invoice_reminders WHERE document_id = $1 ORDER BY id`, [docId])).rows.map((r) => r.step);
/** Runs the worker but only counts this invoice (other test files' workspaces may have reminders too). */
const run = async (docId: number, now: Date) => { const before = (await remindersOf(docId)).length; await runPaymentReminders(now); return (await remindersOf(docId)).length - before; };

describe('payment reminders', () => {
  it('settings are validated', async () => {
    const { c } = await signup();
    const s = (await c.get('/settings/documents')).body;
    expect((await c.put('/settings/documents', { ...s, reminders: { ...s.reminders, afterDays: [100] } })).status).toBe(400);
    expect((await c.put('/settings/documents', { ...s, reminders: { ...s.reminders, afterDays: [1, 2, 3, 4] } })).status).toBe(400);
    expect((await c.put('/settings/documents', { ...s, reminders: { ...s.reminders, afterDays: [14, 7, 7] } })).body.reminders.afterDays).toEqual([7, 14]);
    expect(reminderSteps({ enabled: true, beforeDays: null, onDue: false, afterDays: [7, 14], telegram: false }, DUE).map((x) => x.date)).toEqual(['2026-12-22', '2026-12-29']);
  });

  it('before, on and after the due date — once each, after 9:00, with the PDF and the pay link', async () => {
    const { inv, deal, c } = await setup();
    const jobsBefore = (await pool.query(`SELECT coalesce(max(id), 0) AS id FROM jobs`)).rows[0].id;
    expect(await run(inv.id, at(addDays(DUE, -4)))).toBe(0); // too early
    expect(await run(inv.id, at(addDays(DUE, -3), '08:30'))).toBe(0); // before 9:00
    expect(await run(inv.id, at(addDays(DUE, -3)))).toBe(1);
    expect(await run(inv.id, at(addDays(DUE, -3), '15:00'))).toBe(0); // same day again
    expect(await run(inv.id, at(addDays(DUE, -2)))).toBe(0);
    expect(await run(inv.id, at(DUE))).toBe(1);
    expect(await run(inv.id, at(addDays(DUE, 7)))).toBe(1);
    expect(await run(inv.id, at(addDays(DUE, 8)))).toBe(0);
    expect(await remindersOf(inv.id)).toEqual(['before:3', 'due', 'after:7']);

    // Only this invoice's workspace: runPaymentReminders() covers every workspace in the shared test database, and
    // other files' invoices (also emailed to ap@umbrella.test) can fall due inside the dates simulated here.
    const mails = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND id > $1 AND payload->>'to' = 'ap@umbrella.test'
      AND workspace_id = (SELECT workspace_id FROM documents WHERE id = $2) ORDER BY id`, [jobsBefore, inv.id])).rows.map((r) => r.payload);
    expect(mails).toHaveLength(3);
    expect(mails[0].subject).toMatch(/^Payment reminder: invoice INV-\d+ from /);
    expect(mails[0].text).toContain('for $100.00 is due on Dec 15, 2026.');
    expect(mails[1].text).toContain('is due today.');
    expect(mails[2].text).toContain('was due on Dec 15, 2026. If you have already paid, thank you');
    expect(mails[0].attachments[0]).toMatchObject({ contentType: 'application/pdf' });
    expect(mails[0].text).toMatch(/View and pay online: http.*\/d\/[\w-]+/);
    // On the deal's timeline, as automation.
    const ev = (await c.get(`/timeline/deal/${deal.id}`)).body.items.filter((i: any) => i.type === 'event' && i.data.action === 'invoice_reminder');
    expect(ev).toHaveLength(3);
    expect(ev[0].data).toMatchObject({ actorType: 'automation', changes: { step: 'after:7', to: ['ap@umbrella.test'] } });
  });

  it('catching up: only the last 3 days, never an earlier step after a later one', async () => {
    const { inv } = await setup();
    expect(await run(inv.id, at(addDays(DUE, 5)))).toBe(0); // "due" was 5 days ago: too late; "after:7" not yet
    expect(await run(inv.id, at(addDays(DUE, 9)))).toBe(1); // "after:7", 2 days late
    expect(await remindersOf(inv.id)).toEqual(['after:7']);
  });

  it('nothing for paid, "don’t remind" or reminders-off invoices; time zone of the workspace', async () => {
    const paid = await setup();
    await paid.c.post(`/documents/${paid.inv.id}/status`, { status: 'paid' });
    expect(await run(paid.inv.id, at(DUE))).toBe(0);

    const off = await setup();
    expect((await off.c.post(`/documents/${off.inv.id}/reminders`, { off: true })).status).toBe(200);
    expect((await off.c.get(`/documents/${off.inv.id}/reminders`)).body).toMatchObject({ off: true, next: null });
    expect(await run(off.inv.id, at(DUE))).toBe(0);

    const disabled = await setup({ enabled: false });
    expect(await run(disabled.inv.id, at(DUE))).toBe(0);

    // Phnom Penh is UTC+7: 02:30 UTC is 09:30 there.
    const pp = await setup();
    await pool.query(`UPDATE workspaces SET timezone = 'Asia/Phnom_Penh' WHERE id = (SELECT workspace_id FROM documents WHERE id = $1)`, [pp.inv.id]);
    expect(await run(pp.inv.id, new Date(`${DUE}T01:30:00Z`))).toBe(0);
    expect(await run(pp.inv.id, new Date(`${DUE}T02:30:00Z`))).toBe(1);
  });

  it('Telegram chats of the deal’s contacts, in the customer language', async () => {
    const { c, inv, deal } = await setup();
    const s = (await c.get('/settings/documents')).body;
    await c.put('/settings/documents', { ...s, customerLanguage: 'km' });
    const contact = (await c.post('/contacts', { firstName: 'Dara' })).body;
    await c.patch(`/deals/${deal.id}`, { contactIds: [contact.id] });
    const ws = (await pool.query(`SELECT workspace_id FROM documents WHERE id = $1`, [inv.id])).rows[0].workspace_id;
    const ch = (await pool.query(`INSERT INTO channels (workspace_id, kind, name, public_key, config, status) VALUES ($1, 'telegram_bot', '@shop_bot', $2, '{}', 'active') RETURNING id`, [ws, `pk-${inv.id}-${Date.now()}`])).rows[0].id;
    const conv = (await pool.query(`INSERT INTO conversations (workspace_id, channel_id, external_id, title, contact_id) VALUES ($1, $2, '555', 'Dara', $3) RETURNING id`, [ws, ch, contact.id])).rows[0].id;
    expect(await run(inv.id, at(DUE))).toBe(1);
    const msg = (await pool.query(`SELECT id, body, status FROM messages WHERE conversation_id = $1`, [conv])).rows;
    expect(msg).toHaveLength(1);
    expect(msg[0].body).toContain(ct('km', 'reminderHello', { name: 'Dara' }));
    expect(msg[0].body).toContain('ត្រូវបង់នៅថ្ងៃនេះ');
    expect(msg[0].body).toMatch(/\/d\/[\w-]+/);
    expect((await c.get(`/documents/${inv.id}/reminders`)).body.sent[0]).toMatchObject({ step: 'due', chats: 1, sentTo: ['ap@umbrella.test'] });
    // Don't let the fake chat's delivery job run against a real Telegram.
    await pool.query(`DELETE FROM jobs WHERE type = 'inbox.send' AND payload->>'messageId' = $1`, [String(msg[0].id)]);
  });

  it('the invoice page: status, send now, permissions', async () => {
    const { c, inv } = await setup();
    const st = (await c.get(`/documents/${inv.id}/reminders`)).body;
    expect(st).toMatchObject({ enabled: true, off: false, owed: true, emailTo: ['ap@umbrella.test'], chats: 0, sent: [] });
    expect(st.next.step).toMatch(/^(before:3|due|after:7)$/);
    expect((await c.post(`/documents/${inv.id}/remind`)).status).toBe(200);
    expect((await c.post(`/documents/${inv.id}/remind`)).status).toBe(429); // just sent
    const sent = (await c.get(`/documents/${inv.id}/reminders`)).body.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].step).toMatch(/^manual:/);
    expect(sent[0].sentByName).toBeTruthy();

    // Nobody to remind: explained.
    const deal2 = (await c.post('/deals', { title: 'No email' })).body;
    await c.put(`/deals/${deal2.id}/line-items`, { items: [{ name: 'X', unitPrice: '5', quantity: 1, unit: 'pcs' }] });
    const inv2 = (await c.post(`/deals/${deal2.id}/documents`, { kind: 'invoice' })).body;
    await c.post(`/documents/${inv2.id}/status`, { status: 'sent' });
    expect((await c.post(`/documents/${inv2.id}/remind`)).status).toBe(422);
    // Quotes and drafts don't have them.
    const q = (await c.post(`/deals/${deal2.id}/documents`, { kind: 'quote' })).body;
    expect((await c.post(`/documents/${q.id}/remind`)).status).toBe(409);
    expect((await c.post(`/documents/${q.id}/reminders`, { off: true })).status).toBe(409);

    const { c: viewer } = await inviteUser(c, 'Viewer');
    expect((await viewer.get(`/documents/${inv.id}/reminders`)).status).toBe(200);
    expect((await viewer.post(`/documents/${inv.id}/remind`)).status).toBe(403);
    expect((await viewer.post(`/documents/${inv.id}/reminders`, { off: true })).status).toBe(403);
    const other = await signup();
    expect((await other.c.get(`/documents/${inv.id}/reminders`)).status).toBe(404);
    expect((await other.c.post(`/documents/${inv.id}/remind`)).status).toBe(404);
  });
});
