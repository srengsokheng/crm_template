import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processJobs } from '../src/automation/engine.ts';
import { outbox } from '../src/lib/mailer.ts';
import { pool } from '../src/db/pool.ts';
import { client, getApp, signup, uniq } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
beforeEach(() => { outbox.length = 0; });

const drain = async () => { while (await processJobs(50)) { /* send queued mail */ } };
const mailTo = (to: string) => outbox.filter((m) => m.to === to);
const linkIn = (text: string, path: string) => new RegExp(`${path}/([A-Za-z0-9_-]+)`).exec(text)?.[1];

describe('account security emails', () => {
  it('changing your password emails you a notice', async () => {
    const { c, email } = await signup();
    expect((await c.post('/auth/password', { currentPassword: 'password123', newPassword: 'another-pass-1' })).status).toBe(200);
    await drain();
    const mails = mailTo(email);
    expect(mails.map((m) => m.subject)).toEqual(['Your Acme CRM password was changed']);
    expect(mails[0].text).toContain('/forgot-password');
  });
});

describe('changing your sign-in email', () => {
  it('needs your password, confirms via the new address, notifies the old one, and switches sign-in', async () => {
    const { c, email } = await signup();
    const next = `${uniq('new')}@example.com`;
    expect((await c.post('/auth/email', { newEmail: next, currentPassword: 'wrong' })).body.error.fields).toEqual({ currentPassword: 'Not correct' });
    expect((await c.post('/auth/email', { newEmail: email.toUpperCase(), currentPassword: 'password123' })).body.error.fields).toEqual({ newEmail: 'Already your email' });
    expect((await c.post('/auth/email', { newEmail: 'not-an-email', currentPassword: 'password123' })).status).toBe(400);

    const r = await c.post('/auth/email', { newEmail: next, currentPassword: 'password123' });
    expect(r.body).toEqual({ ok: true, sentTo: next });
    await drain();
    expect(mailTo(email).map((m) => m.subject)).toEqual(['Your Acme CRM email is being changed']);
    const confirmMail = mailTo(next)[0];
    expect(confirmMail.subject).toBe('Confirm your new Acme CRM email');
    const token = linkIn(confirmMail.text, '/confirm-email')!;
    expect(token).toBeTruthy();
    expect((await c.get('/auth/me')).body.user.email).toBe(email); // nothing changes until confirmed

    // A reset link sent to the old address before the switch must stop working afterwards.
    const anon = client(await getApp());
    await anon.post('/auth/forgot-password', { email });
    await drain();
    const resetToken = linkIn(mailTo(email).find((m) => /Reset/.test(m.subject))!.text, '/reset-password')!;

    // Confirm without being signed in (the link may open on another device).
    const conf = await anon.post('/auth/confirm-email', { token });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body).toEqual({ email: next });
    expect((await anon.post('/auth/confirm-email', { token })).status).toBe(400); // works once
    expect((await c.get('/auth/me')).body.user.email).toBe(next); // this session keeps working
    await drain();
    expect(mailTo(email).map((m) => m.subject)).toContain('Your Acme CRM sign-in email was changed');
    const fresh = client(await getApp());
    expect((await fresh.post('/auth/login', { email, password: 'password123' })).status).toBe(401);
    expect((await fresh.post('/auth/login', { email: next, password: 'password123' })).status).toBe(200);
    expect((await anon.post('/auth/reset-password', { token: resetToken, password: 'takeover-123' })).status).toBe(404); // the old address's reset link is dead
  });

  it("doesn't reveal whether an email has an account; its owner gets a note instead", async () => {
    const a = await signup('Ada');
    const b = await signup('Bob');
    const r = await b.c.post('/auth/email', { newEmail: a.email, currentPassword: 'password123' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, sentTo: a.email }); // same answer as for a free address
    await drain();
    expect(mailTo(a.email).map((m) => m.subject)).toEqual(['Someone tried to use this email on Acme CRM']);
    expect(mailTo(a.email)[0].text).not.toMatch(/confirm-email/);
    expect(mailTo(b.email)).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM email_changes ec JOIN users u ON u.id = ec.user_id WHERE u.email = $1', [b.email])).rows[0].n).toBe(0);
  });

  it('a newer request replaces the older link; expired links and addresses taken meanwhile are refused', async () => {
    const { c } = await signup();
    const first = `${uniq('one')}@example.com`;
    const second = `${uniq('two')}@example.com`;
    await c.post('/auth/email', { newEmail: first, currentPassword: 'password123' });
    await c.post('/auth/email', { newEmail: second, currentPassword: 'password123' });
    await drain();
    const t1 = linkIn(mailTo(first)[0].text, '/confirm-email')!;
    const t2 = linkIn(mailTo(second)[0].text, '/confirm-email')!;
    const anon = client(await getApp());
    expect((await anon.post('/auth/confirm-email', { token: t1 })).status).toBe(400);
    // Someone else takes the address before it's confirmed.
    await signup('Other').then(async (o) => { await pool.query('UPDATE users SET email = $1 WHERE email = $2', [second, o.email]); });
    expect((await anon.post('/auth/confirm-email', { token: t2 })).status).toBe(409);
    // Expired.
    const third = `${uniq('three')}@example.com`;
    await c.post('/auth/email', { newEmail: third, currentPassword: 'password123' });
    await drain();
    const t3 = linkIn(mailTo(third)[0].text, '/confirm-email')!;
    await pool.query(`UPDATE email_changes SET expires_at = now() - interval '1 minute' WHERE new_email = $1`, [third]);
    expect((await anon.post('/auth/confirm-email', { token: t3 })).status).toBe(400);
    // Signed out: no request.
    expect((await anon.post('/auth/email', { newEmail: third, currentPassword: 'password123' })).status).toBe(401);
  });
});
