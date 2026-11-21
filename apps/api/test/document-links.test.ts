import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const items = [{ name: 'Robot arm X2', unitPrice: '1250.50', quantity: 2, unit: 'pcs' }];
async function doc(c: any, kind: 'quote' | 'invoice', send = true) {
  const deal = (await c.post('/deals', { title: `Arms (${kind})` })).body;
  await c.put(`/deals/${deal.id}/line-items`, { items });
  const d = (await c.post(`/deals/${deal.id}/documents`, { kind })).body;
  return { deal, d: send ? (await c.post(`/documents/${d.id}/status`, { status: 'sent' })).body : d };
}
const pub = async (path: string, body?: unknown) => {
  const app = await getApp();
  const r = await app.inject(body === undefined ? { method: 'GET', url: `/api/v1/public/documents/${path}` }
    : { method: 'POST', url: `/api/v1/public/documents/${path}`, payload: body as object });
  return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, headers: r.headers };
};
const tokenOf = (url: string) => url.split('/d/')[1];

describe('customer links for quotes and invoices', () => {
  it('a sent quote gets a link; the customer views it, the team hears about it, and the customer accepts it', async () => {
    const { c, me } = await signup();
    const draft = await doc(c, 'quote', false);
    expect(draft.d.customerUrl).toBeNull(); // drafts have no link
    const { deal, d } = await doc(c, 'quote');
    expect(d.customerUrl).toMatch(/\/d\/[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(d)).not.toMatch(/publicToken/); // neither the hash nor the encrypted token leave the server
    const t = tokenOf(d.customerUrl);

    // The customer opens it: everything they need, nothing internal.
    const v = await pub(t);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ kind: 'quote', number: d.number, status: 'sent', total: '2501.00', canRespond: true, expired: false, response: null, khqr: null });
    expect(v.body.items).toEqual([expect.objectContaining({ name: 'Robot arm X2', quantity: '2.000' })]);
    expect(JSON.stringify(v.body)).not.toMatch(/workspace_id|dealId|deal_id|createdBy/);
    await pub(t); // a second view doesn't notify again
    const notes = (await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND kind = 'document'`, [me.user.id])).rows;
    expect(notes.map((n) => n.title)).toEqual([expect.stringMatching(new RegExp(`opened Quote ${d.number}$`))]);
    expect((await c.get(`/documents/${d.id}`)).body.viewedAt).toBeTruthy();
    expect((await pub(`${t}/pdf`)).headers['content-type']).toBe('application/pdf');

    // Accepting needs a name; then the quote is accepted, with who and their note; the team is told.
    expect((await pub(`${t}/accept`, { name: '' })).status).toBe(400);
    expect((await pub(`${t}/accept`, { name: 'Carlos Oliveira', note: 'Please deliver before Jan 15' })).status).toBe(200);
    const after = (await c.get(`/documents/${d.id}`)).body;
    expect(after).toMatchObject({ status: 'accepted', respondedByName: 'Carlos Oliveira', customerNote: 'Please deliver before Jan 15' });
    expect((await pub(t)).body).toMatchObject({ status: 'accepted', canRespond: false, response: { by: 'Carlos Oliveira' } });
    expect((await pub(`${t}/accept`, { name: 'Carlos Oliveira' })).status).toBe(409);
    expect((await pub(`${t}/decline`, {})).status).toBe(409);
    const titles = (await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND kind = 'document' ORDER BY id`, [me.user.id])).rows.map((n) => n.title);
    expect(titles.at(-1)).toBe(`Carlos Oliveira accepted Quote ${d.number}`);
    const history = (await c.get(`/timeline/deal/${deal.id}`)).body;
    expect(JSON.stringify(history)).toContain('quote_accepted');
    // The team can turn it into an invoice as usual.
    expect((await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice', fromQuoteId: d.id })).status).toBe(201);
  });

  it('declines, expired quotes, invoices with KHQR, the email button, and links that lead nowhere', async () => {
    const { c } = await signup();
    const q2 = (await doc(c, 'quote')).d;
    expect((await pub(`${tokenOf(q2.customerUrl)}/decline`, { reason: 'Too expensive for us this year' })).status).toBe(200);
    expect((await c.get(`/documents/${q2.id}`)).body).toMatchObject({ status: 'declined', customerNote: 'Too expensive for us this year' });

    // Past its "valid until" date: shown, but can't be accepted.
    const q3 = (await doc(c, 'quote')).d;
    await pool.query(`UPDATE documents SET due_date = current_date - 1 WHERE id = $1`, [q3.id]);
    expect((await pub(tokenOf(q3.customerUrl))).body).toMatchObject({ expired: true, canRespond: false });
    const late = await pub(`${tokenOf(q3.customerUrl)}/accept`, { name: 'Carlos Oliveira' });
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/expired/);

    // An invoice: no accepting; the KHQR shows once set up.
    const inv = (await doc(c, 'invoice')).d;
    const it = tokenOf(inv.customerUrl);
    expect((await pub(it)).body).toMatchObject({ kind: 'invoice', canRespond: false, khqr: null, balance: '2501.00' });
    expect((await pub(`${it}/accept`, { name: 'Carlos Oliveira' })).status).toBe(409);
    const s = (await c.get('/settings/documents')).body;
    await c.put('/settings/documents', { ...s, khqr: { ...s.khqr, enabled: true, accountId: 'acme@aclb', merchantName: 'Acme Robotics' } });
    expect((await pub(it)).body.khqr).toMatchObject({ amount: '2501.00', currency: 'USD', merchantName: 'Acme Robotics' });

    // Emailing it includes a "View and pay online" button with the link.
    await c.post(`/documents/${inv.id}/email`, { to: ['ap@umbrella.test'], subject: 'Invoice', message: 'Hello' });
    const job = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' ORDER BY id DESC LIMIT 1`)).rows[0].payload;
    expect(JSON.stringify(job)).toContain(inv.customerUrl);
    expect(JSON.stringify(job)).toContain('View and pay online');

    // Made-up tokens, and a deal that was deleted, lead nowhere.
    expect((await pub('x'.repeat(32))).status).toBe(404);
    await c.del(`/deals/${inv.dealId}`);
    expect((await pub(it)).status).toBe(404);

    // Sent before links existed: the page creates one for people who may edit, not for viewers.
    const old = (await doc(c, 'quote')).d;
    await pool.query(`UPDATE documents SET public_token_hash = NULL, public_token_sealed = NULL WHERE id = $1`, [old.id]);
    const viewer = await inviteUser(c, 'Viewer');
    expect((await viewer.c.get(`/documents/${old.id}`)).body.customerUrl).toBeNull();
    expect((await c.get(`/documents/${old.id}`)).body.customerUrl).toMatch(/\/d\//);
  });
});
