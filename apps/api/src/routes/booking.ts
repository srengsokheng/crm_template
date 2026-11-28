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
  activityCreateSchema, bookingCreateSchema, bookingRescheduleSchema, bookingTeamCancelSchema, bookingPageSchema, bookingSlots, ct, customerDate, customerWeekday, dateIn, icsEvent, timeIn,
  type CustomerLanguage,
} from '@crm/shared';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { systemCtx, type Ctx } from '../lib/context.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { openSecret, sealSecret } from '../lib/secrets.ts';
import { ctxOf, noContent } from '../lib/http.ts';
import { bookingMail, queueMail, workspaceSender } from '../lib/mailer.ts';
import { requireAdmin } from '../lib/permissions.ts';
import { assertMembers, camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { createCall, guestUrlOf } from '../calls/calls.ts';
import { sendWaTemplate, waNumber } from '../inbox/waNotify.ts';
import type { WaTemplateSetting } from '@crm/shared';
import { createActivity } from './activities.ts';
import { createContact } from './parties.ts';
import { documentSettings } from './documents.ts';

interface PageRow {
  id: number; workspace_id: number; slug: string; title: string; description: string; host_id: number; duration_minutes: number; days: number[];
  start_time: string; end_time: string; min_notice_hours: number; days_ahead: number; video: boolean; location: string; active: boolean;
  team_ids: number[]; team_weights: number[];
  whatsapp: WaTemplateSetting | null;
}
type Host = { id: number; name: string; weight: number };
type LivePage = PageRow & { hosts: Host[] };
interface BookingRow {
  id: number; workspace_id: number; page_id: number | null; host_id: number | null; activity_id: number | null; contact_id: number | null; call_id: number | null;
  title: string; starts_at: Date; ends_at: Date; name: string; email: string; status: 'booked' | 'canceled'; reschedules?: number;
  token_hash: string; token_sealed: string | null; ics_sequence: number; phone?: string;
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
async function busyOf(db: Db, workspaceId: number, hostId: number, daysAhead: number, exceptActivityId: number | null = null) {
  const rows = await q<{ s: Date; e: Date }>(sql`SELECT due_at AS s, due_at + make_interval(mins => coalesce(nullif(duration_minutes, 0), 30)) AS e
    FROM activities WHERE workspace_id = ${workspaceId} AND assignee_id = ${hostId} AND deleted_at IS NULL AND status = 'open'
      AND kind IN ('meeting', 'call') AND due_at IS NOT NULL
      AND due_at < now() + make_interval(days => ${daysAhead + 2}) AND due_at > now() - interval '1 day'
      ${exceptActivityId ? sql`AND id <> ${exceptActivityId}` : sql``}`, db);
  return rows.map((r) => ({ start: new Date(r.s).getTime(), end: new Date(r.e).getTime() }));
}

/** Free times per person, and all times when at least one of them is free. */
async function slotsByHost(db: Db, p: PageRow, tz: string, hostIds: number[], now = new Date(), exceptActivityId: number | null = null) {
  const byHost = new Map<number, Set<string>>();
  const days = new Map<string, Set<string>>();
  for (const h of hostIds) {
    const d = bookingSlots({
      hours: { days: p.days, start: p.start_time, end: p.end_time }, duration: p.duration_minutes, tz, now,
      minNoticeHours: p.min_notice_hours, daysAhead: p.days_ahead, busy: await busyOf(db, p.workspace_id, h, p.days_ahead, exceptActivityId),
    });
    byHost.set(h, new Set(d.flatMap((x) => x.slots)));
    for (const x of d) { const set = days.get(x.date) ?? new Set<string>(); x.slots.forEach((v) => set.add(v)); days.set(x.date, set); }
  }
  return { byHost, days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, s]) => ({ date, slots: [...s].sort() })) };
}
async function slotsOf(db: Db, p: LivePage, tz: string, now = new Date(), exceptActivityId: number | null = null, hostIds = p.hosts.map((h) => h.id)) {
  return (await slotsByHost(db, p, tz, hostIds, now, exceptActivityId)).days;
}

/** The people a page books with: the team (round-robin) or the one host. */
const hostIdsOf = (p: { host_id: number; team_ids: number[] | null }) => (p.team_ids?.length ? p.team_ids.map(Number) : [Number(p.host_id)]);

/**
 * Who of the free people gets the next booking of a shared page. Everyone has a share (weight 1–10): the person furthest
 * below their share of this page's bookings in the last 30 days (booked, not canceled) goes first — with equal shares
 * that is plain turn-taking. Ties: whoever went longest without a booking from the page (never = first), then the page's
 * order. Counting only 30 days means someone just added catches up for a while instead of getting every booking.
 */
async function nextHost(db: Db, pageId: number, free: Host[]): Promise<number> {
  const rows = await q<{ host_id: number; n: number; at: Date }>(sql`SELECT host_id,
      count(*) FILTER (WHERE status = 'booked' AND created_at > now() - interval '30 days')::int AS n, max(created_at) AS at
    FROM bookings WHERE page_id = ${pageId} AND host_id = ANY(${free.map((h) => h.id)}) GROUP BY host_id`, db);
  const stat = new Map(rows.map((r) => [Number(r.host_id), { n: r.n, at: new Date(r.at).getTime() }]));
  const load = (h: Host) => (stat.get(h.id)?.n ?? 0) / h.weight;
  const last = (h: Host) => stat.get(h.id)?.at ?? -Infinity;
  return [...free].sort((a, b) => load(a) - load(b) || last(a) - last(b))[0].id;
}

/** An active page with the people on it who are still active members (none left: the page is closed). */
async function publicPage(slug: string, db: Db = pool): Promise<LivePage> {
  const p = await q1<PageRow>(sql`SELECT * FROM booking_pages WHERE slug = ${slug.toLowerCase()} AND active`, db);
  if (!p) throw notFound('Booking page');
  const ids = hostIdsOf(p);
  const hosts = await q<Omit<Host, 'weight'>>(sql`SELECT u.id, u.name FROM users u
    JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ${p.workspace_id} AND m.status = 'active'
    WHERE u.id = ANY(${ids}) ORDER BY array_position(${ids}::bigint[], u.id)`, db);
  if (!hosts.length) throw notFound('Booking page');
  const weights = new Map((p.team_ids ?? []).map((id, i) => [Number(id), Number(p.team_weights?.[i] ?? 1)]));
  return { ...p, hosts: hosts.map((h) => ({ ...h, weight: weights.get(h.id) ?? 1 })) };
}

const PAGE_FIELDS = sql`bp.id, bp.slug, bp.title, bp.description, bp.host_id,
  coalesce((SELECT string_agg(x.name, ', ' ORDER BY array_position(bp.team_ids, x.id)) FROM users x WHERE x.id = ANY(bp.team_ids)), u.name) AS host_name,
  CASE WHEN cardinality(bp.team_ids) > 0 THEN bp.team_ids ELSE ARRAY[bp.host_id] END AS host_ids,
  CASE WHEN cardinality(bp.team_weights) > 0 THEN bp.team_weights ELSE array_fill(1, ARRAY[greatest(cardinality(bp.team_ids), 1)]) END AS host_weights, bp.duration_minutes, bp.days, bp.start_time, bp.end_time,
  bp.min_notice_hours, bp.days_ahead, bp.video, bp.location, bp.active, bp.whatsapp, bp.created_at,
  (SELECT count(*)::int FROM bookings b WHERE b.page_id = bp.id AND b.status = 'booked' AND b.starts_at > now()) AS upcoming`;
const pageOut = (r: Record<string, unknown>) => ({ ...camel(r), url: pageUrl(String(r.slug)) });

function dbFields(b: ReturnType<typeof bookingPageSchema.parse>) {
  return {
    slug: b.slug, title: b.title, description: b.description, host_id: b.hostIds[0], team_ids: b.hostIds.length > 1 ? b.hostIds : [],
    team_weights: b.hostIds.length > 1 && b.hostWeights.some((w) => w !== 1) ? b.hostWeights : [],
    whatsapp: b.whatsapp?.channelId ? JSON.stringify(b.whatsapp) : null, duration_minutes: b.durationMinutes, days: b.days,
    start_time: b.start, end_time: b.end, min_notice_hours: b.minNoticeHours, days_ahead: b.daysAhead, video: b.video, location: b.location, active: b.active,
  };
}
const slugTaken = () => new AppError(409, 'SLUG_TAKEN', 'This link is already used. Pick another one.', { slug: 'Already used' });

/** The customer's confirmation (or "moved") email with the calendar file; `sequence` > 0 updates the calendar entry. */
async function confirmationMail(db: Db, o: {
  workspaceId: number; to: string; title: string; start: Date; end: Date; durationMinutes: number; tokenHash: string; manage: string | null;
  videoUrl: string | null; place: string; note: string; host: { name: string; email: string } | null; sequence: number; moved: boolean; movedBy?: string | null;
}) {
  const w = await wsInfo(o.workspaceId, db);
  const when = whenText(w.lang, o.start, w.tz);
  const place = o.videoUrl ? null : o.place;
  await queueMail({
    ...bookingMail({
      to: o.to, replyTo: o.host?.email, subject: ct(w.lang, o.moved ? 'bookMovedSubject' : 'bookEmailSubject', { title: o.title, when }),
      lines: [
        ...(o.moved ? [o.movedBy ? ct(w.lang, 'bookMovedByTeam', { name: o.movedBy }) : ct(w.lang, 'bookMovedLine')] : []),
        ct(w.lang, 'bookEmailWhen', { when, tz: w.tz.replace(/_/g, ' '), n: o.durationMinutes }), ct(w.lang, 'bookEmailWith', { host: o.host?.name ?? '', company: w.name }),
        ...(place ? [ct(w.lang, 'bookEmailWhere', { place })] : []), ...(o.note ? [o.note] : []),
        ct(w.lang, 'bookEmailCalendar'), ...(o.manage ? [ct(w.lang, 'bookCancelLink', { url: o.manage })] : []),
      ],
      ...(o.videoUrl ? { button: { label: ct(w.lang, 'bookEmailJoin'), url: o.videoUrl } } : {}),
      footer: w.name,
      ics: icsEvent({ uid: icsUid(o.tokenHash), start: o.start, end: o.end, title: `${o.title} — ${w.name}`,
        description: [o.videoUrl, o.manage].filter(Boolean).join('\n'), location: o.videoUrl ?? o.place, sequence: o.sequence }),
    }),
    fromName: await workspaceSender(o.workspaceId, db),
  }, db, { workspaceId: o.workspaceId });
}

/** How many times a customer may move one booking. */
const MAX_MOVES = 3;
/** One calendar entry per booking: the same UID in every file sent about it. */
const icsUid = (tokenHash: string) => `booking-${tokenHash.slice(0, 16)}@acme-crm`;
/** The customer's link to their booking (null for bookings made before links were kept). */
const manageLinkOf = (b: BookingRow, token?: string) => (token ? manageUrl(token) : b.token_sealed ? manageUrl(openSecret(b.token_sealed)) : null);

type Actor = { kind: 'customer'; token: string } | { kind: 'team'; ctx: Ctx };

/**
 * Moves a booking: the booking, the host's meeting (and its reminder) and the video call; the host is told (unless they
 * moved it themselves), the contact's timeline notes it, and the customer gets an updated calendar file.
 */
async function moveBooking(db: Db, b: BookingRow, start: Date, durationMinutes: number, place: string, by: Actor) {
  const w = await wsInfo(b.workspace_id, db);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const from = new Date(b.starts_at);
  const seq = (b.ics_sequence ?? 0) + 1;
  await q(sql`UPDATE bookings SET starts_at = ${start}, ends_at = ${end}, ics_sequence = ${seq},
    reschedules = reschedules + ${by.kind === 'customer' ? 1 : 0} WHERE id = ${b.id}`, db);
  if (b.activity_id) {
    await q(sql`UPDATE activities SET due_at = ${start}, duration_minutes = ${durationMinutes}, reminder_at = ${new Date(start.getTime() - 15 * 60_000)},
      reminded_at = NULL, status = 'open', updated_at = now(), version = version + 1 WHERE id = ${b.activity_id}`, db);
  }
  const call = b.call_id ? await q1<{ guest_token_sealed: string; status: string }>(sql`UPDATE calls SET scheduled_for = ${end} WHERE id = ${b.call_id} RETURNING guest_token_sealed, status`, db) : null;
  const moved = { title: b.title, from: from.toISOString(), to: start.toISOString() };
  if (b.contact_id) {
    if (by.kind === 'team') await audit(db, by.ctx, 'contact', b.contact_id, 'booking_moved', { ...moved, by: 'team' });
    else await audit(db, systemCtx(b.workspace_id, b.host_id ?? 0), 'contact', b.contact_id, 'booking_moved', moved, 'system');
  }
  if (b.host_id && !(by.kind === 'team' && by.ctx.userId === b.host_id)) {
    const who = by.kind === 'team' ? `${by.ctx.userName} moved ${b.name}’s booking` : `${b.name} moved their booking`;
    await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
      VALUES (${b.workspace_id}, ${b.host_id}, 'booking', ${who}, ${`${b.title} · ${whenText('en', from, w.tz)} → ${whenText('en', start, w.tz)}`},
        ${b.contact_id ? 'contact' : null}, ${b.contact_id})`, db);
  }
  const host = b.host_id ? await q1<{ name: string; email: string }>(sql`SELECT name, email FROM users WHERE id = ${b.host_id}`, db) : null;
  const pg = b.page_id ? await q1<{ whatsapp: WaTemplateSetting | null }>(sql`SELECT whatsapp FROM booking_pages WHERE id = ${b.page_id}`, db) : null;
  const manage = manageLinkOf(b, by.kind === 'customer' ? by.token : undefined);
  await sendWaTemplate(db, { workspaceId: b.workspace_id, setting: pg?.whatsapp, contactIds: b.contact_id ? [Number(b.contact_id)] : [], onlyPhones: true,
    extraPhones: by.kind === 'team' ? (b.phone ? [b.phone] : []) : await bookingWaPhones(db, b.workspace_id, b.phone),
    values: { name: b.name, title: b.title, when: whenText(w.lang, start, w.tz), link: manage ?? '', company: w.name },
    senderName: by.kind === 'team' ? by.ctx.userName : w.name, authorId: by.kind === 'team' ? by.ctx.userId : null, title: b.name });
  await confirmationMail(db, { workspaceId: b.workspace_id, to: b.email, title: b.title, start, end, durationMinutes, tokenHash: b.token_hash,
    manage: manageLinkOf(b, by.kind === 'customer' ? by.token : undefined), videoUrl: call?.status === 'open' ? guestUrlOf(call) : null, place, note: '',
    host: host ?? null, sequence: seq, moved: true, movedBy: by.kind === 'team' ? by.ctx.userName : null });
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Cancels a booking: its meeting and call too; the host is told (unless they did it), the customer gets a cancellation file. */
async function cancelBooking(db: Db, b: BookingRow, by: Actor, reason = '') {
  const seq = (b.ics_sequence ?? 0) + 1;
  await q(sql`UPDATE bookings SET status = 'canceled', canceled_by = ${by.kind}, ics_sequence = ${seq} WHERE id = ${b.id}`, db);
  if (b.activity_id) await q(sql`UPDATE activities SET status = 'canceled', updated_at = now() WHERE id = ${b.activity_id} AND status = 'open'`, db);
  if (b.call_id) await q(sql`UPDATE calls SET status = 'ended', ended_at = now() WHERE id = ${b.call_id} AND status = 'open' AND started_at IS NULL`, db);
  const w = await wsInfo(b.workspace_id, db);
  const what = { title: b.title, start: new Date(b.starts_at).toISOString() };
  if (b.contact_id) {
    if (by.kind === 'team') await audit(db, by.ctx, 'contact', b.contact_id, 'booking_canceled', { ...what, by: 'team', reason: reason || null });
    else await audit(db, systemCtx(b.workspace_id, b.host_id ?? 0), 'contact', b.contact_id, 'booking_canceled', what, 'system');
  }
  if (b.host_id && !(by.kind === 'team' && by.ctx.userId === b.host_id)) {
    const who = by.kind === 'team' ? `${by.ctx.userName} canceled ${b.name}’s booking` : `${b.name} canceled their booking`;
    await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
      VALUES (${b.workspace_id}, ${b.host_id}, 'booking', ${who}, ${`${b.title} · ${whenText('en', b.starts_at, w.tz)}`},
        ${b.contact_id ? 'contact' : null}, ${b.contact_id})`, db);
  }
  const when = whenText(w.lang, b.starts_at, w.tz);
  const host = b.host_id ? await q1<{ email: string }>(sql`SELECT email FROM users WHERE id = ${b.host_id}`, db) : null;
  await queueMail({
    ...bookingMail({
      to: b.email, replyTo: host?.email, subject: ct(w.lang, 'bookCanceledSubject', { title: b.title, when }),
      lines: [by.kind === 'team' ? ct(w.lang, 'bookCanceledByTeam', { name: by.ctx.userName }) : ct(w.lang, 'bookCanceled'), ...(reason ? [reason] : [])],
      footer: w.name,
      ics: icsEvent({ uid: icsUid(b.token_hash), start: new Date(b.starts_at), end: new Date(b.ends_at), title: `${b.title} — ${w.name}`, description: '', location: '', status: 'CANCELLED', sequence: seq }),
    }),
    fromName: await workspaceSender(b.workspace_id, db),
  }, db, { workspaceId: b.workspace_id });
}

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
    await assertMembers(ctx, b.hostIds);
    const f = dbFields(b);
    const r = await q1<{ id: number }>(sql`INSERT INTO booking_pages (workspace_id, slug, title, description, host_id, team_ids, team_weights, whatsapp, duration_minutes, days, start_time, end_time,
        min_notice_hours, days_ahead, video, location, active, created_by)
      VALUES (${ctx.workspaceId}, ${f.slug}, ${f.title}, ${f.description}, ${f.host_id}, ${f.team_ids}::bigint[], ${f.team_weights}::int[], ${f.whatsapp}::jsonb, ${f.duration_minutes}, ${f.days}, ${f.start_time}, ${f.end_time},
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
    await assertMembers(ctx, b.hostIds);
    const f = dbFields(b);
    const id = Number(req.params.id);
    if (await q1(sql`SELECT 1 FROM booking_pages WHERE slug = ${f.slug} AND id <> ${id}`)) throw slugTaken();
    const r = await q1(sql`UPDATE booking_pages SET slug = ${f.slug}, title = ${f.title}, description = ${f.description}, host_id = ${f.host_id}, team_ids = ${f.team_ids}::bigint[], team_weights = ${f.team_weights}::int[], whatsapp = ${f.whatsapp}::jsonb,
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

  /** Upcoming bookings of a page (admins and the people on it), with who each one is with. */
  app.get<{ Params: { id: string } }>('/booking-pages/:id/bookings', async (req) => {
    const ctx = ctxOf(req);
    const p = await q1<{ host_id: number; team_ids: number[] }>(sql`SELECT host_id, team_ids FROM booking_pages WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId}`);
    if (!p || (!ctx.isAdmin && !hostIdsOf(p).includes(ctx.userId))) throw notFound('Booking page');
    const rows = await q(sql`SELECT b.id, b.name, b.email, b.phone, b.note, b.starts_at, b.ends_at, b.status, b.canceled_by, b.activity_id, b.contact_id, b.created_at,
        b.host_id, u.name AS host_name
      FROM bookings b LEFT JOIN users u ON u.id = b.host_id
      WHERE b.page_id = ${Number(req.params.id)} AND b.starts_at > now() - interval '1 day' ORDER BY b.starts_at LIMIT 50`);
    return { data: camelAll(rows) };
  });

  /** A booking the team member may change: admins, and the host of that booking. */
  async function teamBooking(db: Db, ctx: Ctx, id: number) {
    const b = await q1<BookingRow>(sql`SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} FOR UPDATE`, db);
    if (!b || (!ctx.isAdmin && b.host_id !== ctx.userId)) throw notFound('Booking');
    if (b.status !== 'booked') throw conflict('This booking was canceled');
    if (new Date(b.ends_at).getTime() <= Date.now()) throw conflict('This booking is over');
    return b;
  }

  /**
   * The team moves a booking (e.g. agreed with the customer by phone): any future time, also outside the page's hours,
   * as long as the host is free then. The customer is emailed the new time and calendar file.
   */
  app.post<{ Params: { id: string } }>('/bookings/:id/reschedule', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(bookingRescheduleSchema, req.body);
    const start = new Date(body.start);
    if (start.getTime() <= Date.now()) throw badRequest('Pick a time in the future', { start: 'Pick a time in the future' });
    return tx(async (db) => {
      const b = await teamBooking(db, ctx, Number(req.params.id));
      if (start.getTime() === new Date(b.starts_at).getTime()) throw badRequest('That’s the time it already has', { start: 'Pick a different time' });
      const page = b.page_id ? await q1<{ duration_minutes: number; location: string }>(sql`SELECT duration_minutes, location FROM booking_pages WHERE id = ${b.page_id}`, db) : null;
      const minutes = page?.duration_minutes ?? Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60_000);
      const end = start.getTime() + minutes * 60_000;
      if (b.host_id) {
        await q(sql`SELECT 1 FROM users WHERE id = ${b.host_id} FOR UPDATE`, db);
        const busy = await busyOf(db, b.workspace_id, b.host_id, 400, b.activity_id);
        if (busy.some((x) => start.getTime() < x.end && end > x.start)) {
          throw new AppError(409, 'BUSY', 'The person already has a meeting or call at that time. Pick another time.', { start: 'Busy then' });
        }
      }
      return moveBooking(db, b, start, minutes, page?.location ?? '', { kind: 'team', ctx });
    });
  });

  /** The team cancels a booking; the reason (optional) goes to the customer. */
  app.post<{ Params: { id: string } }>('/bookings/:id/cancel', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(bookingTeamCancelSchema, req.body ?? {});
    await tx(async (db) => {
      const b = await teamBooking(db, ctx, Number(req.params.id));
      await cancelBooking(db, b, { kind: 'team', ctx }, body.reason);
    });
    return { ok: true };
  });
}

// ───────────────────────── Public ─────────────────────────

/** Most booking WhatsApp messages one number gets a day, and one workspace sends a day (each one costs money). */
export const BOOKING_WA_PER_NUMBER = 3;
export const BOOKING_WA_PER_WORKSPACE = 100;

/**
 * The number to send a booking's WhatsApp message to: the one typed on the booking form, and only while it and the
 * workspace are under the daily limits. Anyone can book, so without them a page could be used to send paid messages to
 * any number. Never the saved numbers of a contact matched by email (anyone can type someone else's email).
 */
async function bookingWaPhones(db: Db, workspaceId: number, phone: string | null | undefined): Promise<string[]> {
  const n = phone ? waNumber(phone) : null;
  if (!n) return [];
  const sent = await q1<{ to_number: number; workspace: number }>(sql`SELECT
      (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN channels ch ON ch.id = c.channel_id
        WHERE m.workspace_id = ${workspaceId} AND ch.kind = 'whatsapp' AND c.external_id = ${n} AND m.direction = 'out' AND m.template IS NOT NULL
          AND m.author_id IS NULL AND m.created_at > now() - interval '1 day') AS to_number,
      (SELECT count(*)::int FROM bookings WHERE workspace_id = ${workspaceId} AND phone IS NOT NULL AND created_at > now() - interval '1 day') AS workspace`, db);
  if ((sent?.to_number ?? 0) >= BOOKING_WA_PER_NUMBER || (sent?.workspace ?? 0) > BOOKING_WA_PER_WORKSPACE) return [];
  return [phone!];
}

export async function publicBookingRoutes(app: FastifyInstance) {
  const read = { config: { rateLimit: { max: config.isTest ? 1000 : 60, timeWindow: '1 minute' } } };
  const write = { config: { rateLimit: { max: config.isTest ? 1000 : 10, timeWindow: '1 minute' } } };

  /** The page and its free times. */
  app.get<{ Params: { slug: string } }>('/public/book/:slug', read, async (req) => {
    const p = await publicPage(req.params.slug);
    const w = await wsInfo(p.workspace_id);
    return {
      title: p.title, description: p.description, durationMinutes: p.duration_minutes, host: p.hosts.length > 1 ? w.name : p.hosts[0].name, team: p.hosts.length > 1,
      company: w.name, video: p.video,
      location: p.location, tz: w.tz, lang: w.lang, daysAhead: p.days_ahead, days: await slotsOf(pool, p, w.tz),
    };
  });

  /** Book a time. 409 TAKEN when the time is no longer free. */
  app.post<{ Params: { slug: string } }>('/public/book/:slug', write, async (req, reply) => {
    const body = parse(bookingCreateSchema, req.body);
    const start = new Date(body.start);
    const out = await tx(async (db) => {
      const p = await publicPage(req.params.slug, db);
      // One booking at a time per person (locked in id order: no deadlocks), so nobody gets the same time twice.
      await q(sql`SELECT 1 FROM users WHERE id = ANY(${p.hosts.map((h) => h.id)}) ORDER BY id FOR UPDATE`, db);
      const w = await wsInfo(p.workspace_id, db);
      const { byHost } = await slotsByHost(db, p, w.tz, p.hosts.map((h) => h.id));
      const free = p.hosts.filter((h) => byHost.get(h.id)?.has(start.toISOString()));
      if (!free.length) throw new AppError(409, 'TAKEN', ct(w.lang, 'bookTaken'));
      const hostId = await nextHost(db, p.id, free);
      const email = body.email.trim().toLowerCase();
      const mine = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM bookings WHERE page_id = ${p.id} AND lower(email) = ${email} AND status = 'booked' AND starts_at > now()`, db);
      if (mine!.n >= 3) throw new AppError(429, 'TOO_MANY', 'You already have several bookings here. Cancel one first, or contact us.');
      const end = new Date(start.getTime() + p.duration_minutes * 60_000);
      const host = await q1<{ name: string; email: string }>(sql`SELECT name, email FROM users WHERE id = ${hostId}`, db);
      const ctx: Ctx = { ...systemCtx(p.workspace_id, hostId), userName: 'Online booking' };

      // The contact: the one with this email, or a new one owned by the host.
      let contactId = (await q1<{ id: number }>(sql`SELECT c.id FROM contact_methods m JOIN contacts c ON c.id = m.party_id
        WHERE m.workspace_id = ${p.workspace_id} AND m.party_type = 'contact' AND m.kind = 'email' AND m.normalized = ${email} AND c.deleted_at IS NULL
        ORDER BY c.id LIMIT 1`, db))?.id ?? null;
      if (!contactId) {
        const [first, ...rest] = body.name.split(/\s+/);
        const methods = [{ kind: 'email' as const, label: 'work', value: body.email.trim() }, ...(body.phone ? [{ kind: 'phone' as const, label: 'mobile', value: body.phone }] : [])];
        try {
          contactId = (await createContact(db, ctx, { firstName: first, lastName: rest.join(' ') || undefined, ownerId: hostId, methods } as never)).id as number;
        } catch {
          // e.g. a phone number in an odd format: keep the email only.
          contactId = (await createContact(db, ctx, { firstName: first, lastName: rest.join(' ') || undefined, ownerId: hostId, methods: methods.slice(0, 1) } as never)).id as number;
        }
      }
      const subject = `${p.title} — ${body.name}`.slice(0, 200);
      const details = [body.phone && `Phone: ${body.phone}`, `Email: ${body.email}`, body.note && `Note: ${body.note}`, `Booked online (${pageUrl(p.slug)})`].filter(Boolean).join('\n');
      const activityId = await createActivity(db, ctx, activityCreateSchema.parse({
        kind: 'meeting', subject, description: details, dueAt: start.toISOString(), durationMinutes: p.duration_minutes, assigneeId: hostId,
        reminderMinutesBefore: 15, location: p.location || null, links: [{ entityType: 'contact', entityId: contactId }],
      }), 'automation');
      let videoUrl: string | null = null;
      let callId: number | null = null;
      if (p.video) {
        const call = await createCall(db, p.workspace_id, hostId, subject, { activityId });
        await q(sql`UPDATE calls SET scheduled_for = ${end} WHERE id = ${call.id}`, db);
        videoUrl = guestUrlOf(call);
        callId = call.id;
        await q(sql`UPDATE activities SET location = ${videoUrl} WHERE id = ${activityId}`, db);
      }
      const token = randomBytes(24).toString('base64url');
      await q(sql`INSERT INTO bookings (workspace_id, page_id, host_id, activity_id, contact_id, call_id, title, starts_at, ends_at, name, email, phone, note, token_hash, token_sealed)
        VALUES (${p.workspace_id}, ${p.id}, ${hostId}, ${activityId}, ${contactId}, ${callId}, ${p.title}, ${start}, ${end}, ${body.name}, ${body.email.trim()},
          ${body.phone}, ${body.note}, ${hash(token)}, ${sealSecret(token)})`, db);
      await audit(db, ctx, 'contact', contactId, 'booked', { page: p.title, start: start.toISOString(), activityId }, 'automation');

      await confirmationMail(db, { workspaceId: p.workspace_id, to: body.email.trim(), title: p.title, start, end, durationMinutes: p.duration_minutes,
        tokenHash: hash(token), manage: manageUrl(token), videoUrl, place: p.location, note: body.note, host: host ?? null, sequence: 0, moved: false });
      await sendWaTemplate(db, { workspaceId: p.workspace_id, setting: p.whatsapp, contactIds: [contactId], onlyPhones: true, extraPhones: await bookingWaPhones(db, p.workspace_id, body.phone),
        values: { name: body.name, title: p.title, when: whenText(w.lang, start, w.tz), link: manageUrl(token), company: w.name }, senderName: w.name, title: body.name });
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
    const page = b.page_id ? await movablePage(b) : null;
    return {
      canReschedule: !!page && b.status === 'booked' && new Date(b.starts_at).getTime() > Date.now() && (b.reschedules ?? 0) < MAX_MOVES,
      title: b.title, start: b.starts_at, end: b.ends_at, status: b.status, host: host?.name ?? '', company: w.name, tz: w.tz, lang: w.lang, name: b.name,
      past: !future, videoUrl: b.status === 'booked' && future && call?.status === 'open' ? guestUrlOf(call) : null,
    };
  });

  /** The booking's page, when moving is still possible there (page on, and its person still on the page and a member). */
  async function movablePage(b: BookingRow, db: Db = pool) {
    const p = await q1<{ slug: string }>(sql`SELECT slug FROM booking_pages WHERE id = ${b.page_id}`, db);
    if (!p) return null;
    const live = await publicPage(p.slug, db).catch(() => null);
    return live && b.host_id && live.hosts.some((h) => h.id === Number(b.host_id)) ? live : null;
  }

  /** Free times to move to (the booking's own time doesn't block nearby ones). */
  app.get<{ Params: { token: string } }>('/public/bookings/:token/slots', read, async (req) => {
    const b = await byToken(req.params.token);
    if (!b) throw notFound('Booking');
    const p = await movablePage(b);
    if (!p || b.status !== 'booked') throw conflict('This booking can’t be moved. Cancel it and book again, or contact us.');
    const w = await wsInfo(b.workspace_id);
    const days = (await slotsOf(pool, p, w.tz, new Date(), b.activity_id, [Number(b.host_id)])).map((d) => ({ ...d, slots: d.slots.filter((s) => s !== new Date(b.starts_at).toISOString()) })).filter((d) => d.slots.length);
    return { tz: w.tz, lang: w.lang, durationMinutes: p.duration_minutes, daysAhead: p.days_ahead, days };
  });

  /** Move the booking: meeting, its reminder and video call follow; the host is told; a new calendar file is sent. */
  app.post<{ Params: { token: string } }>('/public/bookings/:token/reschedule', write, async (req) => {
    const body = parse(bookingRescheduleSchema, req.body);
    const start = new Date(body.start);
    return tx(async (db) => {
      const b = await byToken(req.params.token, db, true);
      if (!b) throw notFound('Booking');
      if (b.status !== 'booked') throw conflict('This booking was canceled');
      if (new Date(b.starts_at).getTime() <= Date.now()) throw conflict('This booking has already started');
      if ((b.reschedules ?? 0) >= MAX_MOVES) throw new AppError(409, 'TOO_MANY_MOVES', 'This booking was moved several times already. Please contact us to change it.');
      const p = await movablePage(b, db);
      if (!p) throw conflict('This booking can’t be moved. Cancel it and book again, or contact us.');
      await q(sql`SELECT 1 FROM users WHERE id = ${b.host_id} FOR UPDATE`, db);
      const w = await wsInfo(b.workspace_id, db);
      const free = start.toISOString() !== new Date(b.starts_at).toISOString()
        && (await slotsOf(db, p, w.tz, new Date(), b.activity_id, [Number(b.host_id)])).some((d) => d.slots.includes(start.toISOString()));
      if (!free) throw new AppError(409, 'TAKEN', ct(w.lang, 'bookTaken'));
      return moveBooking(db, b, start, p.duration_minutes, p.location, { kind: 'customer', token: req.params.token });
    });
  });

  /** The customer cancels (before it starts). The host is told; the meeting and its call are canceled. */
  app.post<{ Params: { token: string } }>('/public/bookings/:token/cancel', write, async (req) => {
    await tx(async (db) => {
      const b = await byToken(req.params.token, db, true);
      if (!b) throw notFound('Booking');
      if (b.status === 'canceled') return;
      if (new Date(b.starts_at).getTime() <= Date.now()) throw conflict('This booking has already started');
      await cancelBooking(db, b, { kind: 'customer', token: req.params.token });
    });
    return { ok: true };
  });
}
