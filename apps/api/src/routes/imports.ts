import type { FastifyInstance } from 'fastify';
import {
  CsvError, IMPORT_ENTITIES, IMPORT_LIMITS, importConfigSchema, importUploadSchema, mappingErrors, MATCH_KEYS_BY_ENTITY,
  parseCsv, suggestMapping, toCsv, type ImportConfig, type ImportEntity, type ImportOptions,
} from '@crm/shared';
import { pool, q, q1, raw, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { loadDefs } from '../lib/customFields.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { canOnRecord, requireAny } from '../lib/permissions.ts';
import { assertMembers } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { preview, TABLE, type ImportRow, type RowResult } from '../imports/engine.ts';

type IdParams = { Params: { id: string } };
const ISSUE_LIMIT = 500;

/** Admins see every import in the workspace; everyone else sees their own. */
async function loadImport(ctx: Ctx, id: number, db: Db = pool, lock = false): Promise<ImportRow> {
  if (!Number.isInteger(id)) throw notFound('Import');
  const row = await q1<ImportRow>(sql`SELECT * FROM imports WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}
    ${ctx.isAdmin ? sql`` : sql`AND created_by = ${ctx.userId}`} ${lock ? sql`FOR UPDATE` : sql``}`, db);
  if (!row) throw notFound('Import');
  return row;
}

function view(imp: ImportRow, createdByName?: string | null, withIssues = false) {
  const out: Record<string, unknown> = {
    id: imp.id, entityType: imp.entity_type, fileName: imp.file_name, status: imp.status, headers: imp.headers,
    rowCount: imp.row_count, sample: (imp.rows ?? []).slice(0, 5), mapping: imp.mapping, options: imp.options,
    processed: imp.processed, created: imp.created_count, updated: imp.updated_count, skipped: imp.skipped_count,
    failed: imp.failed_count, error: imp.error, undoneAt: imp.undone_at, createdAt: imp.created_at, startedAt: imp.started_at,
    finishedAt: imp.finished_at, createdBy: { id: imp.created_by, name: createdByName ?? null },
  };
  if (withIssues) {
    const issues = (imp.results ?? []).filter((r) => r.action === 'failed' || r.action === 'skipped');
    out.issuesTotal = issues.length;
    out.issues = issues.slice(0, ISSUE_LIMIT).map((r) => ({
      row: imp.row_numbers[r.i] ?? r.i + 2, action: r.action, message: r.message ?? null, recordId: r.id ?? null,
      values: imp.rows?.[r.i] ?? null,
    }));
  }
  return out;
}

async function userName(id: number) {
  return (await q1<{ name: string }>(sql`SELECT name FROM users WHERE id = ${id}`))?.name ?? null;
}

/** Check mapping + options against the workspace; returns normalised options. */
async function validateConfig(ctx: Ctx, imp: ImportRow, cfg: ImportConfig): Promise<ImportOptions> {
  const entity = imp.entity_type;
  if (cfg.mapping.length !== imp.headers.length) throw badRequest('The mapping must have one entry per column', { mapping: 'Wrong length' });
  const defs = await loadDefs(ctx.workspaceId, entity);
  const errs = mappingErrors(entity, cfg.mapping, defs.map((d) => d.key));
  if (errs.length) throw new AppError(400, 'VALIDATION_FAILED', errs[0], { mapping: errs.join(' · ') }, errs);
  const options = { ...cfg.options };
  const allowed = MATCH_KEYS_BY_ENTITY[entity];
  options.matchBy = options.matchBy.filter((k) => allowed.includes(k));
  if (options.duplicateMode !== 'create' && !options.matchBy.length) {
    throw badRequest('Choose how to recognise existing records', { 'options.matchBy': 'Pick at least one' });
  }
  if (options.ownerId) await assertMembers(ctx, [options.ownerId]);
  if (options.duplicateMode === 'update') requireAny(ctx, entity, 'edit');
  return options;
}

export async function importRoutes(app: FastifyInstance) {
  app.get('/imports', async (req) => {
    const ctx = ctxOf(req);
    const entity = (req.query as { entityType?: string }).entityType;
    const e = IMPORT_ENTITIES.includes(entity as ImportEntity) ? entity : null;
    const rows = await q<ImportRow & { created_by_name: string }>(sql`SELECT i.id, i.workspace_id, i.entity_type, i.file_name, i.status, i.headers,
        NULL::jsonb AS rows, i.row_numbers, i.row_count, i.mapping, i.options, i.processed, i.created_count, i.updated_count, i.skipped_count,
        i.failed_count, '[]'::jsonb AS results, i.error, i.undone_at, i.created_by, i.created_at, i.started_at, i.finished_at, u.name AS created_by_name
      FROM imports i JOIN users u ON u.id = i.created_by
      WHERE i.workspace_id = ${ctx.workspaceId} ${ctx.isAdmin ? sql`` : sql`AND i.created_by = ${ctx.userId}`}
        ${e ? sql`AND i.entity_type = ${e}` : sql``}
      ORDER BY i.created_at DESC, i.id DESC LIMIT 20`);
    return { data: rows.map((r) => { const v = view(r, r.created_by_name); delete v.headers; delete v.sample; delete v.mapping; return v; }) };
  });

  // Upload: parse the file, keep the cells, suggest a mapping.
  app.post('/imports', { bodyLimit: IMPORT_LIMITS.maxBytes * 2 }, async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(importUploadSchema, req.body);
    requireAny(ctx, body.entityType, 'import');
    requireAny(ctx, body.entityType, 'create');
    if (body.entityType === 'lead' && !ctx.useLeads) throw badRequest('Leads are turned off in this workspace');
    let parsed: ReturnType<typeof parseCsv>;
    try { parsed = parseCsv(body.content); } catch (e) {
      if (e instanceof CsvError) throw badRequest(`This file can't be read as CSV: ${e.message}`, { content: e.message });
      throw e;
    }
    if (!parsed.headers.length) throw badRequest('The file is empty', { content: 'Empty file' });
    if (!parsed.rows.length) throw badRequest('The file has a header row but no data rows', { content: 'No data rows' });
    if (parsed.rows.length > IMPORT_LIMITS.maxRows) {
      throw badRequest(`The file has ${parsed.rows.length.toLocaleString('en')} rows; the limit is ${IMPORT_LIMITS.maxRows.toLocaleString('en')}. Split it into smaller files.`, { content: 'Too many rows' });
    }
    if (parsed.headers.length > IMPORT_LIMITS.maxColumns) throw badRequest(`The file has more than ${IMPORT_LIMITS.maxColumns} columns`, { content: 'Too many columns' });
    const defs = await loadDefs(ctx.workspaceId, body.entityType);
    const mapping = suggestMapping(body.entityType, parsed.headers, defs.map((d) => ({ key: d.key, label: d.label })));
    const options = importConfigSchema.shape.options.parse({ matchBy: [MATCH_KEYS_BY_ENTITY[body.entityType][0]] });
    const imp = await q1<ImportRow>(sql`INSERT INTO imports (workspace_id, entity_type, file_name, headers, rows, row_numbers, row_count, mapping, options, created_by)
      VALUES (${ctx.workspaceId}, ${body.entityType}, ${body.fileName}, ${JSON.stringify(parsed.headers)}::jsonb, ${JSON.stringify(parsed.rows)}::jsonb,
        ${JSON.stringify(parsed.rowNumbers)}::jsonb, ${parsed.rows.length}, ${JSON.stringify(mapping)}::jsonb, ${JSON.stringify(options)}::jsonb, ${ctx.userId})
      RETURNING *`);
    return reply.code(201).send(view(imp!, ctx.userName));
  });

  app.get<IdParams>('/imports/:id', async (req) => {
    const ctx = ctxOf(req);
    const imp = await loadImport(ctx, Number(req.params.id));
    return view(imp, await userName(imp.created_by), true);
  });

  // Save mapping/options and dry-run every row.
  app.post<IdParams>('/imports/:id/preview', async (req) => {
    const ctx = ctxOf(req);
    const cfg = parse(importConfigSchema, req.body);
    const imp = await loadImport(ctx, Number(req.params.id));
    if (imp.status !== 'draft') throw badRequest('This import has already been started');
    const options = await validateConfig(ctx, imp, cfg);
    await q(sql`UPDATE imports SET mapping = ${JSON.stringify(cfg.mapping)}::jsonb, options = ${JSON.stringify(options)}::jsonb WHERE id = ${imp.id}`);
    const p = await preview(ctx, imp, cfg.mapping, options);
    // The full plan is used for the counts; the list sent back is capped so a 10k-row file stays light.
    return { summary: p.summary, rows: p.rows.slice(0, 100), problems: p.rows.filter((r) => r.action === 'error').slice(0, 200) };
  });

  app.post<IdParams>('/imports/:id/run', async (req) => {
    const ctx = ctxOf(req);
    const cfg = parse(importConfigSchema, req.body);
    const imp = await tx(async (db) => {
      const cur = await loadImport(ctx, Number(req.params.id), db, true);
      if (cur.status !== 'draft') throw badRequest('This import has already been started');
      requireAny(ctx, cur.entity_type, 'import');
      const options = await validateConfig(ctx, cur, cfg);
      const row = await q1<ImportRow>(sql`UPDATE imports SET mapping = ${JSON.stringify(cfg.mapping)}::jsonb, options = ${JSON.stringify(options)}::jsonb,
        status = 'queued' WHERE id = ${cur.id} RETURNING *`, db);
      await q(sql`INSERT INTO jobs (type, payload) VALUES ('import.run', ${JSON.stringify({ importId: cur.id })})`, db);
      return row!;
    });
    return view(imp, ctx.userName);
  });

  app.post<IdParams>('/imports/:id/cancel', async (req) => {
    const ctx = ctxOf(req);
    const imp = await tx(async (db) => {
      const cur = await loadImport(ctx, Number(req.params.id), db, true);
      if (!['queued', 'running'].includes(cur.status)) throw badRequest('Only an import that is still running can be stopped');
      return (await q1<ImportRow>(sql`UPDATE imports SET status = 'canceled', finished_at = now() WHERE id = ${cur.id} RETURNING *`, db))!;
    });
    return view(imp, await userName(imp.created_by), true);
  });

  // Undo: move the records this import created to the recycle bin (updates are not reverted).
  app.post<IdParams>('/imports/:id/undo', async (req) => {
    const ctx = ctxOf(req);
    return tx(async (db) => {
      const imp = await loadImport(ctx, Number(req.params.id), db, true);
      if (!['done', 'canceled', 'failed'].includes(imp.status)) throw badRequest('Wait for the import to finish first');
      if (imp.undone_at) throw badRequest('This import was already undone');
      const ids = (imp.results as RowResult[]).filter((r) => r.action === 'created' && r.id).map((r) => r.id!);
      const table = raw(TABLE[imp.entity_type]);
      const rows = ids.length
        ? await q<{ id: number; owner_id: number; visibility: string }>(sql`SELECT id, owner_id, visibility FROM ${table}
            WHERE id = ANY(${ids}) AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db)
        : [];
      const allowed = rows.filter((r) => canOnRecord(ctx, imp.entity_type, 'delete', r)).map((r) => Number(r.id));
      if (allowed.length) {
        await q(sql`UPDATE ${table} SET deleted_at = now(), deleted_by = ${ctx.userId} WHERE id = ANY(${allowed})`, db);
        for (const id of allowed) await audit(db, ctx, imp.entity_type, id, 'deleted', { _import: { id: imp.id, file: imp.file_name, undo: true } });
      }
      await q(sql`UPDATE imports SET undone_at = now() WHERE id = ${imp.id}`, db);
      await audit(db, ctx, 'import', imp.id, 'undone', { deleted: allowed.length, notAllowed: rows.length - allowed.length });
      return { deleted: allowed.length, notAllowed: rows.length - allowed.length, alreadyGone: ids.length - rows.length };
    });
  });

  // Failed rows as CSV (original columns + the reason), ready to fix and import again.
  app.get<IdParams>('/imports/:id/errors.csv', async (req, reply) => {
    const ctx = ctxOf(req);
    const imp = await loadImport(ctx, Number(req.params.id));
    if (!imp.rows) throw badRequest('The original rows of this import are no longer kept (older than 30 days)');
    const failed = (imp.results as RowResult[]).filter((r) => r.action === 'failed');
    const csv = toCsv([[...imp.headers, 'Import error'], ...failed.map((r) => [...(imp.rows![r.i] ?? []), r.message ?? ''])]);
    const base = imp.file_name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'import';
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${base}-errors.csv"`);
    return reply.send('﻿' + csv); // BOM so Excel reads UTF-8
  });
}
