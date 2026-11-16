import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processJobs, processOutbox, sendDigests, sendReminders } from '../src/automation/engine.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { cleanSenderName, fromHeader, memoryFailures, outbox, senderAddress, setTransport } from '../src/lib/mailer.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
beforeEach(() => { outbox.length = 0; memoryFailures.next = 0; setTransport(null); });

const drain = async () => { for (let n = 0; n < 20; n++) if (!((await processJobs(50)) + (await processOutbox()))) return; };
/** Let failed jobs run again now (skip the back-off) until they are retried out. */
const exhaust = async () => {
  for (let n = 0; n < 5; n++) { await q(sql`UPDATE jobs SET run_at = now() WHERE status = 'pending'`); await processJobs(50); }
};

describe('sender name', () => {
  it('admins set a display name; invites and reminders use it with the configured address; header-safe', async () => {
    const { c } = await signup();
    expect(cleanSenderName('Acme "Sales"\r\nBcc: x@evil.test <a>')).toBe('Acme Sales Bcc: x@evil.test a');
    expect(fromHeader(null)).toContain(senderAddress());

    const before = (await c.get('/settings/email')).body;
    expect(before).toMatchObject({ senderName: null, failedCount: 0 });
    const saved = (await c.put('/settings/email', { senderName: 'Acme Robotics Sales' })).body;
    expect(saved.senderName).toBe('Acme Robotics Sales');
    expect(saved.fromHeader).toBe(`"Acme Robotics Sales" <${senderAddress()}>`);

    await c.post('/users/invite', { email: 'new.person@example.com', name: 'New Person', roleId: (await c.get('/roles')).body.data.find((r: any) => r.name === 'Viewer').id });
    await drain();
    const invite = outbox.find((m) => m.to === 'new.person@example.com')!;
    expect(invite.from).toBe(`"Acme Robotics Sales" <${senderAddress()}>`);

    // Reminder from the same workspace.
    const me = (await c.get('/auth/me')).body.user;
    const act = (await c.post('/activities', { kind: 'call', subject: 'Call Ada', assigneeId: me.id, dueAt: new Date(Date.now() + 10 * 60_000).toISOString(), reminderMinutesBefore: 30 })).body;
    expect(act.id).toBeTruthy();
    await sendReminders();
    await drain();
    expect(outbox.find((m) => m.subject === 'Reminder: Call Ada')!.from).toBe(`"Acme Robotics Sales" <${senderAddress()}>`);

    // Clearing it goes back to the default; only admins may change it.
    expect((await c.put('/settings/email', { senderName: '' })).body.senderName).toBeNull();
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.put('/settings/email', { senderName: 'Hacker' })).status).toBe(403);
    expect((await rep.c.get('/settings/email')).status).toBe(403);
  });
});

describe('daily digest', () => {
  it('sends one digest per local day after 8:00 to members with overdue activities, respecting the opt-out', async () => {
    const { c } = await signup();
    await c.patch('/workspace', { timezone: 'Asia/Phnom_Penh' }); // UTC+7
    const me = (await c.get('/auth/me')).body.user;
    const rep = await inviteUser(c, 'Sales rep', 'Rita');
    const off = await inviteUser(c, 'Sales rep', 'Otto');
    const deal = (await c.post('/deals', { title: 'Robots for Acme', ownerId: me.id })).body;
    const past = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    await c.post('/activities', { kind: 'call', subject: 'Call back Acme', assigneeId: me.id, dueAt: past(48), links: [{ entityType: 'deal', entityId: deal.id }] });
    await c.post('/activities', { kind: 'task', subject: 'Send proposal', assigneeId: me.id, dueAt: past(2) });
    await c.post('/activities', { kind: 'task', subject: 'Not yet due', assigneeId: me.id, dueAt: new Date(Date.now() + 86400_000).toISOString() });
    await c.post('/activities', { kind: 'task', subject: 'Otto overdue', assigneeId: off.id, dueAt: past(5) });
    expect((await off.c.patch('/auth/preferences', { emailDigest: false })).status).toBe(200);
    expect((await off.c.get('/auth/me')).body.preferences).toEqual({ emailReminders: true, emailDigest: false });

    // 06:00 local (23:00 UTC the day before): too early.
    const early = new Date('2026-11-16T23:00:00Z');
    await sendDigests(early);
    // 09:00 local on 2026-11-17 (02:00 UTC): sent.
    const nine = new Date('2026-11-17T02:00:00Z');
    await sendDigests(nine);
    await drain();
    // (Other tests' workspaces live in the same database, so look only at this workspace's members.)
    const digests = (to: string) => outbox.filter((m) => m.to === to && /overdue/.test(m.subject));
    expect(digests(me.email).map((m) => m.subject)).toEqual(['2 overdue activities in Admin Inc']);
    const digest = digests(me.email)[0];
    expect(digests(rep.email)).toEqual([]); // nothing overdue
    expect(digests(off.email)).toEqual([]); // opted out
    expect(digest.text).toContain('Call back Acme');
    expect(digest.text).toContain('Robots for Acme');
    expect(digest.text).toContain('Send proposal');
    expect(digest.text).not.toContain('Not yet due');
    expect(digest.text).toContain('/activities?bucket=overdue');

    // Same local day again: nothing new. Next day: again.
    outbox.length = 0;
    await sendDigests(new Date('2026-11-17T10:00:00Z'));
    await drain();
    expect(digests(me.email)).toHaveLength(0);
    await sendDigests(new Date('2026-11-18T02:00:00Z'));
    await drain();
    expect(digests(me.email)).toHaveLength(1);
  });

  it('doesn’t reveal deal titles from pipelines the member may not use', async () => {
    const { c } = await signup();
    const roles = (await c.get('/roles')).body.data;
    const rep = await inviteUser(c, 'Sales rep', 'Rita');
    const vip = (await c.post('/pipelines', { entityType: 'deal', name: 'VIP' })).body;
    const secret = (await c.post('/deals', { title: 'Secret merger', pipelineId: vip.id })).body;
    await c.patch(`/pipelines/${vip.id}`, { allowedRoleIds: [roles.find((r: any) => r.name === 'Manager').id] });
    await c.post('/activities', { kind: 'call', subject: 'Prep call', assigneeId: rep.id, dueAt: new Date(Date.now() - 3600_000).toISOString(), links: [{ entityType: 'deal', entityId: secret.id }] });
    await q(sql`UPDATE memberships SET digest_sent_on = NULL`);
    await sendDigests(new Date(Date.now() + 86400_000 * 2));
    await drain();
    const d = outbox.find((m) => m.to === rep.email && /overdue/.test(m.subject))!;
    expect(d.text).toContain('Prep call');
    expect(d.text).toContain('Restricted deal');
    expect(d.text).not.toContain('Secret merger');
  });
});

describe('failed deliveries', () => {
  it('admins see failed emails of their workspace and can retry them', async () => {
    const { c } = await signup();
    const viewer = (await c.get('/roles')).body.data.find((r: any) => r.name === 'Viewer').id;
    memoryFailures.next = 100;
    await c.post('/users/invite', { email: 'bounce@example.com', name: 'Bounce', roleId: viewer });
    await drain();
    await exhaust();
    const fails = (await c.get('/settings/email/failures')).body.data;
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({ to: 'bounce@example.com', error: 'Simulated delivery failure', attempts: 3 });
    expect(fails[0].subject).toContain('invited you');
    expect((await c.get('/settings/email')).body.failedCount).toBe(1);

    // Another workspace sees nothing; non-admins can't look.
    const other = await signup('Other');
    expect((await other.c.get('/settings/email/failures')).body.data).toEqual([]);
    expect((await other.c.post(`/settings/email/failures/${fails[0].id}/retry`, {})).status).toBe(404);
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.get('/settings/email/failures')).status).toBe(403);

    // Retry after the mail server is back.
    memoryFailures.next = 0;
    outbox.length = 0;
    expect((await c.post(`/settings/email/failures/${fails[0].id}/retry`, {})).status).toBe(200);
    await drain();
    expect(outbox.map((m) => m.to)).toContain('bounce@example.com');
    expect((await c.get('/settings/email/failures')).body.data).toEqual([]);
  });
});
