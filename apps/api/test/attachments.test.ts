import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { purge } from '../src/automation/engine.ts';
import { config } from '../src/config.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { cleanFileName } from '../src/routes/attachments.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const pdf = Buffer.from('%PDF-1.4\n% test file\n');

describe('attachments', () => {
  it('uploads, lists, downloads and deletes files on a record, with history', async () => {
    const { c } = await signup();
    const deal = (await c.post('/deals', { title: 'With files' })).body;
    const up = await c.upload(`/attachments?entityType=deal&entityId=${deal.id}&fileName=${encodeURIComponent('Quote v2 (final).pdf')}`, pdf, { 'x-file-type': 'application/pdf' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ fileName: 'Quote v2 (final).pdf', contentType: 'application/pdf', sizeBytes: pdf.length });

    const list = (await c.get(`/attachments?entityType=deal&entityId=${deal.id}`)).body;
    expect(list.data.map((f: any) => f.fileName)).toEqual(['Quote v2 (final).pdf']);
    expect(list.maxBytes).toBe(config.files.maxBytes);

    const dl = await c.download(`/attachments/${up.body.id}`);
    expect(dl.status).toBe(200);
    expect(dl.body.equals(pdf)).toBe(true);
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="Quote v2 (final).pdf"; filename*=UTF-8''Quote%20v2%20(final).pdf`);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');

    const hist = (await c.get(`/history/deal/${deal.id}`)).body.data;
    expect(hist.find((h: any) => h.action === 'file_added').changes.file.name).toBe('Quote v2 (final).pdf');

    expect((await c.del(`/attachments/${up.body.id}`)).status).toBe(204);
    expect((await c.get(`/attachments?entityType=deal&entityId=${deal.id}`)).body.data).toEqual([]);
    expect((await c.download(`/attachments/${up.body.id}`)).status).toBe(404);
    expect((await c.get(`/history/deal/${deal.id}`)).body.data.some((h: any) => h.action === 'file_removed')).toBe(true);
  });

  it('serves only raster images inline; HTML and SVG are always downloads', async () => {
    const { c } = await signup();
    const contact = (await c.post('/contacts', { firstName: 'Pic' })).body;
    const base = `/attachments?entityType=contact&entityId=${contact.id}`;
    const png = (await c.upload(`${base}&fileName=a.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { 'x-file-type': 'image/png' })).body;
    const svg = (await c.upload(`${base}&fileName=x.svg`, Buffer.from('<svg onload="alert(1)"/>'), { 'x-file-type': 'image/svg+xml' })).body;
    const html = (await c.upload(`${base}&fileName=x.html`, Buffer.from('<script>alert(1)</script>'), { 'x-file-type': 'text/html' })).body;
    expect((await c.download(`/attachments/${png.id}?inline=1`)).headers['content-disposition']).toMatch(/^inline;/);
    for (const f of [svg, html]) {
      const r = await c.download(`/attachments/${f.id}?inline=1`);
      expect(r.headers['content-disposition']).toMatch(/^attachment;/);
      expect(r.headers['content-security-policy']).toContain('sandbox');
    }
  });

  it('cleans file names and rejects empty, oversized and unknown-record uploads', async () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\x\\report.pdf')).toBe('report.pdf');
    expect(cleanFileName('a"b<c>.txt')).toBe('a_b_c_.txt');
    expect(cleanFileName('..')).toBe('file');
    const { c } = await signup();
    const d = (await c.post('/deals', { title: 'X' })).body;
    const url = `/attachments?entityType=deal&entityId=${d.id}&fileName=x.bin`;
    expect((await c.upload(url, Buffer.alloc(0))).status).toBe(400);
    expect((await c.upload(url, Buffer.alloc(config.files.maxBytes + 1))).status).toBe(413);
    expect((await c.upload(`/attachments?entityType=deal&entityId=999999&fileName=x.bin`, pdf)).status).toBe(404);
    expect((await c.upload(`/attachments?entityType=product&entityId=1&fileName=x.bin`, pdf)).status).toBe(400);
    // The stored file name on disk never comes from the user.
    const ok = (await c.upload(`/attachments?entityType=deal&entityId=${d.id}&fileName=${encodeURIComponent('../../../evil.sh')}`, pdf)).body;
    const [row] = await q<{ storage_key: string; file_name: string }>(sql`SELECT storage_key, file_name FROM attachments WHERE id = ${ok.id}`);
    expect(row.file_name).toBe('evil.sh');
    expect(row.storage_key).toMatch(/^\d+\/[0-9a-f-]{36}$/);
  });

  it('follows record permissions, pipeline access and workspace isolation', async () => {
    const { c: admin } = await signup();
    const viewer = await inviteUser(admin, 'Viewer');
    const deal = (await admin.post('/deals', { title: 'Shared' })).body;
    const f = (await admin.upload(`/attachments?entityType=deal&entityId=${deal.id}&fileName=a.pdf`, pdf)).body;
    expect((await viewer.c.get(`/attachments?entityType=deal&entityId=${deal.id}`)).status).toBe(200); // may view
    expect((await viewer.c.download(`/attachments/${f.id}`)).status).toBe(200);
    expect((await viewer.c.upload(`/attachments?entityType=deal&entityId=${deal.id}&fileName=b.pdf`, pdf)).status).toBe(403); // may not edit
    expect((await viewer.c.del(`/attachments/${f.id}`)).status).toBe(403);
    // Restricted pipeline: the file disappears for the viewer too.
    const roles = (await admin.get('/roles')).body.data;
    await admin.patch(`/pipelines/${deal.pipelineId}`, { allowedRoleIds: [roles.find((r: any) => r.name === 'Manager').id] });
    expect((await viewer.c.download(`/attachments/${f.id}`)).status).toBe(403);
    const other = await signup('Other');
    expect((await other.c.download(`/attachments/${f.id}`)).status).toBe(404);
    expect((await other.c.del(`/attachments/${f.id}`)).status).toBe(404);
  });

  it('moves files when contacts are merged and removes them when records are purged', async () => {
    const { c } = await signup();
    const a = (await c.post('/contacts', { firstName: 'Keep' })).body;
    const b = (await c.post('/contacts', { firstName: 'Gone' })).body;
    await c.upload(`/attachments?entityType=contact&entityId=${b.id}&fileName=cv.pdf`, pdf);
    await c.post('/merge/contact', { survivorId: a.id, mergedId: b.id });
    expect((await c.get(`/attachments?entityType=contact&entityId=${a.id}`)).body.data.map((f: any) => f.fileName)).toEqual(['cv.pdf']);

    const d = (await c.post('/deals', { title: 'Old' })).body;
    const f = (await c.upload(`/attachments?entityType=deal&entityId=${d.id}&fileName=old.pdf`, pdf)).body;
    const [{ storage_key: key }] = await q<{ storage_key: string }>(sql`SELECT storage_key FROM attachments WHERE id = ${f.id}`);
    const [ws, name] = key.split('/');
    expect(await readdir(join(config.files.dir, ws))).toContain(name);
    await c.del(`/deals/${d.id}`);
    await q(sql`UPDATE deals SET deleted_at = now() - interval '31 days' WHERE id = ${d.id}`);
    await purge();
    expect(await q(sql`SELECT 1 FROM attachments WHERE id = ${f.id}`)).toEqual([]);
    expect(await readdir(join(config.files.dir, ws))).not.toContain(name);
  });
});
