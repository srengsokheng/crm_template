import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const pub = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
  const r = await (await getApp()).inject({ method, url: `/api/v1/public${url}`, ...(body !== undefined ? { payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
};
/** A meeting as stored (there is no single-activity endpoint; the list and timeline show them). */
const actOf = async (id: number) => (await pool.query(`SELECT kind, subject, description, location, status, due_at AS "dueAt",
  duration_minutes AS "durationMinutes", assignee_id::int AS "assigneeId" FROM activities WHERE id = $1`, [id])).rows[0];
let n = 0;
const slug = () => `demo-${Date.now().toString(36)}-${n++}`;
const allDays = [1, 2, 3, 4, 5, 6, 7];

async function page(c: any, hostId: number, extra: Record<string, unknown> = {}) {
  const r = await c.post('/booking-pages', { title: 'Showroom visit', slug: slug(), hostId, durationMinutes: 30, days: allDays, start: '00:00', end: '23:30', minNoticeHours: 1, daysAhead: 3, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe('online booking', () => {
  it('admins set up pages; the link is unique; anyone in the workspace sees them; other workspaces don’t', async () => {
    const { c, me } = await signup(); const user = me.user;
    expect((await c.post('/booking-pages', { title: 'X', slug: 'Bad slug!', hostId: user.id, durationMinutes: 30, days: [1] })).status).toBe(400);
    expect((await c.post('/booking-pages', { title: 'X', slug: slug(), hostId: user.id, durationMinutes: 25, days: [1] })).status).toBe(400);
    expect((await c.post('/booking-pages', { title: 'X', slug: slug(), hostId: user.id, durationMinutes: 30, days: [1], start: '17:00', end: '09:00' })).status).toBe(400);
    const p = await page(c, user.id);
    expect(p).toMatchObject({ title: 'Showroom visit', hostId: user.id, durationMinutes: 30, video: true, active: true, upcoming: 0 });
    expect(p.url).toMatch(new RegExp(`/book/${p.slug}$`));
    const dup = await c.post('/booking-pages', { title: 'Y', slug: p.slug, hostId: user.id, durationMinutes: 30, days: [1] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.fields.slug).toBeTruthy();

    const { c: rep } = await inviteUser(c, 'Sales rep');
    expect((await rep.get('/booking-pages')).body).toMatchObject({ canEdit: false, data: [{ id: p.id }] });
    expect((await rep.post('/booking-pages', { title: 'X', slug: slug(), hostId: user.id, durationMinutes: 30, days: [1] })).status).toBe(403);
    expect((await rep.put(`/booking-pages/${p.id}`, { ...p, hostId: user.id })).status).toBe(403);
    expect((await rep.del(`/booking-pages/${p.id}`)).status).toBe(403);
    const other = await signup();
    expect((await other.c.get('/booking-pages')).body.data).toEqual([]);
    expect((await other.c.put(`/booking-pages/${p.id}`, { title: 'X', slug: slug(), hostId: other.me.user.id, durationMinutes: 30, days: [1] })).status).toBe(404);
    expect((await other.c.del(`/booking-pages/${p.id}`)).status).toBe(404);
    // The host must be in the workspace.
    expect((await c.post('/booking-pages', { title: 'X', slug: slug(), hostId: other.me.user.id, durationMinutes: 30, days: [1] })).status).toBe(400);
  });

  it('a customer books: contact, meeting with a video call, email with calendar file; the time is gone; cancel', async () => {
    const { c, me } = await signup(); const user = me.user;
    const p = await page(c, user.id);
    const info = await pub('GET', `/book/${p.slug}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ title: 'Showroom visit', durationMinutes: 30, video: true, lang: 'en', tz: 'UTC' });
    const slot = info.body.days[0].slots[0];
    // Existing busy meeting of the host blocks its time.
    const busySlot = info.body.days[0].slots[2];
    await c.post('/activities', { kind: 'meeting', subject: 'Busy', dueAt: busySlot, durationMinutes: 30, assigneeId: user.id });
    expect((await pub('GET', `/book/${p.slug}`)).body.days[0].slots).not.toContain(busySlot);

    expect((await pub('POST', `/book/${p.slug}`, { start: slot, name: 'Dara Sok', email: 'bad' })).status).toBe(400);
    const before = (await pool.query(`SELECT coalesce(max(id), 0) AS id FROM jobs`)).rows[0].id;
    const b = await pub('POST', `/book/${p.slug}`, { start: slot, name: 'Dara Sok', email: 'Dara@Example-Customer.test', phone: '+855 12 345 678', note: 'Interested in the X2 arm' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body).toMatchObject({ start: slot });
    // The same time again: taken.
    const again = await pub('POST', `/book/${p.slug}`, { start: slot, name: 'Bo', email: 'bo@example.test' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TAKEN');
    expect((await pub('GET', `/book/${p.slug}`)).body.days[0].slots).not.toContain(slot);
    // A time that isn't offered (not on the grid).
    expect((await pub('POST', `/book/${p.slug}`, { start: new Date(Date.parse(slot) + 7 * 60_000).toISOString(), name: 'Bo', email: 'bo@example.test' })).status).toBe(409);

    // Contact and meeting for the host, linked; video call with a guest link.
    const bk = (await pool.query(`SELECT * FROM bookings WHERE page_id = $1`, [p.id])).rows[0];
    const contact = (await c.get(`/contacts/${bk.contact_id}`)).body;
    expect(contact).toMatchObject({ firstName: 'Dara', lastName: 'Sok', ownerId: user.id });
    expect(contact.methods.map((m: any) => m.value)).toEqual(expect.arrayContaining(['Dara@Example-Customer.test', '+855 12 345 678']));
    const act = (await actOf(bk.activity_id));
    expect(act).toMatchObject({ kind: 'meeting', subject: 'Showroom visit — Dara Sok', durationMinutes: 30, assigneeId: user.id, status: 'open' });
    expect(new Date(act.dueAt).toISOString()).toBe(slot);
    expect(act.location).toMatch(/\/join\/[\w-]+$/);
    expect(act.description).toContain('Interested in the X2 arm');
    const call = (await pool.query(`SELECT status, scheduled_for FROM calls WHERE id = $1`, [bk.call_id])).rows[0];
    expect(call.status).toBe('open');
    expect(new Date(call.scheduled_for).toISOString()).toBe(new Date(Date.parse(slot) + 30 * 60_000).toISOString());
    expect((await c.get('/booking-pages')).body.data[0].upcoming).toBe(1);
    expect((await c.get(`/booking-pages/${p.id}/bookings`)).body.data).toMatchObject([{ name: 'Dara Sok', status: 'booked' }]);

    const mail = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND id > $1 AND payload->>'to' = 'Dara@Example-Customer.test'`, [before])).rows[0].payload;
    expect(mail.subject).toMatch(/^Booked: Showroom visit on \w{3} /);
    expect(mail.text).toContain('Join the video call: http');
    expect(mail.attachments[0]).toMatchObject({ filename: 'booking.ics', contentType: 'text/calendar' });
    expect(Buffer.from(mail.attachments[0].content, 'base64').toString()).toContain('BEGIN:VEVENT');
    const token = /\/booking\/([\w-]+)/.exec(mail.text)![1];

    // A second booking by the same person reuses the contact.
    const slot2 = (await pub('GET', `/book/${p.slug}`)).body.days[1].slots[0];
    expect((await pub('POST', `/book/${p.slug}`, { start: slot2, name: 'Dara', email: 'dara@example-customer.test' })).status).toBe(201);
    expect((await pool.query(`SELECT count(DISTINCT contact_id)::int AS n FROM bookings WHERE page_id = $1`, [p.id])).rows[0].n).toBe(1);

    // The customer's page and cancelling.
    const mine = await pub('GET', `/bookings/${token}`);
    expect(mine.body).toMatchObject({ title: 'Showroom visit', status: 'booked', name: 'Dara Sok', past: false });
    expect(mine.body.videoUrl).toMatch(/\/join\//);
    expect((await pub('GET', '/bookings/not-a-real-token-xxxxxxxxxx')).status).toBe(404);
    expect((await pub('POST', `/bookings/${token}/cancel`)).status).toBe(200);
    expect((await pub('GET', `/bookings/${token}`)).body).toMatchObject({ status: 'canceled', videoUrl: null });
    expect((await actOf(bk.activity_id)).status).toBe('canceled');
    expect((await pool.query(`SELECT status FROM calls WHERE id = $1`, [bk.call_id])).rows[0].status).toBe('ended');
    expect((await pub('GET', `/book/${p.slug}`)).body.days[0].slots).toContain(slot); // free again
    const tl = (await c.get(`/timeline/contact/${bk.contact_id}`)).body.items.filter((i: any) => i.type === 'event').map((i: any) => i.data.action);
    expect(tl).toEqual(expect.arrayContaining(['booked', 'booking_canceled']));
    const notes = (await pool.query(`SELECT title FROM notifications WHERE user_id = $1 ORDER BY id`, [user.id])).rows.map((r) => r.title);
    expect(notes).toEqual(expect.arrayContaining(['New meeting assigned to you', 'Dara Sok canceled their booking']));
  });

  it('pages without video, inactive pages, Khmer, and the limit per person', async () => {
    const { c, me } = await signup(); const user = me.user;
    const s = (await c.get('/settings/documents')).body;
    await c.put('/settings/documents', { ...s, customerLanguage: 'km' });
    const p = await page(c, user.id, { video: false, location: 'Acme showroom, 12 Norodom Blvd' });
    const info = (await pub('GET', `/book/${p.slug}`)).body;
    expect(info.lang).toBe('km');
    const slots = info.days.flatMap((d: any) => d.slots);
    const before = (await pool.query(`SELECT coalesce(max(id), 0) AS id FROM jobs`)).rows[0].id;
    for (let i = 0; i < 3; i++) expect((await pub('POST', `/book/${p.slug}`, { start: slots[i * 3], name: 'Vanna', email: 'vanna@example.test' })).status).toBe(201);
    expect((await pub('POST', `/book/${p.slug}`, { start: slots[10], name: 'Vanna', email: 'vanna@example.test' })).status).toBe(429);
    const bk = (await pool.query(`SELECT * FROM bookings WHERE page_id = $1 ORDER BY id LIMIT 1`, [p.id])).rows[0];
    expect(bk.call_id).toBeNull();
    expect((await actOf(bk.activity_id)).location).toBe('Acme showroom, 12 Norodom Blvd');
    const mail = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND id > $1 AND payload->>'to' = 'vanna@example.test' ORDER BY id LIMIT 1`, [before])).rows[0].payload;
    expect(mail.subject).toMatch(/^បានកក់៖ Showroom visit នៅ /);
    expect(mail.text).toContain('ទីកន្លែង៖ Acme showroom');

    await c.put(`/booking-pages/${p.id}`, { title: 'Showroom visit', slug: p.slug, hostId: user.id, durationMinutes: 30, days: allDays, start: '00:00', end: '23:30', active: false });
    expect((await pub('GET', `/book/${p.slug}`)).status).toBe(404);
    expect((await pub('POST', `/book/${p.slug}`, { start: slots[20], name: 'X', email: 'x@example.test' })).status).toBe(404);
    // Deleting the page keeps the bookings and meetings.
    expect((await c.del(`/booking-pages/${p.id}`)).status).toBe(204);
    expect((await actOf(bk.activity_id)).status).toBe('open');
  });

  it('the customer moves their booking: meeting, reminder, call and calendar follow; limits', async () => {
    const { c, me } = await signup(); const user = me.user;
    const p = await page(c, user.id, { durationMinutes: 60 }); // 60 minutes, every 30: the next slot overlaps the booked one
    const slots = (await pub('GET', `/book/${p.slug}`)).body.days.flatMap((d: any) => d.slots) as string[];
    const before = (await pool.query(`SELECT coalesce(max(id), 0) AS id FROM jobs`)).rows[0].id;
    expect((await pub('POST', `/book/${p.slug}`, { start: slots[0], name: 'Dara Sok', email: 'dara@move.test' })).status).toBe(201);
    expect((await pub('POST', `/book/${p.slug}`, { start: slots[6], name: 'Bo', email: 'bo@move.test' })).status).toBe(201); // someone else
    const mails = async (to: string) => (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND id > $1 AND payload->>'to' = $2 ORDER BY id`, [before, to])).rows.map((r) => r.payload);
    const first = (await mails('dara@move.test'))[0];
    const token = /\/booking\/([\w-]+)/.exec(first.text)![1];
    const ics = (m: any) => Buffer.from(m.attachments[0].content, 'base64').toString();
    const uid = /UID:(.+)\r\n/.exec(ics(first))![1];
    expect(ics(first)).toContain('SEQUENCE:0');

    expect((await pub('GET', `/bookings/${token}`)).body.canReschedule).toBe(true);
    const moveTo = (await pub('GET', `/bookings/${token}/slots`)).body;
    const offered = moveTo.days.flatMap((d: any) => d.slots);
    expect(offered).not.toContain(slots[0]); // its own time
    expect(offered).toContain(slots[1]); // overlaps its own time: still offered
    expect(offered).not.toContain(slots[6]); // someone else's

    expect((await pub('POST', `/bookings/${token}/reschedule`, { start: slots[0] })).status).toBe(409); // same time
    expect((await pub('POST', `/bookings/${token}/reschedule`, { start: slots[6] })).body.error.code).toBe('TAKEN');
    const moved = await pub('POST', `/bookings/${token}/reschedule`, { start: slots[1] });
    expect(moved.status).toBe(200);
    expect(moved.body.start).toBe(slots[1]);

    const bk = (await pool.query(`SELECT * FROM bookings WHERE token_hash IS NOT NULL AND email = 'dara@move.test'`)).rows[0];
    expect(bk.reschedules).toBe(1);
    const act = (await pool.query(`SELECT due_at, reminder_at, reminded_at FROM activities WHERE id = $1`, [bk.activity_id])).rows[0];
    expect(new Date(act.due_at).toISOString()).toBe(slots[1]);
    expect(new Date(act.reminder_at).toISOString()).toBe(new Date(Date.parse(slots[1]) - 15 * 60_000).toISOString());
    expect(act.reminded_at).toBeNull();
    const call = (await pool.query(`SELECT scheduled_for FROM calls WHERE id = $1`, [bk.call_id])).rows[0];
    expect(new Date(call.scheduled_for).toISOString()).toBe(new Date(Date.parse(slots[1]) + 60 * 60_000).toISOString());
    const movedMail = (await mails('dara@move.test')).at(-1);
    expect(movedMail.subject).toMatch(/^Moved: Showroom visit to /);
    expect(movedMail.text).toContain('Your booking was moved.');
    expect(ics(movedMail)).toContain(`UID:${uid}`); // the same calendar entry…
    expect(ics(movedMail)).toContain('SEQUENCE:1'); // …in a newer version
    const note = (await pool.query(`SELECT title FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [user.id])).rows[0];
    expect(note.title).toBe('Dara Sok moved their booking');
    const tl = (await c.get(`/timeline/contact/${bk.contact_id}`)).body.items.filter((i: any) => i.type === 'event').map((i: any) => i.data.action);
    expect(tl).toContain('booking_moved');
    // Up to three moves. After moving away, the earlier times are free again; the new one isn't.
    expect((await pub('POST', `/bookings/${token}/reschedule`, { start: slots[10] })).status).toBe(200);
    const now = (await pub('GET', `/book/${p.slug}`)).body.days.flatMap((d: any) => d.slots);
    expect(now).toEqual(expect.arrayContaining([slots[0], slots[1]]));
    expect(now).not.toContain(slots[10]);
    expect((await pub('POST', `/bookings/${token}/reschedule`, { start: slots[12] })).status).toBe(200);
    expect((await pub('GET', `/bookings/${token}`)).body.canReschedule).toBe(false);
    expect((await pub('POST', `/bookings/${token}/reschedule`, { start: slots[14] })).body.error.code).toBe('TOO_MANY_MOVES');
    // Cancelling still works, and its calendar file outranks every earlier one.
    expect((await pub('POST', `/bookings/${token}/cancel`)).status).toBe(200);
    const cancelMail = (await mails('dara@move.test')).at(-1);
    expect(ics(cancelMail)).toContain('SEQUENCE:4');
    expect(ics(cancelMail)).toContain('METHOD:CANCEL');
    expect((await pub('POST', `/bookings/${token}/reschedule`, { start: slots[16] })).status).toBe(409);

    // A page that's off: the booking can't be moved (cancel still can).
    const bo = /\/booking\/([\w-]+)/.exec((await mails('bo@move.test'))[0].text)![1];
    await c.put(`/booking-pages/${p.id}`, { title: 'Showroom visit', slug: p.slug, hostId: user.id, durationMinutes: 60, days: allDays, start: '00:00', end: '23:30', active: false });
    expect((await pub('GET', `/bookings/${bo}`)).body.canReschedule).toBe(false);
    expect((await pub('GET', `/bookings/${bo}/slots`)).status).toBe(409);
  });

  it('the team moves or cancels a booking: customer emailed with their link, host told, permissions', async () => {
    const { c, me } = await signup(); const user = me.user;
    const { c: rep, id: repId } = await inviteUser(c, 'Sales rep', 'Rita Rep');
    const p = await page(c, repId, { durationMinutes: 30, video: false, location: 'Showroom' }); // Rita meets the customers
    const slots = (await pub('GET', `/book/${p.slug}`)).body.days.flatMap((d: any) => d.slots) as string[];
    const before = (await pool.query(`SELECT coalesce(max(id), 0) AS id FROM jobs`)).rows[0].id;
    await pub('POST', `/book/${p.slug}`, { start: slots[0], name: 'Dara Sok', email: 'dara@team.test' });
    await pub('POST', `/book/${p.slug}`, { start: slots[4], name: 'Bo', email: 'bo@team.test' });
    const mails = async (to: string) => (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' AND id > $1 AND payload->>'to' = $2 ORDER BY id`, [before, to])).rows.map((r) => r.payload);
    const ics = (m: any) => Buffer.from(m.attachments[0].content, 'base64').toString();
    const token = /\/booking\/([\w-]+)/.exec((await mails('dara@team.test'))[0].text)![1];
    const list = (await c.get(`/booking-pages/${p.id}/bookings`)).body.data;
    const dara = list.find((x: any) => x.name === 'Dara Sok');
    const bo = list.find((x: any) => x.name === 'Bo');

    // Any future time (outside the page's grid is fine) — but not when the host is busy, nor in the past.
    const odd = new Date(Date.parse(slots[0]) + 3 * 86_400_000 + 7 * 60_000).toISOString();
    expect((await c.post(`/bookings/${dara.id}/reschedule`, { start: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
    const busy = await c.post(`/bookings/${dara.id}/reschedule`, { start: new Date(Date.parse(slots[4]) + 10 * 60_000).toISOString() }); // overlaps Bo
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('BUSY');
    const moved = await c.post(`/bookings/${dara.id}/reschedule`, { start: odd });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.start).toBe(odd);
    // The customer: told who moved it, with their own link, and the calendar entry updated.
    const m = (await mails('dara@team.test')).at(-1);
    expect(m.subject).toMatch(/^Moved: Showroom visit to /);
    expect(m.text).toContain(`${user.name} moved your booking.`);
    expect(m.text).toContain(`/booking/${token}`);
    expect(ics(m)).toContain('SEQUENCE:1');
    // Team moves don't use up the customer's own moves.
    expect((await pub('GET', `/bookings/${token}`)).body).toMatchObject({ canReschedule: true, start: odd });
    // The host (Rita) is told; the meeting moved.
    const note = (await pool.query(`SELECT title FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [repId])).rows[0];
    expect(note.title).toBe(`${user.name} moved Dara Sok’s booking`);
    const bk = (await pool.query(`SELECT * FROM bookings WHERE id = $1`, [dara.id])).rows[0];
    expect(new Date((await actOf(bk.activity_id)).dueAt).toISOString()).toBe(odd);
    const ev = (await c.get(`/timeline/contact/${bk.contact_id}`)).body.items.find((i: any) => i.type === 'event' && i.data.action === 'booking_moved');
    expect(ev.data).toMatchObject({ actorType: 'user', changes: { by: 'team' } });
    // The customer moves it themselves afterwards: the calendar version keeps rising.
    const free = (await pub('GET', `/bookings/${token}/slots`)).body.days.flatMap((d: any) => d.slots);
    expect((await pub('POST', `/bookings/${token}/reschedule`, { start: free[0] })).status).toBe(200);
    expect(ics((await mails('dara@team.test')).at(-1))).toContain('SEQUENCE:2');

    // Rita (the host) cancels Bo's booking with a reason; Bo is emailed; Rita isn't notified about her own action.
    const notesBefore = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [repId])).rows[0].n;
    expect((await rep.post(`/bookings/${bo.id}/cancel`, { reason: 'I’m ill that day — sorry! Please book another time.' })).status).toBe(200);
    const cm = (await mails('bo@team.test')).at(-1);
    expect(cm.subject).toMatch(/^Canceled: Showroom visit on /);
    expect(cm.text).toContain('Rita Rep canceled this booking.');
    expect(cm.text).toContain('I’m ill that day');
    expect(ics(cm)).toContain('METHOD:CANCEL');
    expect((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [repId])).rows[0].n).toBe(notesBefore);
    expect((await pool.query(`SELECT status, canceled_by FROM bookings WHERE id = $1`, [bo.id])).rows[0]).toEqual({ status: 'canceled', canceled_by: 'team' });
    expect((await rep.post(`/bookings/${bo.id}/cancel`)).status).toBe(409); // already canceled

    // Permissions: another rep (not the host, not admin) and other workspaces can't.
    const { c: other } = await inviteUser(c, 'Sales rep', 'Otto');
    expect((await other.post(`/bookings/${dara.id}/cancel`)).status).toBe(404);
    expect((await other.post(`/bookings/${dara.id}/reschedule`, { start: odd })).status).toBe(404);
    const ws2 = await signup();
    expect((await ws2.c.post(`/bookings/${dara.id}/cancel`)).status).toBe(404);
  });
});
