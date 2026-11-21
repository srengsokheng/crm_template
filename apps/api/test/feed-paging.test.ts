import { afterAll, describe, expect, it } from 'vitest';
import { feedQuery, feedResult } from '../src/lib/list.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('feed paging (cursor, "Load more")', () => {
  it('parses limits and cursors safely', () => {
    expect(feedQuery({})).toEqual({ limit: 50, after: null });
    expect(feedQuery({ limit: '500' }).limit).toBe(100); // capped
    expect(feedQuery({ limit: 'x' }).limit).toBe(50);
    const c = Buffer.from('1794903919123456|42').toString('base64url');
    expect(feedQuery({ before: c }).after).toEqual({ us: 1794903919123456, id: 42 });
    expect(() => feedQuery({ before: 'not-a-cursor' })).toThrow(/Invalid cursor/);
    expect(() => feedQuery({ before: Buffer.from("1|1; DROP TABLE x").toString('base64url') })).toThrow(/Invalid cursor/);
    const rows = [{ id: 3, feed_us: 30 }, { id: 2, feed_us: 20 }, { id: 1, feed_us: 10 }];
    const r = feedResult(rows, { limit: 2, after: null });
    expect(r.data).toEqual([{ id: 3 }, { id: 2 }]); // feed_us is not sent to clients
    expect(Buffer.from(r.nextCursor!, 'base64url').toString()).toBe('20|2');
    expect(feedResult(rows, { limit: 3, after: null }).nextCursor).toBeNull();
  });

  it('inbox conversations page through every row exactly once, even with identical times', async () => {
    const { c } = await signup();
    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const app = await getApp();
    for (let i = 0; i < 7; i++) {
      await app.inject({ method: 'POST', url: `/api/v1/public/webchat/${ch.publicKey}/messages`, headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ body: `hello ${i}`, name: `Visitor ${i}` }) });
    }
    // Four of them share exactly the same time (microseconds included): the id breaks the tie.
    await pool.query(`UPDATE conversations SET last_message_at = '2026-11-17 10:00:00.123456+00'
      WHERE channel_id = $1 AND title IN ('Visitor 1', 'Visitor 2', 'Visitor 3', 'Visitor 4')`, [ch.id]);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = (await c.get(`/inbox/conversations?limit=3${cursor ? `&before=${cursor}` : ''}`)).body;
      expect(r.data.length).toBeLessThanOrEqual(3);
      seen.push(...r.data.map((x: any) => x.title));
      cursor = r.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7); // no duplicates, nothing skipped
    expect((await c.get('/inbox/conversations?before=garbage')).status).toBe(400);
    // status=all includes closed ones.
    const one = (await c.get('/inbox/conversations?limit=1')).body.data[0];
    await c.patch(`/inbox/conversations/${one.id}`, { status: 'closed' });
    expect((await c.get('/inbox/conversations?limit=100')).body.data).toHaveLength(6);
    expect((await c.get('/inbox/conversations?status=all&limit=100')).body.data).toHaveLength(7);
  });
});
