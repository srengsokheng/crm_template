import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { processJobs } from '../src/automation/engine.ts';

/** Runs every due job (earlier test files may have left some ahead of ours in the queue). */
const drainJobs = async () => { for (let i = 0; i < 50 && (await processJobs(100)) > 0; i++); };
import { liveTelegramUsers, setTgUserDriver, stopTelegramUsers, syncTelegramUsers } from '../src/inbox/telegramUser.ts';
import { openSecret } from '../src/lib/secrets.ts';
import { fakeTelegramUser, incoming } from './fakes/telegramUser.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

const fake = fakeTelegramUser();
beforeAll(() => setTgUserDriver(fake.driver));
afterEach(async () => { await stopTelegramUsers(); await pool.query(`UPDATE channels SET status = 'disabled' WHERE kind = 'telegram_user'`); });
afterAll(async () => { setTgUserDriver(null); await (await getApp()).close(); await pool.end(); });

const API = { apiId: 123456, apiHash: '0123456789abcdef0123456789abcdef' };
const settle = () => new Promise((r) => setTimeout(r, 150));

/** Connects +85512345678 (no 2FA) all the way. */
async function connectSreng(c: any, extra: Record<string, unknown> = {}) {
  const ch = (await c.post('/channels', { kind: 'telegram_user', phone: '+855 12 345 678', ...API, ...extra })).body;
  const done = await c.post(`/channels/${ch.id}/login`, { code: '12345' });
  expect(done.status).toBe(200);
  return done.body;
}

describe('inbox: Telegram personal account', () => {
  it('signs in with the code (and the 2FA password); explains mistakes; stores nothing it shouldn’t', async () => {
    const { c, me } = await signup();
    // Mistakes are explained.
    expect((await c.post('/channels', { kind: 'telegram_user', phone: '+1 000 000 0000', ...API })).body.error.message).toMatch(/doesn’t know this phone number/);
    expect((await c.post('/channels', { kind: 'telegram_user', phone: '+85512345678', ...API, apiId: 1 })).body.error.message).toMatch(/did not accept the api_id/);
    expect((await c.post('/channels', { kind: 'telegram_user', phone: 'call me', ...API })).status).toBe(400);

    // An account with two-step verification: code, then password.
    const r = await c.post('/channels', { kind: 'telegram_user', phone: '+855 11 111 111', ...API });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'telegram_user', status: 'pending', config: { loginStep: 'code', phone: '+85511111111', includeGroups: false, ownerId: me.user.id } });
    const id = r.body.id;
    expect((await c.post(`/channels/${id}/login`, { password: 'x' })).status).toBe(409); // code first
    const wrong = await c.post(`/channels/${id}/login`, { code: '11111' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.message).toMatch(/That code isn’t right/);
    expect((await c.post(`/channels/${id}/login`, { code: '12345' })).body.config.loginStep).toBe('password');
    expect((await c.post(`/channels/${id}/login`, { password: 'wrong' })).body.error.message).toMatch(/password isn’t right/);
    const ok = await c.post(`/channels/${id}/login`, { password: 'correct horse' });
    expect(ok.body).toMatchObject({ status: 'active', name: 'Bopha', config: { displayName: 'Bopha', loginStep: null } });
    expect((await c.post(`/channels/${id}/login`, { code: '12345' })).status).toBe(409); // already signed in

    // The password and the session never leave the server; the session is encrypted.
    const row = (await pool.query('SELECT secret, config FROM channels WHERE id = $1', [id])).rows[0];
    expect(JSON.stringify(row)).not.toContain('correct horse');
    expect(row.secret).not.toContain('ok:+85511111111');
    expect(JSON.parse(openSecret(row.secret))).toEqual({ ...API, session: 'ok:+85511111111', phone: '+85511111111' });
    const listed = JSON.stringify((await c.get('/channels')).body);
    expect(listed).not.toContain('ok:+855');
    expect(listed).not.toContain(API.apiHash);
    expect(JSON.stringify((await pool.query(`SELECT changes FROM audit_events WHERE entity_type = 'channel' AND entity_id = $1`, [id])).rows)).not.toContain('correct horse');

    // The same account twice: refused at the end of sign-in. Resend gives a new code.
    const again = (await c.post('/channels', { kind: 'telegram_user', phone: '+85511111111', ...API })).body;
    expect((await c.post(`/channels/${again.id}/login`, { resend: true })).body.config.loginStep).toBe('code');
    await c.post(`/channels/${again.id}/login`, { code: '12345' });
    expect((await c.post(`/channels/${again.id}/login`, { password: 'correct horse' })).status).toBe(409);

    // Only admins; never another workspace's channel.
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.post('/channels', { kind: 'telegram_user', phone: '+85512345678', ...API })).status).toBe(403);
    expect((await rep.c.post(`/channels/${again.id}/login`, { code: '12345' })).status).toBe(403);
    const other = await signup();
    expect((await other.c.post(`/channels/${again.id}/login`, { code: '12345' })).status).toBe(404);
  });

  it('takes in private messages (groups only when asked), assigns them to the owner, catches up after a restart', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep', 'Rita');
    const ch = await connectSreng(c, { ownerId: rep.id });
    fake.state.unread.set('+85512345678', [incoming({ messageId: '40', body: 'Sent while the CRM was offline' })]);
    expect(await syncTelegramUsers()).toBe(1); // catch-up
    expect(liveTelegramUsers()).toContain(ch.id);
    expect(await syncTelegramUsers()).toBe(0); // already connected: nothing twice

    fake.deliver('+85512345678', incoming({ messageId: '41', body: 'Do you have the X2 arm?' }));
    fake.deliver('+85512345678', incoming({ messageId: '41', body: 'Do you have the X2 arm?' })); // duplicate
    fake.deliver('+85512345678', incoming({ messageId: '42', body: '[Photo] Like this', file: { fileName: 'photo-42.jpg', contentType: 'image/jpeg', size: null } }));
    fake.state.files.set('42', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    fake.deliver('+85512345678', incoming({ messageId: '43', chatId: '-88', chatKind: 'group', chatTitle: 'Family', peerRef: 'chat:88', body: 'Dinner at 7?' }));
    await settle();
    let convs = (await c.get('/inbox/conversations')).body.data;
    expect(convs.map((x: any) => x.title)).toEqual(['Sok Dara']); // the group is not taken in by default
    const conv = convs[0];
    expect(conv).toMatchObject({ channelKind: 'telegram_user', assigneeId: rep.id });
    const d = (await c.get(`/inbox/conversations/${conv.id}`)).body;
    expect(d.messages.map((m: any) => m.body)).toEqual(['Sent while the CRM was offline', 'Do you have the X2 arm?', '[Photo] Like this']);
    expect(d.profile).toMatchObject({ name: 'Sok Dara', username: 'sokdara', platformId: '7001' });
    expect(JSON.stringify(d)).not.toContain('123456789'); // the access hash stays on the server
    await drainJobs();
    expect((await c.get(`/inbox/conversations/${conv.id}`)).body.messages[2].files[0]).toMatchObject({ status: 'stored', sizeBytes: 7 });

    // Other workspaces never see it.
    const outsider = await signup();
    expect((await outsider.c.get('/inbox/conversations')).body.data).toHaveLength(0);
    expect((await outsider.c.get(`/inbox/conversations/${conv.id}`)).status).toBe(404);

    // Groups when asked: the setting reconnects and takes effect.
    await c.patch(`/channels/${ch.id}`, { includeGroups: true });
    await syncTelegramUsers();
    fake.deliver('+85512345678', incoming({ messageId: '44', chatId: '-88', chatKind: 'group', chatTitle: 'Supplier group', peerRef: 'chat:88', senderName: 'Kim', body: 'Truck arrives Monday' }));
    await settle();
    convs = (await c.get('/inbox/conversations')).body.data;
    expect(convs.find((x: any) => x.title === 'Supplier group')).toMatchObject({ kind: 'group' });

    // Disabling closes the live connection.
    await c.patch(`/channels/${ch.id}`, { status: 'disabled' });
    await syncTelegramUsers();
    expect(liveTelegramUsers()).not.toContain(ch.id);
  });

  it('replies as the account (text, files, typing); explains refusals; a revoked session asks to sign in again', async () => {
    const { c } = await signup();
    const ch = await connectSreng(c);
    await syncTelegramUsers();
    fake.deliver('+85512345678', incoming({ messageId: '51', chatId: '7002', peerRef: 'user:7002:5555', chatTitle: 'Vibol', senderName: 'Vibol' }));
    fake.deliver('+85512345678', incoming({ messageId: '52', chatId: '999', peerRef: 'user:999:1', chatTitle: 'Blocker', senderName: 'Blocker' }));
    await settle();
    const convs = (await c.get('/inbox/conversations')).body.data;
    const vibol = convs.find((x: any) => x.title === 'Vibol').id;
    const blocker = convs.find((x: any) => x.title === 'Blocker').id;

    await c.post(`/inbox/conversations/${vibol}/typing`);
    await c.post(`/inbox/conversations/${vibol}/typing`);
    await settle();
    expect(fake.state.typing.filter((t) => t.peerRef === 'user:7002:5555')).toHaveLength(1);

    await c.post(`/inbox/conversations/${vibol}/messages`, { body: 'Yes — *in stock*.' });
    await c.upload(`/inbox/conversations/${vibol}/files?fileName=quote.pdf&caption=Our%20quote`, Buffer.from('%PDF-1.4 x'), { 'x-file-type': 'application/pdf' });
    await c.post(`/inbox/conversations/${blocker}/messages`, { body: 'Hello?' });
    await drainJobs();
    expect(fake.state.sent.filter((s) => s.peerRef === 'user:7002:5555')).toEqual([
      { phone: '+85512345678', peerRef: 'user:7002:5555', text: 'Yes — *in stock*.' }, // sent as typed
      { phone: '+85512345678', peerRef: 'user:7002:5555', file: { fileName: 'quote.pdf', size: 10 }, caption: 'Our quote' },
    ]);
    const msgs = (await c.get(`/inbox/conversations/${vibol}`)).body.messages;
    expect(msgs.slice(-2).map((m: any) => m.status)).toEqual(['sent', 'sent']);
    expect((await c.get(`/inbox/conversations/${blocker}`)).body.messages.at(-1)).toMatchObject({ status: 'failed', error: 'This person blocked the account.' });

    // The session is ended on the phone: replies fail with an explanation, the channel asks to sign in again.
    fake.state.revoked.add('+85512345678');
    await stopTelegramUsers();
    await c.post(`/inbox/conversations/${vibol}/messages`, { body: 'Still there?' });
    await drainJobs();
    expect((await c.get(`/inbox/conversations/${vibol}`)).body.messages.at(-1).error).toMatch(/Telegram ended this session/);
    expect((await c.get('/channels')).body.data.find((x: any) => x.id === ch.id)).toMatchObject({ status: 'error' });
    // Reconnect = sign in again with a new code.
    fake.state.revoked.delete('+85512345678');
    expect((await c.patch(`/channels/${ch.id}`, { status: 'active' })).body).toMatchObject({ status: 'pending', config: { loginStep: 'code' } });
    expect((await c.post(`/channels/${ch.id}/login`, { code: '12345' })).body.status).toBe('active');

    // Deleting logs the session out on Telegram.
    expect((await c.del(`/channels/${ch.id}`)).status).toBe(204);
    expect(fake.state.loggedOut).toContain('+85512345678');
  });
});
