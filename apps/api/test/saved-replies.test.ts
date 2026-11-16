import { afterAll, describe, expect, it } from 'vitest';
import { fillPlaceholders } from '@crm/shared';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('inbox saved replies', () => {
  it('personal and shared replies: who sees and changes what', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep', 'Rita');
    const rep2 = await inviteUser(c, 'Sales rep', 'Sam');
    const viewer = await inviteUser(c, 'Viewer', 'Vic');

    const shared = await c.post('/inbox/saved-replies', { title: 'Opening hours', body: 'Hi {{first_name}}, we are open 9–5.', shared: true });
    expect(shared.status).toBe(201);
    const mine = await rep.c.post('/inbox/saved-replies', { title: 'My sign-off', body: 'Thanks! — {{agent}}' });
    expect(mine.status).toBe(201);
    expect(mine.body.shared).toBe(false);
    expect((await rep.c.post('/inbox/saved-replies', { title: 'x', body: 'y', shared: true })).status).toBe(403); // only admins share
    expect((await viewer.c.post('/inbox/saved-replies', { title: 'x', body: 'y' })).status).toBe(403); // can't reply → can't create
    expect((await rep.c.post('/inbox/saved-replies', { title: '', body: 'y' })).status).toBe(400);

    // Rita sees the shared one and her own; Sam only the shared one; the viewer the shared one (read only).
    const ritaList = (await rep.c.get('/inbox/saved-replies')).body.data;
    expect(ritaList.map((r: any) => [r.title, r.canEdit])).toEqual([['Opening hours', false], ['My sign-off', true]]);
    expect((await rep2.c.get('/inbox/saved-replies')).body.data.map((r: any) => r.title)).toEqual(['Opening hours']);
    expect((await viewer.c.get('/inbox/saved-replies')).body.data.map((r: any) => r.title)).toEqual(['Opening hours']);

    // Changing: owners change their own; nobody else sees personal ones; only admins change shared ones.
    expect((await rep.c.patch(`/inbox/saved-replies/${mine.body.id}`, { body: 'Thanks a lot! — {{agent}}' })).body.body).toBe('Thanks a lot! — {{agent}}');
    expect((await rep2.c.patch(`/inbox/saved-replies/${mine.body.id}`, { body: 'x' })).status).toBe(404);
    expect((await c.del(`/inbox/saved-replies/${mine.body.id}`)).status).toBe(404); // admins don't see personal replies either
    expect((await rep.c.patch(`/inbox/saved-replies/${shared.body.id}`, { body: 'x' })).status).toBe(403);
    expect((await rep.c.patch(`/inbox/saved-replies/${mine.body.id}`, { shared: true })).status).toBe(403);
    const renamed = (await c.patch(`/inbox/saved-replies/${shared.body.id}`, { title: 'Hours' })).body;
    expect([renamed.title, renamed.shared]).toEqual(['Hours', true]); // fields left out stay as they were

    // Another workspace sees none of it.
    const other = await signup();
    expect((await other.c.get('/inbox/saved-replies')).body.data).toEqual([]);
    expect((await other.c.del(`/inbox/saved-replies/${shared.body.id}`)).status).toBe(404);

    expect((await rep.c.del(`/inbox/saved-replies/${mine.body.id}`)).status).toBe(204);
    const after = await rep.c.get('/inbox/saved-replies');
    expect(after.body.data.map((r: any) => r.title), JSON.stringify(after.body)).toEqual(['Hours']);
  });

  it('fills placeholders', () => {
    expect(fillPlaceholders('Hi {{first_name}} ({{ name }}), {{agent}} here. {{unknown}}', { name: 'Grace Hopper', agent: 'Ada' }))
      .toBe('Hi Grace (Grace Hopper), Ada here. {{unknown}}');
    expect(fillPlaceholders('Hi {{first_name}},', { name: '' })).toBe('Hi ,');
  });
});
