import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { client, getApp, inviteUser, signup, uniq } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('auth', () => {
  it('signs up, reads /me, logs out and back in', async () => {
    const { c, email, me } = await signup('Ada');
    expect(me.user.email).toBe(email);
    expect(me.role.isAdmin).toBe(true);
    expect(me.permissions.deal.view).toBe('all');
    expect((await c.post('/auth/logout')).status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(401);
    expect((await c.post('/auth/login', { email, password: 'wrong-password' })).status).toBe(401);
    expect((await c.post('/auth/login', { email, password: 'password123' })).status).toBe(200);
    expect((await c.get('/auth/me')).body.user.email).toBe(email);
  });

  it('rejects duplicate signups and weak input', async () => {
    const { email } = await signup();
    const app = await getApp();
    const c = client(app);
    const dup = await c.post('/auth/signup', { workspaceName: 'X', name: 'X', email, password: 'password123' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.fields.email).toBeTruthy();
    const weak = await c.post('/auth/signup', { workspaceName: 'X', name: 'X', email: `${uniq()}@example.com`, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.fields.password).toMatch(/8/);
  });

  it('requires a session and the CSRF header', async () => {
    const app = await getApp();
    const anon = client(app);
    expect((await anon.get('/contacts')).status).toBe(401);
    const { c } = await signup();
    const noHeader = await c.raw('POST', '/contacts', { headers: {}, body: { firstName: 'A' } });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF');
  });

  it('invites a user who accepts and gets the chosen role; invite links are single-use', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep', 'Rita');
    const me = (await rep.c.get('/auth/me')).body;
    expect(me.role.name).toBe('Sales rep');
    expect(me.permissions.deal.delete).toBe('own');
    const again = await client(await getApp()).post('/auth/accept-invite', { token: rep.token, name: 'X', password: 'password123' });
    expect(again.status).toBe(404);
  });

  it('disabled users lose access immediately', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.get('/contacts')).status).toBe(200);
    expect((await c.patch(`/users/${rep.id}`, { status: 'disabled' })).status).toBe(200);
    expect((await rep.c.get('/contacts')).status).toBe(401);
    expect((await rep.c.post('/auth/login', { email: rep.email, password: 'password123' })).status).toBe(403);
  });
});
