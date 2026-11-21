import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processJobs } from '../src/automation/engine.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { outbox } from '../src/lib/mailer.ts';
import { client, getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
beforeEach(() => { outbox.length = 0; });

const drain = async () => { while (await processJobs(50)); };
const tokenFrom = (to: string) => {
  const m = outbox.filter((x) => x.to === to).at(-1);
  return m ? /\/reset-password\/([\w-]+)/.exec(m.text)![1] : null;
};

describe('password reset', () => {
  it('emails a one-time link, changes the password and signs out other sessions', async () => {
    const { c, email } = await signup();
    const app = await getApp();
    const anon = client(app);
    expect((await anon.post('/auth/forgot-password', { email: email.toUpperCase() })).body).toEqual({ ok: true });
    await drain();
    const token = tokenFrom(email);
    expect(token).toBeTruthy();
    const mail = outbox.find((m) => m.to === email)!;
    expect(mail.subject).toBe('Reset your Acme CRM password');
    expect(mail.html).toContain(`/reset-password/${token}`);

    expect((await anon.get(`/auth/reset/${token}`)).body).toEqual({ email });
    expect((await anon.post('/auth/reset-password', { token, password: 'short' })).status).toBe(400);
    expect((await anon.post('/auth/reset-password', { token, password: 'new-password-1' })).body).toEqual({ ok: true });

    // The old session is gone, the old password fails, the new one works, the link is spent.
    expect((await c.get('/auth/me')).status).toBe(401);
    expect((await anon.post('/auth/login', { email, password: 'password123' })).status).toBe(401);
    expect((await anon.post('/auth/login', { email, password: 'new-password-1' })).status).toBe(200);
    expect((await anon.get(`/auth/reset/${token}`)).status).toBe(404);
    expect((await client(app).post('/auth/reset-password', { token, password: 'another-pass' })).status).toBe(404);
    // Only a hash of the token is stored.
    const stored = await q<{ token_hash: string }>(sql`SELECT token_hash FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE u.email = ${email}`);
    expect(stored.every((r) => r.token_hash !== token && r.token_hash.length === 64)).toBe(true);
  });

  it('answers the same for unknown, pending-invite and disabled accounts, and sends nothing', async () => {
    const { c: admin } = await signup();
    const rep = await inviteUser(admin, 'Sales rep');
    await admin.patch(`/users/${rep.id}`, { status: 'disabled' });
    const roleId = (await admin.get('/roles')).body.data[1].id;
    await admin.post('/users/invite', { email: 'pending@example.com', name: 'Pending', roleId });
    await drain();
    outbox.length = 0;
    const anon = client(await getApp());
    for (const email of ['nobody@example.com', 'pending@example.com', rep.email]) {
      const r = await anon.post('/auth/forgot-password', { email });
      expect([r.status, r.body]).toEqual([200, { ok: true }]);
    }
    await drain();
    expect(outbox).toHaveLength(0);
    expect((await anon.post('/auth/forgot-password', { email: 'not-an-email' })).status).toBe(400);
  });

  it('expires links after an hour, keeps only the newest link, and caps requests', async () => {
    const { email } = await signup();
    const anon = client(await getApp());
    await anon.post('/auth/forgot-password', { email });
    await drain();
    const first = tokenFrom(email)!;
    await anon.post('/auth/forgot-password', { email });
    await drain();
    const second = tokenFrom(email)!;
    expect(second).not.toBe(first);
    expect((await anon.get(`/auth/reset/${first}`)).status).toBe(404); // replaced
    expect((await anon.get(`/auth/reset/${second}`)).status).toBe(200);
    await anon.post('/auth/forgot-password', { email });
    await anon.post('/auth/forgot-password', { email }); // 4th within the hour → silently ignored
    await drain();
    expect(outbox.filter((m) => m.to === email)).toHaveLength(3);
    const third = tokenFrom(email)!;
    await q(sql`UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    expect((await anon.get(`/auth/reset/${third}`)).status).toBe(404);
    expect((await anon.post('/auth/reset-password', { token: third, password: 'new-password-1' })).status).toBe(404);
  });
});
