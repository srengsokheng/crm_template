import type { FastifyInstance } from 'fastify';
import { q, raw, sql } from '../db/index.ts';
import { ctxOf } from '../lib/http.ts';
import { likeTerm } from '../lib/list.ts';
import { scopeOf, scopeWhere } from '../lib/permissions.ts';
import { camelAll } from '../lib/records.ts';

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search', async (req) => {
    const ctx = ctxOf(req);
    const term = String((req.query as { q?: string }).q ?? '').trim().slice(0, 100);
    if (term.length < 2) return { data: [] };
    const t = likeTerm(term);
    const tl = likeTerm(term.toLowerCase());
    const method = (party: string, alias: string) => sql`EXISTS (SELECT 1 FROM contact_methods cm WHERE cm.party_type = ${party}
      AND cm.party_id = ${raw(`${alias}.id`)} AND (cm.normalized ILIKE ${tl} OR cm.value ILIKE ${t}))`;
    const tasks: Promise<Record<string, unknown>[]>[] = [];
    if (scopeOf(ctx, 'deal', 'view') !== 'none') tasks.push(q(sql`SELECT 'deal' AS type, d.id, d.title, s.name AS subtitle FROM deals d JOIN stages s ON s.id = d.stage_id
      WHERE d.workspace_id = ${ctx.workspaceId} AND d.deleted_at IS NULL AND ${scopeWhere(ctx, 'deal', 'view', 'd')} AND d.title ILIKE ${t}
      ORDER BY d.updated_at DESC LIMIT 6`));
    if (scopeOf(ctx, 'lead', 'view') !== 'none' && ctx.useLeads) tasks.push(q(sql`SELECT 'lead' AS type, l.id, l.title, l.company_name AS subtitle FROM leads l
      WHERE l.workspace_id = ${ctx.workspaceId} AND l.deleted_at IS NULL AND ${scopeWhere(ctx, 'lead', 'view', 'l')}
        AND ((l.title || ' ' || coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'') || ' ' || coalesce(l.company_name,'')) ILIKE ${t} OR ${method('lead', 'l')})
      ORDER BY l.updated_at DESC LIMIT 6`));
    if (scopeOf(ctx, 'contact', 'view') !== 'none') tasks.push(q(sql`SELECT 'contact' AS type, c.id, trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS title,
        coalesce(c.job_title, '') AS subtitle FROM contacts c
      WHERE c.workspace_id = ${ctx.workspaceId} AND c.deleted_at IS NULL AND ${scopeWhere(ctx, 'contact', 'view', 'c')}
        AND ((coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) ILIKE ${t} OR ${method('contact', 'c')})
      ORDER BY c.updated_at DESC LIMIT 6`));
    if (scopeOf(ctx, 'company', 'view') !== 'none') tasks.push(q(sql`SELECT 'company' AS type, co.id, co.name AS title, '' AS subtitle FROM companies co
      WHERE co.workspace_id = ${ctx.workspaceId} AND co.deleted_at IS NULL AND ${scopeWhere(ctx, 'company', 'view', 'co')}
        AND (co.name ILIKE ${t} OR ${method('company', 'co')}) ORDER BY co.updated_at DESC LIMIT 6`));
    const results = (await Promise.all(tasks)).flat();
    return { data: camelAll(results) };
  });
}
