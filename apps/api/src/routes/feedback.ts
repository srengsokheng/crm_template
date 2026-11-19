/**
 * Customer feedback after a won deal (Settings → Customer feedback).
 *
 * N days after a deal is won (only deals won after the setting was turned on), the worker emails the deal's main
 * contact a link to rate us 1–5 with an optional comment (/r/<token>, customer language). One request per deal; anyone
 * who may edit a won deal can also ask right away. Contacts who unsubscribed from emails are never asked. The rating
 * counts for the deal owner at the time of asking; they're notified of the answer (low ratings stand out), and it's on
 * the deal's timeline. Results: the deal page, and a Home card per salesperson — who sees whom follows deal view
 * permissions (like sales targets).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ct, feedbackAnswerSchema, feedbackSettingsSchema, type CustomerLanguage, type FeedbackSettings } from '@crm/shared';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { systemCtx, type Ctx } from '../lib/context.ts';
import { AppError, conflict, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { customerMail, queueMail, workspaceSender } from '../lib/mailer.ts';
import { requireAdmin, scopeOf, scopeWhere } from '../lib/permissions.ts';
import { camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { documentSettings, loadDeal } from './documents.ts';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const rateUrl = (t: string) => `${config.appUrl.replace(/\/$/, '')}/r/${t}`;
/** Answers are accepted (and can be changed) for this long after asking. */
const ANSWER_DAYS = 30;

type Stored = FeedbackSettings & { enabledAt?: string | null };
async function feedbackSettings(workspaceId: number, db: Db = pool): Promise<Stored> {
  const r = await q1<{ s: Record<string, unknown> | null }>(sql`SELECT settings->'feedback' AS s FROM workspaces WHERE id = ${workspaceId}`, db);
  const parsed = feedbackSettingsSchema.safeParse(r?.s ?? {});
  return { ...(parsed.success ? parsed.data : feedbackSettingsSchema.parse({})), enabledAt: (r?.s?.enabledAt as string | undefined) ?? null };
}

/** The contact to ask: the deal's primary contact with an email address who hasn't unsubscribed (else the first such). */
async function recipientOf(db: Db, dealId: number) {
  return q1<{ contact_id: number; email: string; first_name: string | null }>(sql`
    SELECT c.id AS contact_id, m.value AS email, c.first_name FROM deal_contacts dc
    JOIN contacts c ON c.id = dc.contact_id AND c.deleted_at IS NULL AND c.email_opt_out_at IS NULL
    JOIN contact_methods m ON m.party_type = 'contact' AND m.party_id = c.id AND m.kind = 'email'
    WHERE dc.deal_id = ${dealId} ORDER BY dc.is_primary DESC, m.is_primary DESC, c.id, m.id LIMIT 1`, db);
}

/** Sends the request for one won deal; false when it was already asked or nobody can be asked. */
async function ask(db: Db, deal: { id: number; workspace_id: number; owner_id: number | null; title: string }, by: Ctx | null): Promise<boolean> {
  const to = await recipientOf(db, deal.id);
  if (!to) return false;
  const token = randomBytes(24).toString('base64url');
  const row = await q1<{ id: number }>(sql`INSERT INTO feedback_requests (workspace_id, deal_id, contact_id, email, owner_id, token_hash, sent_by)
    VALUES (${deal.workspace_id}, ${deal.id}, ${to.contact_id}, ${to.email}, ${deal.owner_id}, ${hash(token)}, ${by?.userId ?? null})
    ON CONFLICT (deal_id) DO NOTHING RETURNING id`, db);
  if (!row) return false;
  const s = await documentSettings(deal.workspace_id, db);
  const lang: CustomerLanguage = s.customerLanguage;
  const owner = deal.owner_id ? await q1<{ name: string; email: string }>(sql`SELECT name, email FROM users WHERE id = ${deal.owner_id}`, db) : null;
  await queueMail({
    ...customerMail({
      to: to.email, replyTo: owner?.email, subject: ct(lang, 'fbTitle', { company: s.sellerName }),
      lines: [...(to.first_name ? [ct(lang, 'fbHello', { name: to.first_name })] : []), ct(lang, 'fbAsk', { company: s.sellerName })],
      button: { label: ct(lang, 'fbButton'), url: rateUrl(token) }, footer: owner ? `${owner.name} · ${s.sellerName}` : s.sellerName,
    }),
    fromName: await workspaceSender(deal.workspace_id, db),
  }, db, { workspaceId: deal.workspace_id });
  await audit(db, by ?? systemCtx(deal.workspace_id, 0), 'deal', deal.id, 'feedback_requested', { to: to.email }, by ? 'user' : 'automation');
  return true;
}

/** Worker: asks for feedback on deals won `delayDays` ago (won after reminders were turned on, within the last 30 days). */
export async function runFeedbackRequests(now: Date = new Date()): Promise<number> {
  const rows = await q<{ id: number; workspace_id: number; owner_id: number | null; title: string; delay: number; enabled_at: string | null }>(sql`
    SELECT d.id, d.workspace_id, d.owner_id, d.title, coalesce((w.settings->'feedback'->>'delayDays')::int, 2) AS delay, w.settings->'feedback'->>'enabledAt' AS enabled_at
    FROM deals d JOIN workspaces w ON w.id = d.workspace_id
    WHERE d.status = 'won' AND d.deleted_at IS NULL AND d.closed_at IS NOT NULL AND (w.settings->'feedback'->>'enabled') = 'true'
      AND d.closed_at <= ${now}::timestamptz - make_interval(days => coalesce((w.settings->'feedback'->>'delayDays')::int, 2))
      AND d.closed_at > ${now}::timestamptz - make_interval(days => coalesce((w.settings->'feedback'->>'delayDays')::int, 2) + 30)
      AND d.closed_at >= coalesce((w.settings->'feedback'->>'enabledAt')::timestamptz, 'infinity'::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM feedback_requests f WHERE f.deal_id = d.id)
    ORDER BY d.closed_at LIMIT 200`);
  let sent = 0;
  for (const d of rows) {
    try { if (await tx((db) => ask(db, d, null))) sent++; } catch { /* tried again next round */ }
  }
  return sent;
}

/** People whose ratings this user may see (as for sales targets). */
function visibleOwners(ctx: Ctx): number[] | null | 'none' {
  const scope = ctx.isAdmin ? 'all' : scopeOf(ctx, 'deal', 'view');
  if (scope === 'none') return 'none';
  return scope === 'all' ? null : scope === 'team' ? ctx.teamUserIds : [ctx.userId];
}

export async function feedbackRoutes(app: FastifyInstance) {
  app.get('/settings/feedback', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const { enabledAt: _e, ...s } = await feedbackSettings(ctx.workspaceId);
    return s;
  });
  app.put('/settings/feedback', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(feedbackSettingsSchema, req.body);
    const before = await feedbackSettings(ctx.workspaceId);
    // Turning it on starts from now: deals won earlier aren't asked all at once.
    const enabledAt = body.enabled ? (before.enabled && before.enabledAt ? before.enabledAt : new Date().toISOString()) : null;
    await q(sql`UPDATE workspaces SET settings = settings || jsonb_build_object('feedback', ${JSON.stringify({ ...body, enabledAt })}::jsonb) WHERE id = ${ctx.workspaceId}`);
    return body;
  });

  /** The deal's request and answer. */
  app.get<{ Params: { id: string } }>('/deals/:id/feedback', async (req) => {
    const ctx = ctxOf(req);
    const deal = await loadDeal(pool, ctx, Number(req.params.id), 'view');
    const f = await q1(sql`SELECT f.email, f.sent_at, f.rating, f.comment, f.responded_at, u.name AS sent_by_name, o.name AS owner_name
      FROM feedback_requests f LEFT JOIN users u ON u.id = f.sent_by LEFT JOIN users o ON o.id = f.owner_id WHERE f.deal_id = ${deal.id}`);
    const status = (await q1<{ status: string }>(sql`SELECT status FROM deals WHERE id = ${deal.id}`))!.status;
    const settings = await feedbackSettings(ctx.workspaceId);
    return {
      request: f ? camelAll([f])[0] : null, won: status === 'won', autoEnabled: settings.enabled, delayDays: settings.delayDays,
      canAsk: status === 'won' && !f && !!(await recipientOf(pool, deal.id)),
    };
  });

  /** Ask now (a won deal that hasn't been asked). */
  app.post<{ Params: { id: string } }>('/deals/:id/feedback', async (req) => {
    const ctx = ctxOf(req);
    await tx(async (db) => {
      const deal = await loadDeal(db, ctx, Number(req.params.id), 'edit');
      const d = (await q1<{ id: number; workspace_id: number; owner_id: number | null; title: string; status: string }>(sql`SELECT id, workspace_id, owner_id, title, status FROM deals WHERE id = ${deal.id} FOR UPDATE`, db))!;
      if (d.status !== 'won') throw conflict('Ask for feedback once the deal is won');
      if (await q1(sql`SELECT 1 FROM feedback_requests WHERE deal_id = ${d.id}`, db)) throw conflict('This customer was already asked');
      if (!(await ask(db, d, ctx))) throw new AppError(422, 'NO_RECIPIENT', 'Nobody to ask: add a contact with an email address to the deal (contacts who unsubscribed from emails are skipped).');
    });
    return { ok: true };
  });

  /** Average rating per salesperson (last `days` days) and the latest comments, for the people this user may see. */
  app.get('/feedback/summary', async (req) => {
    const ctx = ctxOf(req);
    const days = Math.min(365, Math.max(7, Number((req.query as { days?: string }).days) || 90));
    const owners = visibleOwners(ctx);
    if (owners === 'none') return { days, overall: null, people: [], comments: [] };
    const scope = owners ? sql`AND f.owner_id = ANY(${owners})` : sql``;
    const where = sql`f.workspace_id = ${ctx.workspaceId} AND f.sent_at > now() - make_interval(days => ${days}) ${scope}`;
    const overall = await q1<{ asked: number; answered: number; average: string | null }>(sql`SELECT count(*)::int AS asked, count(f.rating)::int AS answered,
      round(avg(f.rating), 1)::text AS average FROM feedback_requests f WHERE ${where}`);
    const people = await q(sql`SELECT f.owner_id AS user_id, coalesce(u.name, 'Former member') AS name, count(*)::int AS asked, count(f.rating)::int AS answered,
        round(avg(f.rating), 1)::text AS average, count(*) FILTER (WHERE f.rating <= 2)::int AS low
      FROM feedback_requests f LEFT JOIN users u ON u.id = f.owner_id WHERE ${where}
      GROUP BY f.owner_id, u.name ORDER BY avg(f.rating) DESC NULLS LAST, u.name LIMIT 50`);
    // Comments only from deals the user may open.
    const comments = await q(sql`SELECT f.deal_id, d.title AS deal_title, f.rating, f.comment, f.responded_at, u.name AS owner_name
      FROM feedback_requests f JOIN deals d ON d.id = f.deal_id AND d.deleted_at IS NULL LEFT JOIN users u ON u.id = f.owner_id
      WHERE ${where} AND f.rating IS NOT NULL AND ${scopeWhere(ctx, 'deal', 'view', 'd')}
      ORDER BY f.responded_at DESC LIMIT 8`);
    return { days, overall: overall!.asked ? overall : null, people: camelAll(people), comments: camelAll(comments) };
  });
}

// ───────────────────────── Public ─────────────────────────

export async function publicFeedbackRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: config.isTest ? 1000 : 30, timeWindow: '1 minute' } } };
  async function byToken(token: string, db: Db = pool, lock = false) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return q1<{ id: number; workspace_id: number; deal_id: number; owner_id: number | null; rating: number | null; comment: string; sent_at: Date; email: string; contact_id: number | null }>(sql`
      SELECT * FROM feedback_requests WHERE token_hash = ${hash(token)} ${lock ? sql`FOR UPDATE` : sql``}`, db);
  }
  const expired = (sentAt: Date) => Date.now() - new Date(sentAt).getTime() > ANSWER_DAYS * 86_400_000;

  app.get<{ Params: { token: string } }>('/public/feedback/:token', limit, async (req) => {
    const f = await byToken(req.params.token);
    if (!f) throw notFound('Link');
    const s = await documentSettings(f.workspace_id);
    const owner = f.owner_id ? await q1<{ name: string }>(sql`SELECT name FROM users WHERE id = ${f.owner_id}`) : null;
    return { company: s.sellerName, owner: owner?.name ?? s.sellerName, lang: s.customerLanguage, rating: f.rating, comment: f.comment, expired: expired(f.sent_at) };
  });

  app.post<{ Params: { token: string } }>('/public/feedback/:token', limit, async (req) => {
    const body = parse(feedbackAnswerSchema, req.body);
    await tx(async (db) => {
      const f = await byToken(req.params.token, db, true);
      if (!f) throw notFound('Link');
      if (expired(f.sent_at)) throw new AppError(410, 'EXPIRED', 'This feedback link has expired.');
      const first = f.rating === null;
      await q(sql`UPDATE feedback_requests SET rating = ${body.rating}, comment = ${body.comment}, responded_at = now() WHERE id = ${f.id}`, db);
      const deal = await q1<{ title: string }>(sql`SELECT title FROM deals WHERE id = ${f.deal_id}`, db);
      const ctx = systemCtx(f.workspace_id, 0);
      await audit(db, ctx, 'deal', f.deal_id, first ? 'feedback_received' : 'feedback_changed', { rating: body.rating, comment: body.comment.slice(0, 500), from: f.email }, 'system');
      if (f.owner_id) {
        await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
          VALUES (${f.workspace_id}, ${f.owner_id}, 'feedback', ${`${body.rating <= 2 ? 'Low rating' : 'New rating'}: ${body.rating}/5 for ${deal?.title ?? 'a deal'}`},
            ${body.comment.slice(0, 140) || `From ${f.email}`}, 'deal', ${f.deal_id})`, db);
      }
    });
    return { ok: true };
  });
}
