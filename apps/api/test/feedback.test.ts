import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { runFeedbackRequests } from '../src/routes/feedback.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const pub = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
  const r = await (await getApp()).inject({ method, url: `/api/v1/public${url}`, ...(body !== undefined ? { payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
};
const lastMail = async (to: string) => (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [to])).rows[0]?.payload;
const tokenOf = (mail: { text: string }) => /\/r\/([\w-]+)/.exec(mail.text)![1];

/** A won deal with a contact who has an email address. */
async function wonDeal(c: any, email: string, extra: Record<string, unknown> = {}) {
  const contact = (await c.post('/contacts', { firstName: 'Dara', lastName: 'Sok', methods: [{ kind: 'email', value: email }] })).body;
  const d = (await c.post('/deals', { title: `Arms for ${email}`, contactIds: [contact.id], ...extra })).body;
  expect((await c.post(`/deals/${d.id}/close`, { outcome: 'won' })).status).toBe(200);
  return { deal: d, contact };
}
const enable = async (c: any, delayDays = 2) => expect((await c.put('/settings/feedback', { enabled: true, delayDays })).status).toBe(200);
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const asked = async (dealId: number) => (await pool.query(`SELECT count(*)::int AS n FROM feedback_requests WHERE deal_id = $1`, [dealId])).rows[0].n;

describe('customer feedback', () => {
  it('asks N days after the win, once; only deals won after it was turned on; never unsubscribed contacts', async () => {
    const { c } = await signup();
    expect((await c.get('/settings/feedback')).body).toEqual({ enabled: false, delayDays: 2 });
    expect((await c.put('/settings/feedback', { enabled: true, delayDays: 31 })).status).toBe(400);
    const before = await wonDeal(c, 'early@umbrella.test'); // won before turning it on
    await pool.query(`UPDATE deals SET closed_at = now() - interval '1 hour' WHERE id = $1`, [before.deal.id]);
    await enable(c);
    const { deal } = await wonDeal(c, 'dara@umbrella.test');
    await runFeedbackRequests(days(1));
    expect(await asked(deal.id)).toBe(0); // not yet
    await runFeedbackRequests(days(2.1));
    expect(await asked(deal.id)).toBe(1);
    await runFeedbackRequests(days(3));
    expect(await asked(deal.id)).toBe(1);
    expect(await asked(before.deal.id)).toBe(0);
    const mail = await lastMail('dara@umbrella.test');
    expect(mail.subject).toMatch(/^How was your experience with /);
    expect(mail.text).toContain('Hello Dara,');
    expect(mail.text).toMatch(/Rate us: http.*\/r\/[\w-]+/);

    // Unsubscribed from emails: never asked.
    const optedOut = await wonDeal(c, 'out@umbrella.test');
    await pool.query(`UPDATE contacts SET email_opt_out_at = now() WHERE id = $1`, [optedOut.contact.id]);
    await runFeedbackRequests(days(2.1));
    expect(await asked(optedOut.deal.id)).toBe(0);
    // Turning it off stops it.
    await c.put('/settings/feedback', { enabled: false, delayDays: 2 });
    const off = await wonDeal(c, 'off@umbrella.test');
    await runFeedbackRequests(days(2.1));
    expect(await asked(off.deal.id)).toBe(0);
  });

  it('the customer rates; the owner is told; it can be changed; the deal shows it', async () => {
    const { c, me } = await signup();
    const { deal } = await wonDeal(c, 'vanna@initech.test');
    expect((await c.get(`/deals/${deal.id}/feedback`)).body).toMatchObject({ request: null, won: true, canAsk: true, autoEnabled: false });
    expect((await c.post(`/deals/${deal.id}/feedback`)).status).toBe(200);
    expect((await c.post(`/deals/${deal.id}/feedback`)).status).toBe(409); // once per deal
    const token = tokenOf(await lastMail('vanna@initech.test'));

    expect((await pub('GET', `/feedback/${token}`)).body).toMatchObject({ rating: null, lang: 'en', expired: false, owner: me.user.name });
    expect((await pub('POST', `/feedback/${token}`, { rating: 6 })).status).toBe(400);
    expect((await pub('POST', `/feedback/${token}`, { rating: 2, comment: 'Delivery was late' })).status).toBe(200);
    expect((await pub('GET', '/feedback/not-a-real-token-xxxxxxxxxxx')).status).toBe(404);
    const note = (await pool.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'feedback' ORDER BY id DESC LIMIT 1`, [me.user.id])).rows[0];
    expect(note).toEqual({ title: `Low rating: 2/5 for ${deal.title}`, body: 'Delivery was late' });
    expect((await pub('POST', `/feedback/${token}`, { rating: 4, comment: 'They called and fixed it' })).status).toBe(200);
    const fb = (await c.get(`/deals/${deal.id}/feedback`)).body;
    expect(fb).toMatchObject({ canAsk: false, request: { email: 'vanna@initech.test', rating: 4, comment: 'They called and fixed it' } });
    expect(fb.request.sentByName).toBe(me.user.name);
    const ev = (await c.get(`/timeline/deal/${deal.id}`)).body.items.filter((i: any) => i.type === 'event').map((i: any) => i.data.action);
    expect(ev).toEqual(expect.arrayContaining(['feedback_requested', 'feedback_received', 'feedback_changed']));

    // After 30 days the link is closed.
    await pool.query(`UPDATE feedback_requests SET sent_at = now() - interval '31 days' WHERE deal_id = $1`, [deal.id]);
    expect((await pub('GET', `/feedback/${token}`)).body.expired).toBe(true);
    expect((await pub('POST', `/feedback/${token}`, { rating: 5 })).status).toBe(410);
  });

  it('asking needs a won deal and someone to ask; Khmer email', async () => {
    const { c } = await signup();
    const s = (await c.get('/settings/documents')).body;
    await c.put('/settings/documents', { ...s, customerLanguage: 'km' });
    const open = (await c.post('/deals', { title: 'Open' })).body;
    expect((await c.post(`/deals/${open.id}/feedback`)).status).toBe(409);
    const noContact = (await c.post('/deals', { title: 'Nobody' })).body;
    await c.post(`/deals/${noContact.id}/close`, { outcome: 'won' });
    expect((await c.get(`/deals/${noContact.id}/feedback`)).body.canAsk).toBe(false);
    expect((await c.post(`/deals/${noContact.id}/feedback`)).status).toBe(422);
    const { deal } = await wonDeal(c, 'sophea@globex.test');
    await c.post(`/deals/${deal.id}/feedback`);
    const mail = await lastMail('sophea@globex.test');
    expect(mail.subject).toMatch(/^តើបទពិសោធន៍របស់អ្នកជាមួយ /);
    expect((await pub('GET', `/feedback/${tokenOf(mail)}`)).body.lang).toBe('km');
  });

  it('summary per salesperson follows deal permissions; settings and asking are guarded', async () => {
    const { c, me } = await signup();
    const { c: rep, id: repId } = await inviteUser(c, 'Sales rep', 'Rita Rep');
    const a = await wonDeal(c, 'one@x.test');
    const b = await wonDeal(c, 'two@x.test', { ownerId: repId });
    const cc = await wonDeal(c, 'three@x.test', { ownerId: repId });
    for (const d of [a, b, cc]) await c.post(`/deals/${d.deal.id}/feedback`);
    await pub('POST', `/feedback/${tokenOf(await lastMail('one@x.test'))}`, { rating: 5, comment: 'Great' });
    await pub('POST', `/feedback/${tokenOf(await lastMail('two@x.test'))}`, { rating: 3 });

    const all = (await c.get('/feedback/summary')).body;
    expect(all.overall).toEqual({ asked: 3, answered: 2, average: '4.0' });
    expect(all.people).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: me.user.id, asked: 1, answered: 1, average: '5.0', low: 0 }),
      expect.objectContaining({ userId: repId, name: 'Rita Rep', asked: 2, answered: 1, average: '3.0' }),
    ]));
    expect(all.comments.map((x: any) => x.comment)).toContain('Great');
    // The rep sees their team (just themselves here): their own numbers only.
    const mine = (await rep.get('/feedback/summary')).body;
    expect(mine.people.map((p: any) => p.userId)).toEqual([repId]);
    expect(mine.overall).toEqual({ asked: 2, answered: 1, average: '3.0' });

    expect((await rep.get('/settings/feedback')).status).toBe(403);
    expect((await rep.put('/settings/feedback', { enabled: true, delayDays: 1 })).status).toBe(403);
    // The rep can't ask on someone else's deal (edit rights), and other workspaces see nothing.
    const other = await wonDeal(c, 'four@x.test');
    expect((await rep.post(`/deals/${other.deal.id}/feedback`)).status).toBe(403);
    const ws2 = await signup();
    expect((await ws2.c.get(`/deals/${a.deal.id}/feedback`)).status).toBe(404);
    expect((await ws2.c.get('/feedback/summary')).body.overall).toBeNull();
  });
});
