import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** Follows nextCursor through every page; returns all items and the number of pages. */
async function all(c: any, path: string, pick: (body: any) => any[]) {
  const out: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const r: any = await c.get(`${path}${cursor ? `${sep}before=${cursor}` : ''}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    out.push(...pick(r.body));
    cursor = r.body.nextCursor;
    pages++;
  } while (cursor && pages < 50);
  return { items: out, pages };
}

describe('lists that used to be cut off silently now page with "Load more"', () => {
  it('record history: notes, finished activities and changes interleave across pages, each exactly once', async () => {
    const { c } = await signup();
    const deal = (await c.post('/deals', { title: 'History deal' })).body;
    for (let i = 0; i < 12; i++) await c.post('/notes', { entityType: 'deal', entityId: deal.id, body: `Note ${i}` });
    for (let i = 0; i < 4; i++) {
      const a = (await c.post('/activities', { kind: 'task', subject: `Task ${i}`, links: [{ entityType: 'deal', entityId: deal.id }] })).body;
      await c.patch(`/activities/${a.id}`, { status: 'done' });
    }
    for (let i = 0; i < 5; i++) await c.patch(`/deals/${deal.id}`, { title: `History deal v${i}` });
    // Several items with exactly the same time, across sources.
    await pool.query(`UPDATE notes SET created_at = '2026-11-01 10:00:00.5+00' WHERE entity_id = $1 AND body IN ('Note 3','Note 4','Note 5')`, [deal.id]);
    await pool.query(`UPDATE audit_events SET created_at = '2026-11-01 10:00:00.5+00' WHERE entity_type = 'deal' AND entity_id = $1 AND action = 'updated' AND id = (SELECT min(id) FROM audit_events WHERE entity_type = 'deal' AND entity_id = $1 AND action = 'updated')`, [deal.id]);

    const first = (await c.get(`/timeline/deal/${deal.id}?limit=5`)).body;
    expect(first.items).toHaveLength(5);
    expect(first.upcoming).toEqual([]); // only on the first page
    const { items, pages } = await all(c, `/timeline/deal/${deal.id}?limit=5`, (b) => b.items);
    const keys = items.map((i) => `${i.type}-${i.data.id}`);
    expect(new Set(keys).size).toBe(keys.length); // no repeats
    expect(items.filter((i) => i.type === 'note')).toHaveLength(12);
    expect(items.filter((i) => i.type === 'activity')).toHaveLength(4);
    expect(items.filter((i) => i.type === 'event' && i.data.action === 'updated').length).toBeGreaterThanOrEqual(5);
    expect(items.some((i) => i.type === 'event' && String(i.data.action).startsWith('activity_'))).toBe(false);
    expect(pages).toBeGreaterThan(4);
    const times = items.map((i) => new Date(i.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times); // newest first throughout
    // A filter is applied by the server, so every page is full.
    const notes = await all(c, `/timeline/deal/${deal.id}?limit=5&kind=note`, (b) => b.items);
    expect(notes.items.map((i) => i.type)).toEqual(Array(12).fill('note'));
    expect(notes.pages).toBe(3);
    expect((await c.get(`/timeline/deal/${deal.id}?before=bad`)).status).toBe(400);
    // Another workspace still can't read it.
    const other = await signup();
    expect((await other.c.get(`/timeline/deal/${deal.id}`)).status).toBe(404);
  });

  it('recycle bin, notifications and import history page through everything', async () => {
    const { c, me } = await signup();
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push((await c.post('/contacts', { firstName: `Gone${i}` })).body.id);
    const co = (await c.post('/companies', { name: 'Gone Inc' })).body;
    for (const id of ids) await c.del(`/contacts/${id}`);
    await c.del(`/companies/${co.id}`);
    // Same deletion time for a contact and the company: the table breaks the tie.
    await pool.query(`UPDATE contacts SET deleted_at = '2026-11-10 08:00:00+00' WHERE id = $1`, [ids[0]]);
    await pool.query(`UPDATE companies SET deleted_at = '2026-11-10 08:00:00+00' WHERE id = $1`, [co.id]);
    const bin = await all(c, '/recycle-bin?limit=3', (b) => b.data);
    expect(bin.items.map((r) => `${r.entity}-${r.id}`).sort()).toEqual([...ids.map((id) => `contacts-${id}`), `companies-${co.id}`].sort());
    expect(bin.pages).toBe(3);
    expect((await c.get('/recycle-bin')).body.retentionDays).toBe(30);

    for (let i = 0; i < 25; i++) {
      await pool.query(`INSERT INTO notifications (workspace_id, user_id, kind, title) VALUES ($1, $2, 'test', $3)`, [me.workspace.id, me.user.id, `N${i}`]);
    }
    const first = (await c.get('/notifications?limit=10')).body;
    expect(first.data).toHaveLength(10);
    expect(first.unread).toBe(25); // the badge counts all unread, not just this page
    const notes = await all(c, '/notifications?limit=10', (b) => b.data);
    expect(new Set(notes.items.map((n) => n.title)).size).toBe(25);

    for (let i = 0; i < 4; i++) await c.post('/imports', { entityType: 'contact', fileName: `f${i}.csv`, content: 'First name\nAda\n' });
    const imports = await all(c, '/imports?entityType=contact&limit=3', (b) => b.data);
    expect(imports.items.map((i) => i.fileName).sort()).toEqual(['f0.csv', 'f1.csv', 'f2.csv', 'f3.csv']);
    expect(imports.pages).toBe(2);
  });

  it('inbox threads: the latest 50 messages, then "Load older messages"', async () => {
    const { c } = await signup();
    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const app = await getApp();
    const first = await app.inject({ method: 'POST', url: `/api/v1/public/webchat/${ch.publicKey}/messages`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ body: 'm0' }) });
    const conv = (await c.get('/inbox/conversations')).body.data[0];
    const m = (await pool.query('SELECT workspace_id FROM conversations WHERE id = $1', [conv.id])).rows[0];
    for (let i = 1; i < 120; i++) {
      await pool.query(`INSERT INTO messages (workspace_id, conversation_id, direction, body, status) VALUES ($1, $2, 'in', $3, 'received')`, [m.workspace_id, conv.id, `m${i}`]);
    }
    void first;
    const t = (await c.get(`/inbox/conversations/${conv.id}`)).body;
    expect(t.messages).toHaveLength(50);
    expect(t.messages.at(-1).body).toBe('m119');
    expect(t.hasOlder).toBe(true);
    const o1 = (await c.get(`/inbox/conversations/${conv.id}/messages?beforeId=${t.messages[0].id}`)).body;
    expect(o1.messages.map((x: any) => x.body)).toEqual(Array.from({ length: 50 }, (_, i) => `m${20 + i}`));
    expect(o1.hasOlder).toBe(true);
    const o2 = (await c.get(`/inbox/conversations/${conv.id}/messages?beforeId=${o1.messages[0].id}`)).body;
    expect(o2.messages.map((x: any) => x.body)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
    expect(o2.hasOlder).toBe(false);
    expect((await c.get(`/inbox/conversations/${conv.id}/messages`)).status).toBe(400);
    const other = await signup();
    expect((await other.c.get(`/inbox/conversations/${conv.id}/messages?beforeId=999999`)).status).toBe(404);
  });
});
