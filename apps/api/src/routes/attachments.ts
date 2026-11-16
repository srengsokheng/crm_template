/**
 * Attachments on leads, deals, contacts and companies.
 *   GET    /attachments?entityType=&entityId=   list (needs view on the record)
 *   POST   /attachments?entityType=&entityId=&fileName=   raw bytes, Content-Type: application/octet-stream,
 *          X-File-Type: the file's real type (needs edit on the record)
 *   GET    /attachments/:id[?inline=1]           download (always "attachment", except raster images with inline=1)
 *   DELETE /attachments/:id                      (needs edit on the record)
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { RECORD_TYPES, type RecordType } from '@crm/shared';
import { config } from '../config.ts';
import { pool, q, q1, raw, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { files, INLINE_TYPES, newStorageKey } from '../lib/files.ts';
import { ctxOf } from '../lib/http.ts';
import { assertOnRecord } from '../lib/permissions.ts';
import { camel, camelAll } from '../lib/records.ts';

const TABLE: Record<RecordType, string> = { lead: 'leads', deal: 'deals', contact: 'contacts', company: 'companies' };
type Att = { id: number; workspace_id: number; entity_type: RecordType; entity_id: number; file_name: string; content_type: string; size_bytes: number; storage_key: string };

function recordRef(query: Record<string, unknown>): { type: RecordType; id: number } {
  const type = String(query.entityType ?? '') as RecordType;
  const id = Number(query.entityId);
  if (!RECORD_TYPES.includes(type) || !Number.isInteger(id) || id <= 0) throw badRequest('Choose a record');
  return { type, id };
}

/** Loads the record with the columns permission checks need (incl. pipeline) and checks the action. */
async function checkRecord(db: Db, ctx: Ctx, type: RecordType, id: number, action: 'view' | 'edit') {
  const row = await q1<{ owner_id: number; visibility: string; pipeline_id?: number }>(sql`SELECT owner_id, visibility
    ${type === 'deal' || type === 'lead' ? sql`, pipeline_id` : sql``} FROM ${raw(TABLE[type])}
    WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
  if (!row) throw notFound('Record');
  assertOnRecord(ctx, type, action, row);
}

/** Keep the name readable but harmless: no path parts or control characters, limited length. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim().slice(0, 180);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}
const cleanType = (t: unknown) => (typeof t === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(t) && t.length <= 100 ? t.toLowerCase() : 'application/octet-stream');

async function loadAttachment(ctx: Ctx, id: number): Promise<Att> {
  if (!Number.isInteger(id)) throw notFound('File');
  const a = await q1<Att>(sql`SELECT * FROM attachments WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`);
  if (!a) throw notFound('File');
  return a;
}

export async function attachmentRoutes(app: FastifyInstance) {
  // Raw upload bodies are only accepted by this plugin's routes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: config.files.maxBytes }, (_req, body, done) => done(null, body));

  app.get('/attachments', async (req) => {
    const ctx = ctxOf(req);
    const r = recordRef(req.query as Record<string, unknown>);
    await checkRecord(pool, ctx, r.type, r.id, 'view');
    const rows = await q(sql`SELECT a.id, a.file_name, a.content_type, a.size_bytes, a.created_at, u.name AS uploaded_by_name
      FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.workspace_id = ${ctx.workspaceId} AND a.entity_type = ${r.type} AND a.entity_id = ${r.id} ORDER BY a.created_at DESC, a.id DESC`);
    return { data: camelAll(rows), maxBytes: config.files.maxBytes };
  });

  app.post('/attachments', { bodyLimit: config.files.maxBytes, config: { rateLimit: { max: config.isTest ? 1000 : 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ctx = ctxOf(req);
    const query = req.query as Record<string, unknown>;
    const r = recordRef(query);
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED', 'Upload the file as application/octet-stream');
    const data = req.body as Buffer;
    if (data.length === 0) throw badRequest('The file is empty');
    const fileName = cleanFileName(String(query.fileName ?? ''));
    const contentType = cleanType(req.headers['x-file-type']);
    const key = newStorageKey(ctx.workspaceId);
    const row = await tx(async (db) => {
      await checkRecord(db, ctx, r.type, r.id, 'edit');
      const count = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM attachments WHERE workspace_id = ${ctx.workspaceId}
        AND entity_type = ${r.type} AND entity_id = ${r.id}`, db);
      if ((count?.n ?? 0) >= config.files.maxPerRecord) throw badRequest(`A record can have up to ${config.files.maxPerRecord} files`);
      const ins = await q1<Att>(sql`INSERT INTO attachments (workspace_id, entity_type, entity_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by)
        VALUES (${ctx.workspaceId}, ${r.type}, ${r.id}, ${fileName}, ${contentType}, ${data.length}, ${createHash('sha256').update(data).digest('hex')}, ${key}, ${ctx.userId})
        RETURNING id, file_name, content_type, size_bytes, created_at`, db);
      await audit(db, ctx, r.type, r.id, 'file_added', { file: { id: ins!.id, name: fileName, size: data.length } });
      // Written inside the transaction: if storage fails, the row is rolled back too.
      await files().put(key, data);
      return ins!;
    });
    return reply.code(201).send(camel(row));
  });

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/attachments/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    const a = await loadAttachment(ctx, Number(req.params.id));
    await checkRecord(pool, ctx, a.entity_type, a.entity_id, 'view');
    const data = await files().get(a.storage_key);
    if (!data) throw notFound('File content');
    const inline = req.query.inline === '1' && INLINE_TYPES.has(a.content_type);
    const encoded = encodeURIComponent(a.file_name);
    const ascii = a.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    reply.header('content-type', a.content_type)
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=0, no-store');
    return reply.send(data);
  });

  app.delete<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    const a = await loadAttachment(ctx, Number(req.params.id));
    await tx(async (db) => {
      await checkRecord(db, ctx, a.entity_type, a.entity_id, 'edit');
      await q(sql`DELETE FROM attachments WHERE id = ${a.id}`, db);
      await audit(db, ctx, a.entity_type, a.entity_id, 'file_removed', { file: { id: a.id, name: a.file_name } });
    });
    await files().remove(a.storage_key); // after commit; a leftover file is harmless, a missing one is not
    return reply.code(204).send();
  });
}
