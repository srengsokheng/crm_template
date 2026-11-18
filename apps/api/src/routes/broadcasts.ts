/**
 * Broadcasts: one message to many customers at once (admins only).
 *
 * - Telegram bot: text to everyone who chatted with the bot privately.
 * - WhatsApp: an approved template (Meta allows nothing else outside the 24-hour window).
 * - Email: subject and text to contacts with an email address (optionally one contact type), with an unsubscribe link.
 *
 * Messenger/Instagram are left out (Meta forbids marketing there), and so is the personal Telegram account (bulk
 * messages get accounts banned) and website chat (visitors aren't reachable once they leave).
 *
 * Opt-out: "STOP" in a Telegram/WhatsApp chat (see inbox/store.ts) or the email link; opted-out people are never
 * included. The audience is fixed when sending starts; the worker sends in batches. Chat messages appear in each
 * conversation (without moving it to the top of the Inbox) and go out through the normal delivery queue.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { broadcastSchema, broadcastSendSchema, ct, personalize, type BroadcastInput, type CustomerLanguage } from '@crm/shared';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { ctxOf, noContent } from '../lib/http.ts';
import { broadcastMail, queueMail, workspaceSender } from '../lib/mailer.ts';
import { requireAdmin } from '../lib/permissions.ts';
import { camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { listTemplates, renderTemplate, type Template } from '../inbox/meta.ts';
import type { ChannelRow } from '../inbox/store.ts';
import { systemCtx, type Ctx } from '../lib/context.ts';

interface Broadcast {
  id: number; workspace_id: number; name: string; channel_kind: 'telegram_bot' | 'whatsapp' | 'email'; channel_id: number | null;
  subject: string; body: string; template: { name: string; language: string; params: string[] } | null; contact_type_id: number | null;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'canceled'; send_at: string | null; created_by: number | null;
}

const BATCH = 200;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const base = () => config.appUrl.replace(/\/$/, '');

/** Who a broadcast reaches right now (opted-out people and deleted contacts left out). */
function audienceQuery(ws: number, b: Pick<Broadcast, 'channel_kind' | 'channel_id' | 'contact_type_id'>) {
  if (b.channel_kind === 'email') {
    // One row per address (several contacts may share one), never an address someone unsubscribed.
    return sql`SELECT DISTINCT ON (m.normalized) c.id AS contact_id, NULL::bigint AS conversation_id, m.value AS address,
        trim(concat_ws(' ', c.first_name, c.last_name)) AS name
      FROM contacts c JOIN contact_methods m ON m.party_type = 'contact' AND m.party_id = c.id AND m.kind = 'email' AND m.workspace_id = ${ws}
      WHERE c.workspace_id = ${ws} AND c.deleted_at IS NULL AND c.email_opt_out_at IS NULL AND m.normalized LIKE '%@%'
        ${b.contact_type_id ? sql`AND c.type_id = ${b.contact_type_id}` : sql``}
        AND NOT EXISTS (SELECT 1 FROM contact_methods m2 JOIN contacts c2 ON c2.id = m2.party_id
          WHERE m2.workspace_id = ${ws} AND m2.party_type = 'contact' AND m2.kind = 'email' AND m2.normalized = m.normalized AND c2.email_opt_out_at IS NOT NULL)
      ORDER BY m.normalized, m.is_primary DESC, c.id`;
  }
  return sql`SELECT cv.contact_id, cv.id AS conversation_id, '' AS address,
      coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), nullif(cv.profile->>'name', ''), cv.title) AS name
    FROM conversations cv LEFT JOIN contacts ct ON ct.id = cv.contact_id AND ct.deleted_at IS NULL
    WHERE cv.workspace_id = ${ws} AND cv.channel_id = ${b.channel_id} AND cv.kind = 'direct' AND cv.opted_out_at IS NULL`;
}

/** How many people opted out on this channel (shown next to the audience count). */
async function optedOut(ws: number, b: Pick<Broadcast, 'channel_kind' | 'channel_id'>, db: Db = pool): Promise<number> {
  const r = b.channel_kind === 'email'
    ? await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${ws} AND deleted_at IS NULL AND email_opt_out_at IS NOT NULL`, db)
    : await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM conversations WHERE workspace_id = ${ws} AND channel_id = ${b.channel_id} AND kind = 'direct' AND opted_out_at IS NOT NULL`, db);
  return r!.n;
}

/** Checks the channel and (WhatsApp) the template; returns the template when there is one. */
async function checkSource(ctx: Ctx, b: BroadcastInput, db: Db = pool): Promise<Template | null> {
  if (b.channelKind === 'email') {
    if (b.contactTypeId) {
      const t = await q1(sql`SELECT 1 FROM dictionary_items WHERE id = ${b.contactTypeId} AND workspace_id = ${ctx.workspaceId}`, db);
      if (!t) throw badRequest('Unknown contact type', { contactTypeId: 'Pick a contact type from the list' });
    }
    return null;
  }
  const ch = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${b.channelId} AND workspace_id = ${ctx.workspaceId}`, db);
  if (!ch || ch.kind !== b.channelKind) throw badRequest('Pick a channel of this kind', { channelId: 'Pick a channel of this kind' });
  if (b.channelKind !== 'whatsapp') return null;
  let list: Template[];
  try { list = await listTemplates(ch); } catch (e) {
    if (e instanceof AppError) throw e; // e.g. the business account ID is missing
    throw new AppError(502, 'META', 'Couldn’t load the approved templates from WhatsApp. Check the channel and try again.');
  }
  const t = list.find((x) => x.name === b.template!.name && x.language === b.template!.language);
  if (!t) throw badRequest('This template isn’t approved (any more). Pick another one.', { template: 'Pick an approved template' });
  if (b.template!.params.length !== t.params || b.template!.params.some((p) => !p.trim())) {
    throw badRequest(`This template needs ${t.params} value${t.params === 1 ? '' : 's'}`, { template: 'Fill in every blank' });
  }
  return t;
}

const FIELDS = sql`b.id, b.name, b.channel_kind, b.channel_id, ch.name AS channel_name, b.subject, b.body, b.template, b.contact_type_id,
  b.status, b.send_at, b.sent_at, b.created_at, u.name AS created_by_name,
  (SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id = b.id) AS recipients`;
const FROM = sql`broadcasts b LEFT JOIN channels ch ON ch.id = b.channel_id LEFT JOIN users u ON u.id = b.created_by`;

/** Progress: delivered (chat: the platform accepted it; email: handed to the mail queue), failed, still going. */
async function stats(id: number) {
  return (await q1(sql`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE r.status = 'pending' OR m.status = 'pending')::int AS sending,
      count(*) FILTER (WHERE (r.status = 'queued' AND r.message_id IS NULL) OR r.status = 'sent' OR m.status = 'sent')::int AS delivered,
      count(*) FILTER (WHERE r.status = 'failed' OR m.status = 'failed')::int AS failed,
      count(*) FILTER (WHERE r.status = 'skipped')::int AS skipped
    FROM broadcast_recipients r LEFT JOIN messages m ON m.id = r.message_id WHERE r.broadcast_id = ${id}`))!;
}

async function loadOwn(db: Db, ctx: Ctx, id: number, lock = false): Promise<Broadcast> {
  const b = await q1<Broadcast>(sql`SELECT * FROM broadcasts WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} ${lock ? sql`FOR UPDATE` : sql``}`, db);
  if (!b) throw notFound('Broadcast');
  return b;
}

const output = async (id: number) => {
  const row = await q1(sql`SELECT ${FIELDS} FROM ${FROM} WHERE b.id = ${id}`);
  return { ...camel(row!), stats: await stats(id) };
};

// ───────────────────────── Worker ─────────────────────────

/** Fixes the audience of a broadcast whose time came, and starts it. */
async function start(db: Db, b: Broadcast): Promise<void> {
  const rows = await q<{ contact_id: number | null; conversation_id: number | null; address: string; name: string }>(audienceQuery(b.workspace_id, b), db);
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await q(sql`INSERT INTO broadcast_recipients (broadcast_id, contact_id, conversation_id, address, name)
      SELECT ${b.id}, x.contact_id, x.conversation_id, x.address, coalesce(x.name, '')
      FROM json_to_recordset(${JSON.stringify(part)}::json) AS x(contact_id bigint, conversation_id bigint, address text, name text)`, db);
  }
  await q(sql`UPDATE broadcasts SET status = 'sending', send_at = coalesce(send_at, now()) WHERE id = ${b.id}`, db);
}

/** Sends the next batch of one broadcast; marks it sent (and tells its author) when nobody is left. */
async function sendBatch(db: Db, b: Broadcast): Promise<number> {
  const todo = await q<{ id: number; contact_id: number | null; conversation_id: number | null; address: string; name: string }>(sql`
    SELECT id, contact_id, conversation_id, address, name FROM broadcast_recipients
    WHERE broadcast_id = ${b.id} AND status = 'pending' ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`, db);
  const fail = (rid: number, error: string) => q(sql`UPDATE broadcast_recipients SET status = 'failed', error = ${error} WHERE id = ${rid}`, db);
  const author = b.created_by ? await q1<{ name: string; email: string }>(sql`SELECT name, email FROM users WHERE id = ${b.created_by}`, db) : null;
  if (b.channel_kind === 'email') {
    const ws = await q1<{ name: string; lang: string | null }>(sql`SELECT name, settings->'documents'->>'customerLanguage' AS lang FROM workspaces WHERE id = ${b.workspace_id}`, db);
    const lang = (['en', 'km', 'both'].includes(ws?.lang ?? '') ? ws!.lang : 'en') as CustomerLanguage;
    const fromName = await workspaceSender(b.workspace_id, db);
    for (const r of todo) {
      // Still subscribed? (someone may have unsubscribed since the broadcast started)
      const still = r.contact_id ? await q1(sql`SELECT 1 FROM contacts WHERE id = ${r.contact_id} AND deleted_at IS NULL AND email_opt_out_at IS NULL`, db) : null;
      if (!still) { await q(sql`UPDATE broadcast_recipients SET status = 'skipped', error = 'Unsubscribed or deleted' WHERE id = ${r.id}`, db); continue; }
      const token = randomBytes(24).toString('base64url');
      const page = `${base()}/unsubscribe/${token}`;
      await queueMail({
        ...broadcastMail({
          to: r.address, subject: personalize(b.subject, r.name), body: personalize(b.body, r.name), replyTo: author?.email,
          footer: ct(lang, 'unsubFooter', { company: ws?.name ?? '', url: page }), unsubscribeUrl: `${base()}/api/v1/public/unsubscribe/${token}`,
        }),
        fromName,
      }, db, { workspaceId: b.workspace_id });
      await q(sql`UPDATE broadcast_recipients SET status = 'sent', token_hash = ${hashToken(token)}, sent_at = now() WHERE id = ${r.id}`, db);
    }
  } else {
    const ch = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${b.channel_id}`, db);
    let template: Template | null = null;
    let problem = !ch ? 'The channel was removed.' : ch.status !== 'active' ? 'The channel is disabled or disconnected.' : null;
    if (!problem && b.channel_kind === 'whatsapp') {
      // If Meta can't be reached this throws, and the next round tries again.
      template = (await listTemplates(ch!)).find((x) => x.name === b.template!.name && x.language === b.template!.language) ?? null;
      if (!template) problem = 'The template is no longer approved by WhatsApp.';
    }
    for (const r of todo) {
      if (problem) { await fail(r.id, problem); continue; }
      const conv = await q1<{ id: number; opted_out_at: string | null }>(sql`SELECT id, opted_out_at FROM conversations WHERE id = ${r.conversation_id}`, db);
      if (!conv || conv.opted_out_at) { await q(sql`UPDATE broadcast_recipients SET status = 'skipped', error = 'Opted out or chat deleted' WHERE id = ${r.id}`, db); continue; }
      const params = template ? b.template!.params.map((p) => personalize(p, r.name)) : null;
      const text = template ? renderTemplate(template, params!) : personalize(b.body, r.name);
      const m = await q1<{ id: number }>(sql`INSERT INTO messages (workspace_id, conversation_id, direction, sender_name, author_id, body, status, template)
        VALUES (${b.workspace_id}, ${conv.id}, 'out', ${author?.name ?? ''}, ${b.created_by}, ${text}, 'pending',
          ${template ? JSON.stringify({ name: template.name, language: template.language, params }) : null}) RETURNING id`, db);
      await q(sql`INSERT INTO jobs (type, payload) VALUES ('inbox.send', ${JSON.stringify({ messageId: m!.id })})`, db);
      await q(sql`UPDATE broadcast_recipients SET status = 'queued', message_id = ${m!.id}, sent_at = now() WHERE id = ${r.id}`, db);
    }
  }
  if (todo.length < BATCH) {
    const done = await q1(sql`UPDATE broadcasts SET status = 'sent', sent_at = now() WHERE id = ${b.id} AND NOT EXISTS
      (SELECT 1 FROM broadcast_recipients WHERE broadcast_id = ${b.id} AND status = 'pending') RETURNING id`, db);
    if (done && b.created_by) {
      const n = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = ${b.id} AND status IN ('queued', 'sent')`, db);
      await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
        VALUES (${b.workspace_id}, ${b.created_by}, 'broadcast', ${`Broadcast “${b.name}” was sent`}, ${`${n!.n} ${n!.n === 1 ? 'person' : 'people'}`}, 'broadcast', ${b.id})`, db);
    }
  }
  return todo.length;
}

/** Worker: starts broadcasts whose time came and sends one batch of each running one. Returns how many it handled. */
export async function runBroadcasts(): Promise<number> {
  let n = 0;
  const due = await q<{ id: number }>(sql`SELECT id FROM broadcasts WHERE (status = 'scheduled' AND send_at <= now()) OR status = 'sending' ORDER BY id LIMIT 20`);
  for (const { id } of due) {
    await tx(async (db) => {
      const b = await q1<Broadcast>(sql`SELECT * FROM broadcasts WHERE id = ${id} AND status IN ('scheduled', 'sending') FOR UPDATE SKIP LOCKED`, db);
      if (!b) return;
      if (b.status === 'scheduled') await start(db, b);
      n += await sendBatch(db, { ...b, status: 'sending' });
    }).catch(() => { /* e.g. WhatsApp templates unreachable: the next round tries again */ });
  }
  return n;
}

/** Sends everything due now (tests and the "Send now" button, so people see progress at once). */
export async function drainBroadcasts(): Promise<void> {
  for (let i = 0; i < 100 && (await runBroadcasts()) > 0; i++);
}

// ───────────────────────── Routes ─────────────────────────

export async function broadcastRoutes(app: FastifyInstance) {
  app.get('/broadcasts', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const before = Number((req.query as { before?: string }).before) || null;
    const rows = await q(sql`SELECT ${FIELDS} FROM ${FROM} WHERE b.workspace_id = ${ctx.workspaceId} ${before ? sql`AND b.id < ${before}` : sql``}
      ORDER BY b.id DESC LIMIT 26`);
    return { data: camelAll(rows.slice(0, 25)), nextCursor: rows.length > 25 ? String((rows[24] as { id: number }).id) : null };
  });

  /** How many people a broadcast would reach (and how many opted out), before saving or sending. */
  app.get('/broadcasts/audience', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const query = req.query as { channelKind?: string; channelId?: string; contactTypeId?: string };
    const kind = query.channelKind as Broadcast['channel_kind'];
    if (!['telegram_bot', 'whatsapp', 'email'].includes(kind)) throw badRequest('Pick a channel');
    const channelId = Number(query.channelId) || null;
    if (kind !== 'email') {
      const ch = await q1(sql`SELECT 1 FROM channels WHERE id = ${channelId} AND workspace_id = ${ctx.workspaceId} AND kind = ${kind}`);
      if (!ch) throw notFound('Channel');
    }
    const b = { channel_kind: kind, channel_id: channelId, contact_type_id: Number(query.contactTypeId) || null };
    const r = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM (${audienceQuery(ctx.workspaceId, b)}) a`);
    return { count: r!.n, optedOut: await optedOut(ctx.workspaceId, b) };
  });

  /** WhatsApp: the approved templates of a channel, for the broadcast form. */
  app.get('/broadcasts/templates', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const ch = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${Number((req.query as { channelId?: string }).channelId) || 0}
      AND workspace_id = ${ctx.workspaceId} AND kind = 'whatsapp'`);
    if (!ch) throw notFound('Channel');
    try { return { data: await listTemplates(ch) }; } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'META', 'Couldn’t load the approved templates from WhatsApp. Check the channel’s WhatsApp Business account ID.');
    }
  });

  app.get<{ Params: { id: string } }>('/broadcasts/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const b = await loadOwn(pool, ctx, Number(req.params.id));
    return output(b.id);
  });

  /** People of a broadcast, 50 at a time (optionally only failed ones). */
  app.get<{ Params: { id: string } }>('/broadcasts/:id/recipients', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const b = await loadOwn(pool, ctx, Number(req.params.id));
    const query = req.query as { status?: string; page?: string };
    const page = Math.max(1, Number(query.page) || 1);
    const failedOnly = query.status === 'failed';
    const where = sql`r.broadcast_id = ${b.id} ${failedOnly ? sql`AND (r.status = 'failed' OR m.status = 'failed')` : sql``}`;
    const rows = await q(sql`SELECT r.id, r.name, r.address, r.conversation_id, r.contact_id, r.sent_at,
        CASE WHEN m.status = 'failed' THEN 'failed' WHEN m.status = 'pending' THEN 'sending' WHEN m.status = 'sent' THEN 'sent'
             WHEN r.status = 'queued' THEN 'sending' ELSE r.status END AS status,
        coalesce(m.error, r.error) AS error
      FROM broadcast_recipients r LEFT JOIN messages m ON m.id = r.message_id WHERE ${where} ORDER BY r.id LIMIT 50 OFFSET ${(page - 1) * 50}`);
    const total = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM broadcast_recipients r LEFT JOIN messages m ON m.id = r.message_id WHERE ${where}`);
    return { data: camelAll(rows), total: total!.n, page, pageSize: 50 };
  });

  app.post('/broadcasts', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(broadcastSchema, req.body);
    await checkSource(ctx, body);
    const r = await q1<{ id: number }>(sql`INSERT INTO broadcasts (workspace_id, name, channel_kind, channel_id, subject, body, template, contact_type_id, created_by)
      VALUES (${ctx.workspaceId}, ${body.name}, ${body.channelKind}, ${body.channelKind === 'email' ? null : body.channelId}, ${body.subject}, ${body.body},
        ${body.channelKind === 'whatsapp' ? JSON.stringify(body.template) : null}, ${body.channelKind === 'email' ? body.contactTypeId : null}, ${ctx.userId}) RETURNING id`);
    await audit(pool, ctx, 'broadcast', r!.id, 'created', { name: body.name, channel: body.channelKind });
    return reply.code(201).send(await output(r!.id));
  });

  /** Edit a draft or a scheduled broadcast (a scheduled one goes back to draft until it's scheduled again). */
  app.put<{ Params: { id: string } }>('/broadcasts/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(broadcastSchema, req.body);
    await checkSource(ctx, body);
    await tx(async (db) => {
      const b = await loadOwn(db, ctx, Number(req.params.id), true);
      if (b.status !== 'draft' && b.status !== 'scheduled') throw conflict('This broadcast was already sent; make a copy to change it');
      await q(sql`UPDATE broadcasts SET name = ${body.name}, channel_kind = ${body.channelKind}, channel_id = ${body.channelKind === 'email' ? null : body.channelId},
          subject = ${body.subject}, body = ${body.body}, template = ${body.channelKind === 'whatsapp' ? JSON.stringify(body.template) : null},
          contact_type_id = ${body.channelKind === 'email' ? body.contactTypeId : null}, status = 'draft', send_at = NULL
        WHERE id = ${b.id}`, db);
      await audit(db, ctx, 'broadcast', b.id, 'updated', { name: body.name });
    });
    return output(Number(req.params.id));
  });

  /** Send now, or schedule (sendAt in the future). */
  app.post<{ Params: { id: string } }>('/broadcasts/:id/send', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const { sendAt } = parse(broadcastSendSchema, req.body ?? {});
    if (sendAt && new Date(sendAt).getTime() < Date.now() - 60_000) throw badRequest('Pick a time in the future', { sendAt: 'Pick a time in the future' });
    const b0 = await loadOwn(pool, ctx, Number(req.params.id));
    // The template may have been withdrawn since the draft was saved.
    await checkSource(ctx, { name: b0.name, channelKind: b0.channel_kind, channelId: b0.channel_id, subject: b0.subject, body: b0.body, template: b0.template, contactTypeId: b0.contact_type_id });
    await tx(async (db) => {
      const b = await loadOwn(db, ctx, b0.id, true);
      if (b.status !== 'draft' && b.status !== 'scheduled') throw conflict('This broadcast was already sent');
      const n = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM (${audienceQuery(ctx.workspaceId, b)}) a`, db);
      if (!n!.n) throw new AppError(422, 'NO_AUDIENCE', 'Nobody would get this broadcast yet.');
      await q(sql`UPDATE broadcasts SET status = 'scheduled', send_at = ${sendAt ?? sql`now()`} WHERE id = ${b.id}`, db);
      await audit(db, ctx, 'broadcast', b.id, sendAt ? 'scheduled' : 'sent', { sendAt, people: n!.n });
    });
    if (!sendAt) await runBroadcasts().catch(() => { /* the worker carries on */ });
    return output(b0.id);
  });

  /** Stop a scheduled or running broadcast: whoever hasn't got it yet won't. */
  app.post<{ Params: { id: string } }>('/broadcasts/:id/cancel', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    await tx(async (db) => {
      const b = await loadOwn(db, ctx, Number(req.params.id), true);
      if (b.status !== 'scheduled' && b.status !== 'sending') throw conflict('Only a scheduled or sending broadcast can be stopped');
      await q(sql`UPDATE broadcast_recipients SET status = 'skipped', error = 'Stopped' WHERE broadcast_id = ${b.id} AND status = 'pending'`, db);
      await q(sql`UPDATE broadcasts SET status = 'canceled' WHERE id = ${b.id}`, db);
      await audit(db, ctx, 'broadcast', b.id, 'canceled', {});
    });
    return output(Number(req.params.id));
  });

  /** Delete a draft or a stopped broadcast (sent ones stay as a record). */
  app.delete<{ Params: { id: string } }>('/broadcasts/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    await tx(async (db) => {
      const b = await loadOwn(db, ctx, Number(req.params.id), true);
      if (b.status === 'sending' || b.status === 'sent') throw conflict('A sent broadcast stays as a record');
      await q(sql`DELETE FROM broadcasts WHERE id = ${b.id}`, db);
      await audit(db, ctx, 'broadcast', b.id, 'deleted', { name: b.name });
    });
    return noContent(reply);
  });
}

// ───────────────────────── Unsubscribe (public) ─────────────────────────

async function byToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return q1<{ id: number; contact_id: number | null; address: string; workspace_id: number; company: string; lang: string | null; opted_out: boolean }>(sql`
    SELECT r.id, r.contact_id, r.address, b.workspace_id, w.name AS company, w.settings->'documents'->>'customerLanguage' AS lang,
      coalesce((SELECT c.email_opt_out_at IS NOT NULL FROM contacts c WHERE c.id = r.contact_id), false) AS opted_out
    FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id JOIN workspaces w ON w.id = b.workspace_id
    WHERE r.token_hash = ${hashToken(token)}`);
}

/**
 * Opts every contact of the workspace with one of these addresses out of (or back into) broadcast emails — people
 * often exist twice — and notes it on each contact's timeline. `via`: the customer's link, or a team member.
 */
export async function setEmailOptOut(db: Db, ctx: Ctx, addresses: string[], out: boolean, via: 'link' | 'team'): Promise<number[]> {
  const norm = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!norm.length) return [];
  const changed = await q<{ id: number }>(sql`UPDATE contacts c SET email_opt_out_at = ${out ? sql`now()` : null}
    WHERE c.workspace_id = ${ctx.workspaceId} AND (c.email_opt_out_at IS NULL) = ${out} AND c.id IN (SELECT m.party_id FROM contact_methods m
      WHERE m.workspace_id = ${ctx.workspaceId} AND m.party_type = 'contact' AND m.kind = 'email' AND m.normalized = ANY(${norm}))
    RETURNING c.id`, db);
  for (const { id } of changed) {
    await audit(db, ctx, 'contact', id, out ? 'email_unsubscribed' : 'email_resubscribed', { via }, via === 'link' ? 'system' : 'user');
  }
  return changed.map((r) => r.id);
}

export async function publicUnsubscribeRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: config.isTest ? 1000 : 30, timeWindow: '1 minute' } } };
  // Mail apps' one-click unsubscribe posts a form ("List-Unsubscribe=One-Click"); its content doesn't matter.
  app.addContentTypeParser(['application/x-www-form-urlencoded', 'multipart/form-data'], { parseAs: 'string', bodyLimit: 4096 }, (_req, _body, done) => done(null, {}));
  /** What the unsubscribe page shows (it asks before unsubscribing: mail scanners open links). */
  app.get<{ Params: { token: string } }>('/public/unsubscribe/:token', limit, async (req) => {
    const r = await byToken(req.params.token);
    if (!r) throw notFound('Link');
    const lang = (['en', 'km', 'both'].includes(r.lang ?? '') ? r.lang : 'en') as CustomerLanguage;
    // Mask the address a little: whoever has the link sees whose it is, but not in full.
    const [user, domain] = r.address.split('@');
    return { company: r.company, email: `${user.slice(0, 2)}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}`, unsubscribed: r.opted_out, lang };
  });
  /** Unsubscribe; also the one-click POST mail apps send (List-Unsubscribe-Post), whatever its body. */
  app.post<{ Params: { token: string } }>('/public/unsubscribe/:token', limit, async (req, reply) => {
    const r = await byToken(req.params.token);
    if (!r) throw notFound('Link');
    const again = (req.body as { subscribe?: unknown } | null)?.subscribe === true;
    await tx((db) => setEmailOptOut(db, systemCtx(r.workspace_id, 0), [r.address], !again, 'link'));
    return reply.send({ unsubscribed: !again });
  });
}
