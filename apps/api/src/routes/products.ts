import type { FastifyInstance } from 'fastify';
import { listQuerySchema, productCreateSchema, productUpdateSchema } from '@crm/shared';
import { z } from 'zod';
import { pool, q, q1, sql } from '../db/index.ts';
import { notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { likeTerm, qs, runList } from '../lib/list.ts';
import { requireAdmin, requireAny } from '../lib/permissions.ts';
import { assertRefs, camel, camelAll, insertRow, pickColumns, updateRow } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

type IdParams = { Params: { id: string } };
const COLS: Record<string, string> = {
  name: 'name', sku: 'sku', categoryId: 'category_id', description: 'description', unitPrice: 'unit_price', currency: 'currency',
  unit: 'unit', taxRate: 'tax_rate', taxIncluded: 'tax_included', isActive: 'is_active',
};

export async function productRoutes(app: FastifyInstance) {
  app.get('/products', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'product', 'view');
    const query = parse(listQuerySchema, req.query);
    const active = qs.str(query.active);
    const r = await runList({
      select: sql`p.id, p.name, p.sku, p.category_id, p.unit_price, p.currency, p.unit, p.tax_rate, p.tax_included, p.is_active, p.created_at, c.name AS category_name`,
      from: sql`products p LEFT JOIN product_categories c ON c.id = p.category_id`,
      where: [
        sql`p.workspace_id = ${ctx.workspaceId}`, sql`p.deleted_at IS NULL`,
        qs.id(query.categoryId) ? sql`p.category_id = ${qs.id(query.categoryId)}` : null,
        active === 'true' ? sql`p.is_active` : active === 'false' ? sql`NOT p.is_active` : null,
      ],
      search: (t) => sql`(p.name ILIKE ${likeTerm(t)} OR p.sku ILIKE ${likeTerm(t)})`,
      sorts: { name: 'lower(p.name)', unitPrice: 'p.unit_price', sku: 'lower(p.sku)', createdAt: 'p.created_at', category: 'lower(c.name)' },
      defaultSort: 'name',
    }, query);
    return { ...r, data: camelAll(r.data as Record<string, unknown>[]) };
  });

  app.get<IdParams>('/products/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'product', 'view');
    const row = await q1(sql`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE p.id = ${Number(req.params.id)} AND p.workspace_id = ${ctx.workspaceId} AND p.deleted_at IS NULL`);
    if (!row) throw notFound('Product');
    const usage = await q1(sql`SELECT count(DISTINCT li.parent_id)::int AS deals, coalesce(sum(li.quantity),0)::text AS quantity,
      coalesce(sum(li.line_total) FILTER (WHERE d.status = 'won'),0)::text AS won_revenue
      FROM line_items li JOIN deals d ON d.id = li.parent_id AND li.parent_type = 'deal' AND d.deleted_at IS NULL WHERE li.product_id = ${Number(req.params.id)}`);
    return { ...camel(row), usage: camel(usage) };
  });

  app.post('/products', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'product', 'create');
    const body = parse(productCreateSchema, req.body);
    await assertRefs(ctx, [{ table: 'product_categories', ids: [body.categoryId], label: 'Category' }]);
    const row = await insertRow(pool, 'products', {
      ...pickColumns(body, COLS), currency: body.currency ?? ctx.baseCurrency, workspace_id: ctx.workspaceId, created_by: ctx.userId,
    });
    return reply.code(201).send(camel(row));
  });

  app.patch<IdParams>('/products/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'product', 'edit');
    const body = parse(productUpdateSchema, req.body);
    await assertRefs(ctx, [{ table: 'product_categories', ids: [body.categoryId], label: 'Category' }]);
    const exists = await q1(sql`SELECT 1 FROM products WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`);
    if (!exists) throw notFound('Product');
    const row = await updateRow(pool, 'products', Number(req.params.id), ctx.workspaceId, pickColumns(body, COLS));
    return camel(row);
  });

  // Categories (admin)
  const catSchema = z.object({ name: z.string().trim().min(1, 'Required').max(80) });
  app.post('/product-categories', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(catSchema, req.body);
    const row = await q1(sql`INSERT INTO product_categories (workspace_id, name, sort)
      VALUES (${ctx.workspaceId}, ${body.name}, (SELECT coalesce(max(sort),0)+1 FROM product_categories WHERE workspace_id = ${ctx.workspaceId})) RETURNING *`);
    return reply.code(201).send(camel(row));
  });
  app.patch<IdParams>('/product-categories/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(catSchema, req.body);
    const row = await q1(sql`UPDATE product_categories SET name = ${body.name} WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} RETURNING *`);
    if (!row) throw notFound('Category');
    return camel(row);
  });
  app.delete<IdParams>('/product-categories/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    await q(sql`DELETE FROM product_categories WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId}`);
    return reply.code(204).send();
  });
}
