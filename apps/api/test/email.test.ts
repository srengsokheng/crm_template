import net from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processJobs, processOutbox, sendReminders } from '../src/automation/engine.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { createSmtpTransport, inviteMail, memoryFailures, outbox, setTransport } from '../src/lib/mailer.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
beforeEach(() => { outbox.length = 0; memoryFailures.next = 0; setTransport(null); });

const drain = async (now?: Date) => { for (let n = 0; n < 20; n++) if (!((await processJobs(50, now)) + (await processOutbox()))) return; };

/** Minimal SMTP server: records the conversation and accepts one message. */
function fakeSmtp(): Promise<{ port: number; lines: string[]; data: () => string; close: () => Promise<void> }> {
  const lines: string[] = [];
  let body = '';
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (inData) {
        if (buf.endsWith('\r\n.\r\n')) { body = buf; buf = ''; inData = false; sock.write('250 queued\r\n'); }
        return;
      }
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        lines.push(line);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') sock.write('235 ok\r\n');
        else if (cmd === 'DATA') { sock.write('354 go\r\n'); inData = true; }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as net.AddressInfo).port, lines, data: () => body,
    close: () => new Promise<void>((r) => server.close(() => r())),
  })));
}

describe('email delivery', () => {
  it('emails an invitation with the same link the admin sees, escaping user text', async () => {
    const { c } = await signup('Mailer');
    const inv = await c.post('/users/invite', { email: 'newbie@example.com', name: 'Nia <b>Bold</b>', roleId: (await c.get('/roles')).body.data.find((r: any) => r.name === 'Sales rep').id });
    expect(inv.status).toBe(201);
    expect(inv.body.emailed).toBe(false); // memory/console transports don't reach a mailbox
    expect(outbox).toHaveLength(0); // queued, not sent inline
    await drain();
    const mail = outbox.find((m) => m.to === 'newbie@example.com')!;
    expect(mail.subject).toBe('Mailer invited you to Mailer Inc on Acme CRM');
    expect(mail.text).toContain(`Accept invitation: ${inv.body.inviteUrl}`);
    expect(mail.html).toContain(`href="${inv.body.inviteUrl}"`);
    expect(mail.html).toContain('Hi Nia &lt;b&gt;Bold&lt;/b&gt;,');
    expect(mail.html).not.toContain('<b>Bold</b>');
    expect(mail.from).toBe('Acme CRM <no-reply@localhost>');
    // The link in the email really works.
    const token = inv.body.inviteUrl.split('/invite/')[1];
    expect((await c.get(`/auth/invite/${token}`)).body.email).toBe('newbie@example.com');
    // Inviting again (resend) issues a new link and a new email; the old link stops working.
    const again = await c.post('/users/invite', { email: 'newbie@example.com', name: 'Nia', roleId: (await c.get('/roles')).body.data[2].id });
    await drain();
    expect(outbox.filter((m) => m.to === 'newbie@example.com')).toHaveLength(2);
    expect(again.body.inviteUrl).not.toBe(inv.body.inviteUrl);
    expect((await c.get(`/auth/invite/${token}`)).status).toBe(404);
  });

  it('does not send the invitation email when the invite is rejected', async () => {
    const { c, email } = await signup();
    const roleId = (await c.get('/roles')).body.data[1].id;
    expect((await c.post('/users/invite', { email, name: 'Me again', roleId })).status).toBe(400); // already a member
    await drain();
    expect(outbox.filter((m) => m.to === email)).toHaveLength(0); // other files may leave mail in the queue
  });

  it('emails activity reminders once to the assignee, respecting the opt-out and disabled members', async () => {
    const { c: admin } = await signup('Remind');
    const rep = await inviteUser(admin, 'Sales rep', 'Rita Rep');
    const off = await inviteUser(admin, 'Sales rep', 'Olaf Off');
    const gone = await inviteUser(admin, 'Sales rep', 'Dee Disabled');
    await drain();
    outbox.length = 0;
    expect((await off.c.patch('/auth/preferences', { emailReminders: false })).status).toBe(200);
    expect((await off.c.get('/auth/me')).body.preferences).toEqual({ emailReminders: false, emailDigest: true });
    expect((await rep.c.get('/auth/me')).body.preferences).toEqual({ emailReminders: true, emailDigest: true });
    const deal = (await admin.post('/deals', { title: 'Robot order' })).body;
    const dueAt = new Date(Date.now() + 3600_000).toISOString();
    for (const u of [rep, off, gone]) {
      const a = await admin.post('/activities', { kind: 'call', subject: `Call for ${u.email}`, dueAt, reminderMinutesBefore: 30, assigneeId: u.id, links: [{ entityType: 'deal', entityId: deal.id }] });
      expect(a.status).toBe(201);
    }
    await admin.patch(`/users/${gone.id}`, { status: 'disabled' });
    // Reminders run for every workspace, and other test files leave meetings with reminders (e.g. bookings):
    // only mail to this test's people counts.
    const ours = () => outbox.filter((m) => [rep.email, off.email, gone.email].includes(m.to));

    await sendReminders(new Date(Date.now() + 1800_000 - 60_000)); // one minute too early
    await drain();
    expect(ours()).toHaveLength(0);
    await sendReminders(new Date(Date.now() + 1800_000 + 60_000));
    await drain();
    expect(ours().map((m) => m.to)).toEqual([rep.email]);
    const mail = ours()[0];
    expect(mail.subject).toBe(`Reminder: Call for ${rep.email}`);
    expect(mail.text).toContain('Hi Rita Rep,');
    expect(mail.text).toContain('Related to: Robot order');
    expect(mail.text).toMatch(/is due .+\(UTC\)/);
    expect(mail.text).toContain('/activities');
    // In-app notifications still go to everyone assigned, opt-out or not.
    expect((await off.c.get('/notifications')).body.data.map((n: any) => n.title)).toContain(`Reminder: Call for ${off.email}`);
    // Not sent twice.
    await sendReminders(new Date(Date.now() + 7200_000));
    await drain();
    expect(ours()).toHaveLength(1);
  });

  it('retries a failed delivery and then gives up without losing other jobs', async () => {
    const { c } = await signup();
    await drain(); // other files' mail first, so the simulated failure hits ours
    memoryFailures.next = 1;
    await c.post('/users/invite', { email: 'retry@example.com', name: 'Retry', roleId: (await c.get('/roles')).body.data[1].id });
    await processJobs(50);
    expect(outbox.filter((m) => m.to === 'retry@example.com')).toHaveLength(0);
    const job = await q<{ status: string; attempts: number; last_error: string }>(sql`SELECT status, attempts, last_error FROM jobs WHERE type = 'email.send' AND payload->>'to' = 'retry@example.com'`);
    expect(job[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Simulated delivery failure' });
    await drain(new Date(Date.now() + 120_000)); // past the retry delay
    expect(outbox.filter((m) => m.to === 'retry@example.com')).toHaveLength(1);
  });

  it('lets only admins see the delivery status and send a test email', async () => {
    const { c: admin, email } = await signup();
    const rep = await inviteUser(admin, 'Sales rep');
    expect((await rep.c.get('/settings/email')).status).toBe(403);
    expect((await rep.c.post('/settings/email/test')).status).toBe(403);
    const status = (await admin.get('/settings/email')).body;
    expect(status).toEqual({ transport: 'memory', delivers: false, from: 'Acme CRM <no-reply@localhost>', host: null,
      senderName: null, fromHeader: 'Acme CRM <no-reply@localhost>', failedCount: 0 });
    outbox.length = 0;
    const sent = await admin.post('/settings/email/test');
    expect(sent.status).toBe(200);
    expect(sent.body.to).toBe(email);
    expect(outbox.map((m) => [m.to, m.subject])).toEqual([[email, 'Acme CRM test email']]);
    // A mail server that refuses → a clear error, not a crash.
    setTransport({ name: 'smtp', send: async () => { throw new Error('535 Authentication failed'); } });
    const failed = await admin.post('/settings/email/test');
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({ code: 'EMAIL_FAILED', message: 'The mail server did not accept the message: 535 Authentication failed' });
  });

  it('speaks SMTP with authentication to a real socket', async () => {
    const smtp = await fakeSmtp();
    try {
      const t = createSmtpTransport({ host: '127.0.0.1', port: smtp.port, secure: false, user: 'mailer', pass: 's3cret' });
      await t.send(inviteMail({ to: 'someone@example.com', name: 'Some One', workspace: 'Acme', inviter: 'Ada', url: 'http://localhost/invite/abc' }), 'CRM <crm@example.com>');
      expect(smtp.lines.some((l) => /^AUTH PLAIN /.test(l))).toBe(true);
      const auth = smtp.lines.find((l) => l.startsWith('AUTH PLAIN '))!.split(' ')[2];
      expect(Buffer.from(auth, 'base64').toString()).toBe('\u0000mailer\u0000s3cret');
      expect(smtp.lines).toContain('MAIL FROM:<crm@example.com>');
      expect(smtp.lines).toContain('RCPT TO:<someone@example.com>');
      const data = smtp.data();
      expect(data).toContain('Subject: Ada invited you to Acme on Acme CRM');
      expect(data).toContain('http://localhost/invite/abc');
      expect(data).toMatch(/Content-Type: multipart\/alternative/);
    } finally { await smtp.close(); }
  });

  it('cancels a pending invitation: the link dies and the person leaves the member list', async () => {
    const { c: admin } = await signup();
    const other = await signup('Other');
    const rep = await inviteUser(admin, 'Sales rep');
    const roleId = (await admin.get('/roles')).body.data[1].id;
    const inv = (await admin.post('/users/invite', { email: 'oops@example.com', name: 'Wrong Person', roleId })).body;
    const token = inv.inviteUrl.split('/invite/')[1];
    const invited = (await admin.get('/meta')).body.users.find((u: any) => u.email === 'oops@example.com');
    expect(invited.status).toBe('invited');
    expect((await rep.c.del(`/users/${invited.id}/invite`)).status).toBe(403);
    expect((await other.c.del(`/users/${invited.id}/invite`)).status).toBe(404); // another workspace
    expect((await admin.del(`/users/${rep.id}/invite`)).status).toBe(400); // already joined
    expect((await admin.del(`/users/${invited.id}/invite`)).status).toBe(204);
    expect((await admin.get('/meta')).body.users.some((u: any) => u.email === 'oops@example.com')).toBe(false);
    expect((await admin.get(`/auth/invite/${token}`)).status).toBe(404);
    expect((await admin.post('/auth/accept-invite', { token, name: 'Wrong Person', password: 'password123' })).status).not.toBe(200);
    // They can be invited again later.
    expect((await admin.post('/users/invite', { email: 'oops@example.com', name: 'Right Person', roleId })).status).toBe(201);
  });

  it('keeps subjects on one line', () => {
    const m = inviteMail({ to: 'a@example.com', name: 'A', workspace: 'W\r\nBcc: evil@example.com', inviter: 'I', url: 'http://x' });
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});
