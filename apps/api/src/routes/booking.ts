/**
 * Online booking. Admins set up booking pages (Settings → Booking pages): a title, the team member customers meet
 * (host), the length, the weekly hours, how much notice is needed and how far ahead people can book, and whether it's
 * a video call. Customers open /book/<slug>, pick a free time (the host's open meetings and calls in the CRM block
 * times), and enter their name and email. The booking then:
 * - finds the contact by email, or creates one (owned by the host);
 * - adds a meeting for the host, linked to the contact, with a 15-minute reminder (and the host is notified);
 * - for video pages, opens a video call for that meeting (the guest link is the meeting's location);
 * - emails the customer a confirmation in the customer language with a calendar file and a link to cancel.
 * Times are in the workspace's time zone. Bookings for the same host are serialised, so a time can't be taken twice.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  activityCreateSchema, bookingCreateSchema, bookingPageSchema, bookingSlots, ct, customerDate, customerWeekday, dateIn, icsEvent, timeIn,
  type CustomerLanguage,
} from '@crm/shared';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { systemCtx, type Ctx } from '../lib/context.ts';
import { AppError, conflict, notFound } from '../lib/errors.ts';
import { ctxOf, noContent } from '../lib/http.ts';
import { bookingMail, queueMail, workspaceSender } from '../lib/mailer.ts';
import { requireAdmin } from '../lib/permissions.ts';
import { assertMembers, camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { createCall, guestUrlOf } from '../calls/calls.ts';
import { createActivity } from './activities.ts';
import { createContact } from './parties.ts';
import { documentSettings } from './documents.ts';

interface PageRow {
  id: number; workspace_id: number; slug: string; title: string; description: string; host_id: number; duration_minutes: number; days: number[];
  start_time: string; end_time: string; min_notice_hours: number; days_ahead: number; video: boolean; location: string; active: boolean;
}
interface BookingRow {
  id: number; workspace_id: number; page_id: number | null; host_id: number | null; activity_id: number | null; contact_id: number | null; call_id: number | null;
  title: string; starts_at: Date; ends_at: Date; name: string; email: string; status: 'booked' | 'canceled';
}

const base = () => config.appUrl.replace(/\/$/, '');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const pageUrl = (slug: string) => `${base()}/book/${slug}`;
const manageUrl = (token: string) => `${base()}/booking/${token}`;

/** A workspace's time zone, name and customer language. */
async function wsInfo(workspaceId: number, db: Db = pool) {
  const w = await q1<{ name: string; timezone: string }>(sql`SELECT name, timezone FROM workspaces WHERE id = ${workspaceId}`, db);
  return { name: w?.name ?? '', tz: w?.timezone || 'UTC', lang: (await documentSettings(workspaceId, db)).customerLanguage as CustomerLanguage };
}

/** "Mon 24 Nov 2026, 10:30" / "ច័ន្ទ 24 វិច្ឆិកា 2026, 10:30" in the workspace's time zone. */
export function whenText(lang: CustomerLanguage, iso: Date | string, tz: string): string {
  const d = dateIn(iso, tz);
  return `${customerWeekday(lang, d)} ${customerDate(lang, d)}, ${timeIn(iso, tz)}`;
}

/** The host's busy times: open meetings and calls in the CRM (default 30 minutes when no length is set). */
async function busyOf(db: Db, workspaceId: number, hostId: number, daysAhead: number) {
  const rows = await q<{ s: Date; e: Date }>(sql`SELECT due_at AS s, due_at + make_interval(mins => coalesce(nullif(duration_minutes, 0), 30)) AS e
    FROM activities WHERE workspace_id = ${workspaceId} AND assignee_id = ${hostId} AND deleted_at IS NULL AND status = 'open'
      AND kind IN ('meeting', 'call') AND due_at IS NOT NULL
      AND due_at < now() + make_interval(days => ${daysAhead + 2}) AND due_at > now() - interval '1 day'`, db);
  return rows.map((r) => ({ start: new Date(r.s).getTime(), end: new Date(r.e).getTime() }));
}

async function slotsOf(db: Db, p: PageRow, tz: string, now = new Date()) {
  return bookingSlots({
    hours: { days: p.days, start: p.start_time, end: p.end_time }, duration: p.duration_minutes, tz, now,
    minNoticeHours: p.min_notice_hours, daysAhead: p.days_ahead, busy: await busyOf(db, p.workspace_id, p.host_id, p.days_ahead),
  });
}

/** An active page whose host is still an active member. */
async function publicPage(slug: string, db: Db = pool): Promise<PageRow & { host_name: string }> {
  const p = await q1<PageRow & { host_name: string }>(sql`SELECT bp.*, u.name AS host_name FROM booking_pages bp
    JOIN users u ON u.id = bp.host_id
    JOIN memberships m ON m.user_id = bp.host_id AND m.workspace_id = bp.workspace_id AND m.status = 'active'
    WHERE bp.slug = ${slug.toLowerCase()} AND bp.active`, db);
  if (!p) throw notFound('Booking page');
  return p;
}

const PAGE_FIELDS = sql`bp.id, bp.slug, bp.title, bp.description, bp.host_id, u.name AS host_name, bp.duration_minutes, bp.days, bp.start_time, bp.end_time,
  bp.min_notice_hours, bp.days_ahead, bp.video, bp.location, bp.active, bp.created_at,
  (SELECT count(*)::int FROM bookings b WHERE b.page_id = bp.id AND b.status = 'booked' AND b.starts_at > now()) AS upcoming`;
const pageOut = (r: Record<string, unknown>) => ({ ...camel(r), url: pageUrl(String(r.slug)) });

function dbFields(b: ReturnType<typeof bookingPageSchema.parse>) {
  return {
    slug: b.slug, title: b.title, description: b.description, host_id: b.hostId, duration_minutes: b.durationMinutes, days: b.days,
    start_time: b.start, end_time: b.end, min_notice_hours: b.minNoticeHours, days_ahead: b.daysAhead, video: b.video, location: b.location, active: b.active,
  };
}
const slugTaken = () => new AppError(409, 'SLUG_TAKEN', 'This link is already used. Pick another one.', { slug: 'Already used' });

export async function bookingRoutes(app: FastifyInstance) {
  // ── Team: booking pages ──
  app.get('/booking-pages', async (req) => {
    const ctx = ctxOf(req);
    const rows = await q(sql`SELECT ${PAGE_FIELDS} FROM booking_pages bp JOIN users u ON u.id = bp.host_id
      WHERE bp.workspace_id = ${ctx.workspaceId} ORDER BY bp.active DESC, bp.title, bp.id LIMIT 100`);
    return { data: rows.map(pageOut), canEdit: ctx.isAdmin };
  });

  app.post('/booking-pages', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const b = parse(bookingPageSchema, req.body);
    await assertMembers(ctx, [b.hostId]);
    const f = dbFields(b);
    const r = await q1<{ id: number }>(sql`INSERT INTO booking_pages (workspace_id, slug, title, description, host_id, duration_minutes, days, start_time, end_time,
        min_notice_hours, days_ahead, video, location, active, created_by)
      VALUES (${ctx.workspaceId}, ${f.slug}, ${f.title}, ${f.description}, ${f.host_id}, ${f.duration_minutes}, ${f.days}, ${f.start_time}, ${f.end_time},
        ${f.min_notice_hours}, ${f.days_ahead}, ${f.video}, ${f.location}, ${f.active}, ${ctx.userId})
      ON CONFLICT (slug) DO NOTHING RETURNING id`);
    if (!r) throw slugTaken();
    await audit(pool, ctx, 'booking_page', r.id, 'created', { title: f.title, slug: f.slug });
    const row = await q1(sql`SELECT ${PAGE_FIELDS} FROM booking_pages bp JOIN users u ON u.id = bp.host_id WHERE bp.id = ${r.id}`);
    return reply.code(201).send(pageOut(row!));
  });

  app.put<{ Params: { id: string } }>('/booking-pages/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const b = parse(bookingPageSchema, req.body);
    await assertMembers(ctx, [b.hostId]);
    const f = dbFields(b);
    const id = Number(req.params.id);
    if (await q1(sql`SELECT 1 FROM booking_pages WHERE slug = ${f.slug} AND id <> ${id}`)) throw slugTaken();
    const r = await q1(sql`UPDATE booking_pages SET slug = ${f.slug}, title = ${f.title}, description = ${f.description}, host_id = ${f.host_id},
        duration_minutes = ${f.duration_minutes}, days = ${f.days}, start_time = ${f.start_time}, end_time = ${f.end_time}, min_notice_hours = ${f.min_notice_hours},
        days_ahead = ${f.days_ahead}, video = ${f.video}, location = ${f.location}, active = ${f.active}
      WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} RETURNING id`);
    if (!r) throw notFound('Booking page');
    await audit(pool, ctx, 'booking_page', id, 'updated', { title: f.title, slug: f.slug, active: f.active });
    const row = await q1(sql`SELECT ${PAGE_FIELDS} FROM booking_pages bp JOIN users u ON u.id = bp.host_id WHERE bp.id = ${id}`);
    return pageOut(row!);
  });

  /** Deleting a page keeps its bookings and their meetings; only the link stops working. */
  app.delete<{ Params: { id: string } }>('/booking-pages/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const r = await q1<{ title: string }>(sql`DELETE FROM booking_pages WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} RETURNING title`);
    if (!r) throw notFound('Booking page');
    await audit(pool, ctx, 'booking_page', Number(req.params.id), 'deleted', { title: r.title });
    return noContent(reply);
  });

  /** Upcoming bookings of a page (admins and the host). */
  app.get<{ Params: { id: string } }>('/booking-pages/:id/bookings', async (req) => {
    const ctx = ctxOf(req);
    const p = await q1<{ host_id: number }>(sql`SELECT host_id FROM booking_pages WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId}`);
    if (!p || (!ctx.isAdmin && p.host_id !== ctx.userId)) throw notFound('Booking page');
    const rows = await q(sql`SELECT id, name, email, phone, note, starts_at, ends_at, status, canceled_by, activity_id, contact_id, created_at
      FROM bookings WHERE page_id = ${Number(req.params.id)} AND starts_at > now() - interval '1 day' ORDER BY starts_at LIMIT 50`);
    return { data: camelAll(rows) };
  });
}

// ───────────────────────── Public ─────────────────────────

export async function publicBookingRoutes(app: FastifyInstance) {
  const read = { config: { rateLimit: { max: config.isTest ? 1000 : 60, timeWindow: '1 minute' } } };
  const write = { config: { rateLimit: { max: config.isTest ? 1000 : 10, timeWindow: '1 minute' } } };

  /** The page and its free times. */
  app.get<{ Params: { slug: string } }>('/public/book/:slug', read, async (req) => {
    const p = await publicPage(req.params.slug);
    const w = await wsInfo(p.workspace_id);
    return {
      title: p.title, description: p.description, durationMinutes: p.duration_minutes, host: p.host_name, company: w.name, video: p.video,
      location: p.location, tz: w.tz, lang: w.lang, daysAhead: p.days_ahead, days: await slotsOf(pool, p, w.tz),
    };
  });

  /** Book a time. 409 TAKEN when the time is no longer free. */
  app.post<{ Params: { slug: string } }>('/public/book/:slug', write, async (req, reply) => {
    const body = parse(bookingCreateSchema, req.body);
    const start = new Date(body.start);
    const out = await tx(async (db) => {
      const p = await publicPage(req.params.slug, db);
      // One booking at a time per host, so two people can't take the same time.
      await q(sql`SELECT 1 FROM users WHERE id = ${p.host_id} FOR UPDATE`, db);
      const w = await wsInfo(p.workspace_id, db);
      const free = (await slotsOf(db, p, w.tz)).some((d) => d.slots.includes(start.toISOString()));
      if (!free) throw new AppError(409, 'TAKEN', ct(w.lang, 'bookTaken'));
      const email = body.email.trim().toLowerCase();
      const mine = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM bookings WHERE page_id = ${p.id} AND lower(email) = ${email} AND status = 'booked' AND starts_at > now()`, db);
      if (mine!.n >= 3) throw new AppError(429, 'TOO_MANY', 'You already have several bookings here. Cancel one first, or contact us.');
      const end = new Date(start.getTime() + p.duration_minutes * 60_000);
      const host = await q1<{ name: string; email: string }>(sql`SELECT name, email FROM users WHERE id = ${p.host_id}`, db);
      const ctx: Ctx = { ...systemCtx(p.workspace_id, p.host_id), userName: 'Online booking' };

      // The contact: the one with this email, or a new one owned by the host.
      let contactId = (await q1<{ id: number }>(sql`SELECT c.id FROM contact_methods m JOIN contacts c ON c.id = m.party_id
        WHERE m.workspace_id = ${p.workspace_id} AND m.party_type = 'contact' AND m.kind = 'email' AND m.normalized = ${email} AND c.deleted_at IS NULL
        ORDER BY c.id LIMIT 1`, db))?.id ?? null;
      if (!contactId) {
        const [first, ...rest] = body.name.split(/\s+/);
        const methods = [{ kind: 'email' as const, label: 'work', value: body.email.trim() }, ...(body.phone ? [{ kind: 'phone' as const, label: 'mobile', value: body.phone }] : [])];
        try {
          contactId = (await createContact(db, ctx, { firstName: first, lastName: rest.join(' ') || undefined, ownerId: p.host_id, methods } as never)).id as number;
        } catch {
          // e.g. a phone number in an odd format: keep the email only.
          contactId = (await createContact(db, ctx, { firstName: first, lastName: rest.join(' ') || undefined, ownerId: p.host_id, methods: methods.slice(0, 1) } as never)).id as number;
        }
      }
      const subject = `${p.title} — ${body.name}`.slice(0, 200);
      const details = [body.phone && `Phone: ${body.phone}`, `Email: ${body.email}`, body.note && `Note: ${body.note}`, `Booked online (${pageUrl(p.slug)})`].filter(Boolean).join('\n');
      const activityId = await createActivity(db, ctx, activityCreateSchema.parse({
        kind: 'meeting', subject, description: details, dueAt: start.toISOString(), durationMinutes: p.duration_minutes, assigneeId: p.host_id,
        reminderMinutesBefore: 15, location: p.location || null, links: [{ entityType: 'contact', entityId: contactId }],
      }), 'automation');
      let videoUrl: string | null = null;
      let callId: number | null = null;
      if (p.video) {
        const call = await createCall(db, p.workspace_id, p.host_id, subject, { activityId });
        await q(sql`UPDATE calls SET scheduled_for = ${end} WHERE id = ${call.id}`, db);
        videoUrl = guestUrlOf(call);
        callId = call.id;
        await q(sql`UPDATE activities SET location = ${videoUrl} WHERE id = ${activityId}`, db);
      }
      const token = randomBytes(24).toString('base64url');
      await q(sql`INSERT INTO bookings (workspace_id, page_id, host_id, activity_id, contact_id, call_id, title, starts_at, ends_at, name, email, phone, note, token_hash)
        VALUES (${p.workspace_id}, ${p.id}, ${p.host_id}, ${activityId}, ${contactId}, ${callId}, ${p.title}, ${start}, ${end}, ${body.name}, ${body.email.trim()},
          ${body.phone}, ${body.note}, ${hash(token)})`, db);
      await audit(db, ctx, 'contact', contactId, 'booked', { page: p.title, start: start.toISOString(), activityId }, 'automation');

      const when = whenText(w.lang, start, w.tz);
      const place = videoUrl ? null : p.location;
      await queueMail({
        ...bookingMail({
          to: body.email.trim(), replyTo: host?.email, subject: ct(w.lang, 'bookEmailSubject', { title: p.title, when }),
          lines: [
            ct(w.lang, 'bookEmailWhen', { when, tz: w.tz.replace(/_/g, ' '), n: p.duration_minutes }), ct(w.lang, 'bookEmailWith', { host: host?.name ?? '', company: w.name }),
            ...(place ? [ct(w.lang, 'bookEmailWhere', { place })] : []), ...(body.note ? [body.note] : []),
            ct(w.lang, 'bookEmailCalendar'), ct(w.lang, 'bookCancelLink', { url: manageUrl(token) }),
          ],
          ...(videoUrl ? { button: { label: ct(w.lang, 'bookEmailJoin'), url: videoUrl } } : {}),
          footer: w.name,
          ics: icsEvent({ uid: `booking-${hash(token).slice(0, 16)}@acme-crm`, start, end, title: `${p.title} — ${w.name}`, description: [videoUrl, manageUrl(token)].filter(Boolean).join('\n'), location: videoUrl ?? p.location }),
        }),
        fromName: await workspaceSender(p.workspace_id, db),
      }, db, { workspaceId: p.workspace_id });
      return { start: start.toISOString(), end: end.toISOString(), email: body.email.trim() };
    });
    return reply.code(201).send(out);
  });

  async function byToken(token: string, db: Db = pool, lock = false) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return q1<BookingRow>(sql`SELECT * FROM bookings WHERE token_hash = ${hash(token)} ${lock ? sql`FOR UPDATE` : sql``}`, db);
  }

  /** The customer's booking (from the link in their email). */
  app.get<{ Params: { token: string } }>('/public/bookings/:token', read, async (req) => {
    const b = await byToken(req.params.token);
    if (!b) throw notFound('Booking');
    const w = await wsInfo(b.workspace_id);
    const host = b.host_id ? await q1<{ name: string }>(sql`SELECT name FROM users WHERE id = ${b.host_id}`) : null;
    const call = b.call_id ? await q1<{ guest_token_sealed: string; status: string }>(sql`SELECT guest_token_sealed, status FROM calls WHERE id = ${b.call_id}`) : null;
    const future = new Date(b.ends_at).getTime() > Date.now();
    return {
      title: b.title, start: b.starts_at, end: b.ends_at, status: b.status, host: host?.name ?? '', company: w.name, tz: w.tz, lang: w.lang, name: b.name,
      past: !future, videoUrl: b.status === 'booked' && future && call?.status === 'open' ? guestUrlOf(call) : null,
    };
  });

  /** The customer cancels (before it starts). The host is told; the meeting and its call are canceled. */
  app.post<{ Params: { token: string } }>('/public/bookings/:token/cancel', write, async (req) => {
    await tx(async (db) => {
      const b = await byToken(req.params.token, db, true);
      if (!b) throw notFound('Booking');
      if (b.status === 'canceled') return;
      if (new Date(b.starts_at).getTime() <= Date.now()) throw conflict('This booking has already started');
      await q(sql`UPDATE bookings SET status = 'canceled', canceled_by = 'customer' WHERE id = ${b.id}`, db);
      if (b.activity_id) await q(sql`UPDATE activities SET status = 'canceled', updated_at = now() WHERE id = ${b.activity_id} AND status = 'open'`, db);
      if (b.call_id) await q(sql`UPDATE calls SET status = 'ended', ended_at = now() WHERE id = ${b.call_id} AND status = 'open' AND started_at IS NULL`, db);
      const w = await wsInfo(b.workspace_id, db);
      const ctx = systemCtx(b.workspace_id, b.host_id ?? 0);
      if (b.contact_id) await audit(db, ctx, 'contact', b.contact_id, 'booking_canceled', { title: b.title, start: new Date(b.starts_at).toISOString() }, 'system');
      if (b.host_id) {
        await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
          VALUES (${b.workspace_id}, ${b.host_id}, 'booking', ${`${b.name} canceled their booking`}, ${`${b.title} · ${whenText('en', b.starts_at, w.tz)}`},
            ${b.contact_id ? 'contact' : null}, ${b.contact_id})`, db);
      }
      const when = whenText(w.lang, b.starts_at, w.tz);
      await queueMail({
        ...bookingMail({
          to: b.email, subject: ct(w.lang, 'bookCanceledSubject', { title: b.title, when }), lines: [ct(w.lang, 'bookCanceled')], footer: w.name,
          ics: icsEvent({ uid: `booking-${hash(req.params.token).slice(0, 16)}@acme-crm`, start: new Date(b.starts_at), end: new Date(b.ends_at), title: `${b.title} — ${w.name}`, description: '', location: '', status: 'CANCELLED' }),
        }),
        fromName: await workspaceSender(b.workspace_id, db),
      }, db, { workspaceId: b.workspace_id });
    });
    return { ok: true };
  });
}
