import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { sendReminders } from '../src/automation/engine.ts';
import { client, getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('profile: time zone and sessions', () => {
  it('a personal time zone for emails; cleared back to the workspace’s; validated', async () => {
    const { c, me } = await signup();
    expect((await c.get('/auth/me')).body.user.timezone).toBeNull();
    expect((await c.patch('/auth/profile', { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await c.patch('/auth/profile', { timezone: 'Asia/Phnom_Penh' })).body).toMatchObject({ timezone: 'Asia/Phnom_Penh', name: me.user.name });
    expect((await c.get('/auth/me')).body.user.timezone).toBe('Asia/Phnom_Penh');

    // A reminder email shows the due time in that zone (03:00 UTC = 10:00 in Phnom Penh).
    const a = (await c.post('/activities', { kind: 'call', subject: 'Call Sokha', dueAt: '2027-01-05T03:00:00Z', reminderMinutesBefore: 15 })).body;
    await sendReminders(new Date('2027-01-05T02:50:00Z'));
    const mail = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 AND payload->>'subject' = 'Reminder: Call Sokha'`, [me.user.email])).rows[0]?.payload;
    expect(mail?.text).toContain('10:00 AM (Asia/Phnom_Penh)');
    expect(a.id).toBeTruthy();

    expect((await c.patch('/auth/profile', { timezone: null })).body.timezone).toBeNull();
    expect((await c.patch('/auth/profile', { name: 'Renamed' })).body).toMatchObject({ name: 'Renamed', timezone: null });
  });

  it('see other sessions and sign them out; this one stays', async () => {
    const { c, email } = await signup();
    const other = client(await getApp());
    expect((await other.post('/auth/login', { email, password: 'password123' })).status).toBe(200);
    const list = (await c.get('/auth/sessions')).body;
    expect(list.others).toBe(1);
    expect(list.data[0]).toMatchObject({ current: true });
    expect(JSON.stringify(list)).not.toMatch(/id_?hash|token/i);
    expect((await c.post('/auth/sessions/sign-out-others')).body).toEqual({ signedOut: 1 });
    expect((await other.get('/auth/me')).status).toBe(401);
    expect((await c.get('/auth/me')).status).toBe(200);
    expect((await c.get('/auth/sessions')).body.others).toBe(0);
  });
});
