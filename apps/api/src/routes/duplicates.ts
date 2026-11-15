/**
 * Find duplicates across a whole list: pairs of contacts or companies that share an email, phone or website, or have
 * exactly the same name. Only records the caller may view are considered. Pairs marked "Not a duplicate" are hidden.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, q1, raw, sql, tx, type Fragment } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { badRequest } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { assertOnRecord, requireAny, scopeWhere } from '../lib/permissions.ts';
import { camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

const LIMIT = 200;
const entitySchema = z.enum(['contact', 'company']);
const dismissSchema = z.object({ entityType: entitySchema, ids: z.tuple([z.number().int().positive(), z.number().int().positive()]) });
type Entity = z.infer<typeof entitySchema>;

const tableOf = (e: Entity) => raw(e === 'contact' ? 'contacts' : 'companies');
/** Display title of a record row aliased `a`. */
const titleOf = (e: Entity, a: string): Fragment => (e === 'contact'
  ? sql`trim(coalesce(${raw(`${a}.first_name`)},'') || ' ' || coalesce(${raw(`${a}.last_name`)},''))`
  : sql`${raw(`${a}.name`)}`);
/** Name normalised for comparison (case and repeated spaces ignored). */
const nameKey = (e: Entity, a: string): Fragment => sql`lower(regexp_replace(${titleOf(e, a)}, '\\s+', ' ', 'g'))`;

export async function duplicateRoutes(app: FastifyInstance) {
  app.get('/duplicates/pairs', async (req) => {
    const ctx = ctxOf(req);
    const entity = parse(entitySchema, (req.query as { entityType?: string }).entityType);
    requireAny(ctx, entity, 'view');
    const table = tableOf(entity);
    const rows = await q(sql`
      WITH visible AS (
        SELECT t.id FROM ${table} t WHERE t.workspace_id = ${ctx.workspaceId} AND t.deleted_at IS NULL AND ${scopeWhere(ctx, entity, 'view', 't')}
      ),
      hits AS (
        SELECT m1.party_id AS a, m2.party_id AS b, m1.kind AS reason, min(m1.value) AS value
        FROM contact_methods m1
        JOIN contact_methods m2 ON m2.workspace_id = m1.workspace_id AND m2.party_type = m1.party_type AND m2.kind = m1.kind
          AND m2.normalized = m1.normalized AND m2.party_id > m1.party_id
        WHERE m1.workspace_id = ${ctx.workspaceId} AND m1.party_type = ${entity} AND m1.kind IN ('email','phone','website')
          AND length(m1.normalized) >= 5
          AND m1.party_id IN (SELECT id FROM visible) AND m2.party_id IN (SELECT id FROM visible)
        GROUP BY 1, 2, 3
        UNION ALL
        SELECT x.id, y.id, 'name', min(${titleOf(entity, 'x')})
        FROM ${table} x JOIN ${table} y ON y.workspace_id = x.workspace_id AND y.id > x.id AND ${nameKey(entity, 'y')} = ${nameKey(entity, 'x')}
        WHERE x.workspace_id = ${ctx.workspaceId} AND ${nameKey(entity, 'x')} <> ''
          AND x.id IN (SELECT id FROM visible) AND y.id IN (SELECT id FROM visible)
        GROUP BY 1, 2
      ),
      pairs AS (
        SELECT a, b, json_agg(json_build_object('kind', reason, 'value', value) ORDER BY reason) AS reasons, count(*) AS strength
        FROM hits GROUP BY a, b
      )
      SELECT p.a, p.b, p.reasons,
        json_build_object('id', ra.id, 'title', ${titleOf(entity, 'ra')}, 'createdAt', ra.created_at, 'ownerName', ua.name) AS left,
        json_build_object('id', rb.id, 'title', ${titleOf(entity, 'rb')}, 'createdAt', rb.created_at, 'ownerName', ub.name) AS right
      FROM pairs p
      JOIN ${table} ra ON ra.id = p.a LEFT JOIN users ua ON ua.id = ra.owner_id
      JOIN ${table} rb ON rb.id = p.b LEFT JOIN users ub ON ub.id = rb.owner_id
      WHERE NOT EXISTS (SELECT 1 FROM duplicate_dismissals d WHERE d.workspace_id = ${ctx.workspaceId} AND d.entity_type = ${entity}
        AND d.a_id = p.a AND d.b_id = p.b)
      ORDER BY p.strength DESC, p.b DESC
      LIMIT ${LIMIT + 1}`);
    return { data: camelAll(rows.slice(0, LIMIT)), more: rows.length > LIMIT };
  });

  // "Not a duplicate": hide the pair for everyone. Needs edit rights on both records.
  app.post('/duplicates/dismiss', async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(dismissSchema, req.body);
    const [a, b] = [...body.ids].sort((x, y) => x - y);
    if (a === b) throw badRequest('Choose two different records');
    const table = tableOf(body.entityType);
    await tx(async (db) => {
      for (const id of [a, b]) {
        const r = await q1<{ owner_id: number; visibility: string }>(sql`SELECT owner_id, visibility FROM ${table}
          WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
        if (!r) throw badRequest('Record not found');
        assertOnRecord(ctx, body.entityType, 'edit', r);
      }
      await q(sql`INSERT INTO duplicate_dismissals (workspace_id, entity_type, a_id, b_id, dismissed_by)
        VALUES (${ctx.workspaceId}, ${body.entityType}, ${a}, ${b}, ${ctx.userId}) ON CONFLICT DO NOTHING`, db);
      await audit(db, ctx, body.entityType, a, 'not_duplicate', { other: { id: b } });
    });
    return reply.code(204).send();
  });
}
