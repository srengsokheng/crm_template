import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { pool } from '../src/db/pool.ts';
import { processJobs } from '../src/automation/engine.ts';
import { files } from '../src/lib/files.ts';
import { pollTelegram } from '../src/inbox/telegram.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

/** Fake Telegram: files by file_id; "big" ids are refused by getFile like Telegram does above 20 MB. */
const stored = new Map<string, Buffer>([
  ['photo-small', Buffer.from('small')], ['photo-large', Buffer.from('\xff\xd8\xff large jpeg bytes', 'latin1')],
  ['doc-1', Buffer.from('%PDF-1.4 quote')], ['voice-big', Buffer.alloc(1)],
]);
const fake = { updates: new Map<string, any[]>(), uploads: [] as { method: string; body: string }[], texts: [] as any[], next: 900 };
let server: Server;
const T = '7100001:AAFilesFakeTokenForInboxTests_000';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const file = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(req.url ?? '');
      if (file) { const b = stored.get(file[1]); if (!b) return reply(404, {}); res.writeHead(200); return res.end(b); }
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      if (!m) return reply(404, { ok: false });
      const [, token, method] = m;
      const p = (req.headers['content-type'] ?? '').startsWith('application/json') && raw.length ? JSON.parse(raw.toString()) : {};
      if (method === 'getMe') return reply(200, { ok: true, result: { id: 7100001, is_bot: true, first_name: 'Files Bot', username: 'files_bot' } });
      if (method === 'deleteWebhook') return reply(200, { ok: true, result: true });
      if (method === 'getUpdates') return reply(200, { ok: true, result: (fake.updates.get(token) ?? []).filter((u) => u.update_id >= (p.offset ?? 0)) });
      if (method === 'getFile') {
        if (p.file_id === 'voice-big') return reply(400, { ok: false, description: 'Bad Request: file is too big' });
        return stored.has(p.file_id) ? reply(200, { ok: true, result: { file_id: p.file_id, file_path: `files/${p.file_id}`, file_size: stored.get(p.file_id)!.length } }) : reply(400, { ok: false, description: 'Bad Request: invalid file_id' });
      }
      if (method === 'sendPhoto' || method === 'sendDocument') { fake.uploads.push({ method, body: raw.toString('latin1') }); return reply(200, { ok: true, result: { message_id: fake.next++ } }); }
      if (method === 'sendMessage') { fake.texts.push(p); return reply(200, { ok: true, result: { message_id: fake.next++ } }); }
      reply(404, { ok: false, description: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.telegram.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await (await getApp()).close(); await pool.end(); });

let uid = 1;
const push = (extra: Record<string, unknown>) => {
  const u = { update_id: uid++, message: { message_id: 100 + uid, date: 1, chat: { id: 55, type: 'private', first_name: 'Ada' }, from: { id: 55, first_name: 'Ada' }, ...extra } };
  fake.updates.set(T, [...(fake.updates.get(T) ?? []), u]);
};
async function upload(c: any, convId: number, data: Buffer, fileName: string, type: string, caption = '') {
  return c.upload(`/inbox/conversations/${convId}/files?fileName=${encodeURIComponent(fileName)}&caption=${encodeURIComponent(caption)}`, data, { 'x-file-type': type });
}

describe('inbox files', () => {
  it('downloads incoming Telegram photos/documents, refuses too-large ones, and serves them to people who may see the chat', async () => {
    const { c } = await signup();
    await pool.query(`UPDATE channels SET status = 'disabled' WHERE kind = 'telegram_bot'`);
    fake.updates.set(T, []); // a new bot starts reading at offset 0: forget earlier tests' updates
    await c.post('/channels', { kind: 'telegram_bot', token: T });
    push({ photo: [{ file_id: 'photo-small', file_size: 5 }, { file_id: 'photo-large', file_size: 20 }], caption: 'Like this' });
    push({ document: { file_id: 'doc-1', file_name: 'quote.pdf', mime_type: 'application/pdf', file_size: 14 } });
    push({ video: { file_id: 'video-huge', file_size: 30 * 1024 * 1024 } });
    push({ voice: { file_id: 'voice-big', mime_type: 'audio/ogg' } });
    expect(await pollTelegram()).toBe(4);
    const conv = (await c.get('/inbox/conversations')).body.data[0];
    let msgs = (await c.get(`/inbox/conversations/${conv.id}`)).body.messages;
    expect(msgs.map((m: any) => m.files.length)).toEqual([1, 1, 1, 1]);
    const names = msgs.map((m: any) => m.files[0].fileName);
    expect(names[0]).toMatch(/^photo-\d+\.jpg$/);
    expect(names[1]).toBe('quote.pdf');
    expect(names[2]).toMatch(/^video-\d+\.mp4$/);
    expect(names[3]).toMatch(/^voice-\d+\.ogg$/);
    expect(msgs.map((m: any) => m.files[0].status)).toEqual(['pending', 'pending', 'too_large', 'pending']); // 30 MB: over the bot limit, not fetched
    expect(msgs[0].body).toBe('[Photo] Like this');
    await processJobs();
    msgs = (await c.get(`/inbox/conversations/${conv.id}`)).body.messages;
    const [photo, doc, , voice] = msgs.map((m: any) => m.files[0]);
    expect([photo.status, doc.status, voice.status]).toEqual(['stored', 'stored', 'too_large']);
    expect(photo).toMatchObject({ contentType: 'image/jpeg', sizeBytes: stored.get('photo-large')!.length }); // the largest size was fetched

    const img = await c.download(`/inbox/files/${photo.id}?inline=1`);
    expect(img.status).toBe(200);
    expect(img.body.equals(stored.get('photo-large')!)).toBe(true);
    expect(img.headers['content-disposition']).toMatch(/^inline;/);
    const pdf = await c.download(`/inbox/files/${doc.id}?inline=1`);
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="quote.pdf"; filename*=UTF-8''quote.pdf`); // never inline
    expect(pdf.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect((await c.download(`/inbox/files/${voice.id}`)).status).toBe(404); // not stored

    // Who may download: not another workspace, not a rep when the chat is assigned to someone outside their team.
    const other = await signup();
    expect((await other.c.download(`/inbox/files/${photo.id}`)).status).toBe(404);
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.download(`/inbox/files/${photo.id}`)).status).toBe(200); // unassigned: everyone's
    const me = (await c.get('/auth/me')).body;
    await c.patch(`/inbox/conversations/${conv.id}`, { assigneeId: me.user.id });
    expect((await rep.c.download(`/inbox/files/${photo.id}`)).status).toBe(404);

    // Deleting the channel removes the stored files too.
    const key = (await pool.query('SELECT storage_key FROM message_files WHERE id = $1', [photo.id])).rows[0].storage_key;
    expect(await files().get(key)).not.toBeNull();
    const ch = (await c.get('/channels')).body.data[0];
    expect((await c.del(`/channels/${ch.id}`)).status).toBe(204);
    expect(await files().get(key)).toBeNull();
  });

  it('sends files through the bot: images as photos, others as documents, long text after the file', async () => {
    const { c } = await signup();
    await pool.query(`UPDATE channels SET status = 'disabled' WHERE kind = 'telegram_bot'`);
    fake.updates.set(T, []); // a new bot starts reading at offset 0: forget earlier tests' updates
    await c.post('/channels', { kind: 'telegram_bot', token: T });
    push({ text: 'Send me the brochure' });
    await pollTelegram();
    const conv = (await c.get('/inbox/conversations')).body.data[0];

    const r = await upload(c, conv.id, Buffer.from('%PDF-1.4 brochure'), 'Brochure 2026.pdf', 'application/pdf', 'Here it is');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await upload(c, conv.id, Buffer.from('\x89PNG fake', 'latin1'), 'map.png', 'image/png');
    await upload(c, conv.id, Buffer.from('a,b'), 'prices.csv', 'text/csv', 'x'.repeat(1500));
    let msgs = (await c.get(`/inbox/conversations/${conv.id}`)).body.messages;
    expect(msgs.slice(1).map((m: any) => [m.status, m.body.slice(0, 10), m.files[0].fileName])).toEqual([
      ['pending', 'Here it is', 'Brochure 2026.pdf'], ['pending', '', 'map.png'], ['pending', 'xxxxxxxxxx', 'prices.csv'],
    ]);
    const prev = (await c.get('/inbox/conversations')).body.data[0].lastMessagePreview;
    expect(prev.startsWith('📎 prices.csv xxx')).toBe(true);
    expect([...prev]).toHaveLength(140); // 140 characters, the emoji counted once
    await processJobs();
    msgs = (await c.get(`/inbox/conversations/${conv.id}`)).body.messages;
    expect(msgs.slice(1).map((m: any) => m.status)).toEqual(['sent', 'sent', 'sent']);
    expect(fake.uploads.map((u) => u.method)).toEqual(['sendDocument', 'sendPhoto', 'sendDocument']);
    expect(fake.uploads[0].body).toContain('filename="Brochure 2026.pdf"');
    expect(fake.uploads[0].body).toContain('Here it is');
    expect(fake.uploads[0].body).toContain('%PDF-1.4 brochure');
    expect(fake.uploads[2].body).not.toContain('xxxxxxxxxx'); // caption too long for Telegram…
    expect(fake.texts.at(-1)).toEqual({ chat_id: '55', text: 'x'.repeat(1500) }); // …so it follows as a message

    // Rules: viewers can't send files; empty / wrong content type; disabled channel.
    const viewer = await inviteUser(c, 'Viewer');
    expect((await upload(viewer.c, conv.id, Buffer.from('x'), 'a.txt', 'text/plain')).status).toBe(403);
    expect((await upload(c, conv.id, Buffer.alloc(0), 'a.txt', 'text/plain')).status).toBe(400);
    expect((await c.post(`/inbox/conversations/${conv.id}/files?fileName=a.txt`, { x: 1 })).status).toBe(415);
    const ch = (await c.get('/channels')).body.data[0];
    await c.patch(`/channels/${ch.id}`, { status: 'disabled' });
    expect((await upload(c, conv.id, Buffer.from('x'), 'a.txt', 'text/plain')).status).toBe(409);
  });

  it('website chat: the visitor sees and downloads files the team sends, only with their own token', async () => {
    const { c } = await signup();
    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const app = await getApp();
    const pub = (method: 'GET' | 'POST', path: string, body?: unknown) => app.inject({ method, url: `/api/v1/public/webchat/${ch.publicKey}${path}`,
      headers: body ? { 'content-type': 'application/json' } : {}, payload: body ? JSON.stringify(body) : undefined });
    const a = JSON.parse((await pub('POST', '/messages', { body: 'Menu?' })).body);
    const b = JSON.parse((await pub('POST', '/messages', { body: 'Other visitor' })).body);
    const convs = (await c.get('/inbox/conversations')).body.data;
    const convA = convs.find((x: any) => x.lastMessagePreview === 'Menu?');
    const r = await upload(c, convA.id, Buffer.from('\xff\xd8\xff menu', 'latin1'), 'menu.jpg', 'image/jpeg', 'Our menu');
    expect(r.status).toBe(201);
    const seen = JSON.parse((await pub('GET', `/messages?token=${a.token}`)).body).messages;
    expect(seen.at(-1)).toMatchObject({ direction: 'out', body: 'Our menu', files: [{ fileName: 'menu.jpg', contentType: 'image/jpeg' }] });
    const fileId = seen.at(-1).files[0].id;
    const dl = await pub('GET', `/files/${fileId}?token=${a.token}&inline=1`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(Buffer.from('\xff\xd8\xff menu', 'latin1'))).toBe(true);
    expect(dl.headers['content-disposition']).toMatch(/^inline;/);
    expect(dl.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect((await pub('GET', `/files/${fileId}?token=${b.token}`)).statusCode).toBe(404); // another visitor
    expect((await pub('GET', `/files/${fileId}`)).statusCode).toBe(404);
    expect(JSON.parse((await pub('GET', `/messages?token=${b.token}`)).body).messages.every((m: any) => m.files.length === 0)).toBe(true);
  });
});
