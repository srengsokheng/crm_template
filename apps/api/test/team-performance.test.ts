import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const FROM = '2026-10-01', TO = '2026-10-31';
const report = (c: any, extra = '') => c.get(`/reports/team-performance?from=${FROM}&to=${TO}${extra}`);

/** A deal owned by `ownerId`, closed (won or lost) on a day in October. */
async function closed(c: any, ownerId: number, outcome: 'won' | 'lost', amount: string, day = '2026-10-15') {
  const d = (await c.post('/deals', { title: `${outcome} ${amount}`, amount, ownerId })).body;
  expect((await c.post(`/deals/${d.id}/close`, { outcome, ...(outcome === 'lost' ? { lostReason: 'Price' } : {}) })).status).toBe(200);
  await pool.query(`UPDATE deals SET closed_at = $1 WHERE id = $2`, [`${day}T10:00:00Z`, d.id]);
  return d;
}

/** A conversation with messages at given minutes after 2026-10-10 09:00 UTC: ['in'|'out', minute, authorId?]. */
async function chat(ws: number, msgs: [('in' | 'out'), number, number?][]) {
  const ch = (await pool.query(`INSERT INTO channels (workspace_id, kind, name, public_key, config, status) VALUES ($1, 'webchat', 'Chat', $2, '{}', 'active') RETURNING id`,
    [ws, `pk-tp-${Date.now()}-${Math.random()}`])).rows[0].id;
  const cv = (await pool.query(`INSERT INTO conversations (workspace_id, channel_id, external_id, title) VALUES ($1, $2, $3, 'Visitor') RETURNING id`, [ws, ch, `v-${Math.random()}`])).rows[0].id;
  const ids: number[] = [];
  for (const [dir, min, author] of msgs) {
    const at = new Date(Date.parse('2026-10-10T09:00:00Z') + min * 60_000);
    ids.push((await pool.query(`INSERT INTO messages (workspace_id, conversation_id, direction, author_id, body, status, created_at)
      VALUES ($1, $2, $3, $4, 'x', $5, $6) RETURNING id`, [ws, cv, dir, author ?? null, dir === 'in' ? 'received' : 'sent', at])).rows[0].id);
  }
  return ids;
}

describe('team performance report', () => {
  it('per person: deals, win rate, targets, activities, replies and reply time, rating', async () => {
    const { c, me } = await signup();
    const admin = me.user.id;
    const { c: rep, id: repId } = await inviteUser(c, 'Sales rep', 'Rita Rep');
    const ws = (await pool.query(`SELECT workspace_id FROM memberships WHERE user_id = $1`, [admin])).rows[0].workspace_id;

    await closed(c, repId, 'won', '3000');
    await closed(c, repId, 'won', '1000');
    await closed(c, repId, 'lost', '500');
    await closed(c, admin, 'won', '2000');
    await closed(c, admin, 'won', '9999', '2026-11-02'); // outside the period
    expect((await c.put('/targets', { month: '2026-10', targets: [{ userId: repId, amount: '8000' }] })).status).toBe(200);
    for (let i = 0; i < 3; i++) await rep.post('/activities', { kind: 'call', subject: `Call ${i}`, status: 'done', dueAt: '2026-10-12T09:00:00Z' });
    await pool.query(`UPDATE activities SET completed_at = '2026-10-12T10:00:00Z' WHERE assignee_id = $1`, [repId]);

    // Rita: customer waits 30 min, then 60 min (median 45); a broadcast by the admin doesn't count as a reply.
    await chat(ws, [['in', 0], ['out', 30, repId], ['in', 120], ['in', 150], ['out', 180, repId]]);
    const [, bmsg] = await chat(ws, [['in', 0], ['out', 600, admin]]);
    const b = (await pool.query(`INSERT INTO broadcasts (workspace_id, name, channel_kind, subject, body, status) VALUES ($1, 'B', 'email', 's', 'b', 'sent') RETURNING id`, [ws])).rows[0].id;
    await pool.query(`INSERT INTO broadcast_recipients (broadcast_id, message_id, status) VALUES ($1, $2, 'queued')`, [b, bmsg]);
    // An admin reply with nobody waiting (follow-up) counts as a reply but has no waiting time.
    await chat(ws, [['out', 5, admin]]);

    const deal = (await pool.query(`SELECT id FROM deals WHERE owner_id = $1 LIMIT 1`, [repId])).rows[0].id;
    await pool.query(`INSERT INTO feedback_requests (workspace_id, deal_id, email, owner_id, token_hash, rating, responded_at)
      VALUES ($1, $2, 'x@y.test', $3, $4, 4, '2026-10-20T00:00:00Z')`, [ws, deal, repId, `h-${Date.now()}`]);

    const r = await report(c);
    expect(r.status).toBe(200);
    const rows = r.body.rows;
    expect(rows.map((x: any) => x.person)).toEqual(['Rita Rep', me.user.name]); // most won first
    expect(rows[0]).toMatchObject({ userId: repId, dealsWon: 2, wonAmount: '4000.00', winRate: 67, target: '8000.00', targetReached: 50,
      activitiesDone: 3, replies: 2, replyTime: 45, rating: '4.0', ratings: 1 });
    expect(rows[1]).toMatchObject({ userId: admin, dealsWon: 1, wonAmount: '2000.00', winRate: 100, target: null, targetReached: null,
      activitiesDone: 0, replies: 1, replyTime: null, rating: null, ratings: 0 });
    expect(r.body.totals).toEqual({ dealsWon: 3, wonAmount: '6000.00', activitiesDone: 3, replies: 3 });

    // Scope: "only me"; a rep sees only their own row; CSV export follows export rights.
    expect((await report(c, '&scope=me')).body.rows.map((x: any) => x.userId)).toEqual([admin]);
    expect((await report(rep)).body.rows.map((x: any) => x.userId)).toEqual([repId]);
    const csv = await c.download(`/reports/team-performance?from=${FROM}&to=${TO}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.body.toString()).toMatch(/^person,user_id,deals_won,won_amount,win_rate,target,target_reached,activities_done,replies,reply_time,rating,ratings\n"?Rita Rep/);
    expect((await rep.download(`/reports/team-performance?from=${FROM}&to=${TO}&format=csv`)).status).toBe(403);
    // Another workspace sees only its own people.
    const other = await signup();
    expect((await report(other.c)).body.rows.map((x: any) => x.person)).toEqual([other.me.user.name]);
  });
});
