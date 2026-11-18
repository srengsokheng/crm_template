/**
 * Video calls (WebRTC, peer to peer — every participant connects to every other one, fine for about 4 people).
 * The server only relays set-up messages and keeps track of who is in the call; audio and video go directly between
 * browsers (through a TURN relay when one is configured and a network needs it). Nothing is recorded.
 *
 * Each participant (team member or guest with the link) joins and gets a peer id and a secret. Their browser keeps an
 * event stream open (GET …/events?peer=&secret=) that carries: "peers" (who is in the call), "signal" (an offer,
 * answer or network candidate addressed to them) and "ended". Set-up messages are stored in call_signals and
 * announced with pg_notify('calls'), so this works across API processes.
 *
 * Leaving (or a refreshed page) doesn't end the call: the worker ends calls that have been empty for a minute, with
 * the end time taken from when the last person left. The linked meeting activity then gets the length and is done.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { openSecret, sealSecret } from '../lib/secrets.ts';

const CHANNEL = 'calls';
export const MAX_PEERS = 6;
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (n = 24) => randomBytes(n).toString('base64url');

export interface CallRow {
  id: number; workspace_id: number; title: string; activity_id: number | null; conversation_id: number | null;
  guest_token_sealed: string; status: 'open' | 'ended'; created_by: number | null; created_at: Date;
  started_at: Date | null; ended_at: Date | null;
}
export interface Peer { peerId: string; name: string; guest: boolean; userId: number | null }

/** STUN/TURN servers for the browsers (CALL_ICE_SERVERS). */
export const iceServers = () => config.calls.iceServers;

export const guestUrl = (t: string) => `${config.appUrl.replace(/\/$/, '')}/join/${t}`;
/** The guest link of an existing call (for the team). */
export const guestUrlOf = (c: { guest_token_sealed: string }) => guestUrl(openSecret(c.guest_token_sealed));

/** Creates a call. The guest token is stored hashed (to find the call) and encrypted (to show the link again). */
export async function createCall(db: Db, workspaceId: number, userId: number, title: string, link: { activityId?: number | null; conversationId?: number | null }): Promise<CallRow> {
  const guest = token();
  const row = await q1<CallRow>(sql`INSERT INTO calls (workspace_id, title, activity_id, conversation_id, guest_token_hash, guest_token_sealed, created_by)
    VALUES (${workspaceId}, ${title.slice(0, 200)}, ${link.activityId ?? null}, ${link.conversationId ?? null}, ${hash(guest)}, ${sealSecret(guest)}, ${userId})
    RETURNING *`, db);
  return row!;
}

export async function callByGuestToken(t: string): Promise<CallRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  return (await q1<CallRow>(sql`SELECT * FROM calls WHERE guest_token_hash = ${hash(t)}`)) ?? null;
}

export async function activePeers(callId: number, db: Db = pool): Promise<Peer[]> {
  const rows = await q<{ peer_id: string; name: string; user_id: number | null }>(sql`
    SELECT peer_id, name, user_id FROM call_peers WHERE call_id = ${callId} AND left_at IS NULL ORDER BY id`, db);
  return rows.map((r) => ({ peerId: r.peer_id, name: r.name, guest: r.user_id === null, userId: r.user_id }));
}

async function notify(db: Db, payload: Record<string, unknown>) {
  await q(sql`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(payload)})`, db);
}

/** Adds a participant. Returns their peer id and secret (kept only hashed) and who is already in the call. */
export async function joinCall(call: CallRow, name: string, userId: number | null): Promise<{ peerId: string; secret: string; peers: Peer[] }> {
  if (call.status !== 'open') throw new AppError(410, 'CALL_ENDED', 'This call has ended.');
  return tx(async (db) => {
    const c = await q1<{ status: string }>(sql`SELECT status FROM calls WHERE id = ${call.id} FOR UPDATE`, db);
    if (c?.status !== 'open') throw new AppError(410, 'CALL_ENDED', 'This call has ended.');
    const peers = await activePeers(call.id, db);
    if (peers.length >= MAX_PEERS) throw new AppError(409, 'CALL_FULL', `A call can have up to ${MAX_PEERS} people.`);
    const peerId = token(12);
    const secret = token();
    await q(sql`INSERT INTO call_peers (call_id, peer_id, secret_hash, name, user_id) VALUES (${call.id}, ${peerId}, ${hash(secret)}, ${name.slice(0, 80)}, ${userId})`, db);
    await q(sql`UPDATE calls SET started_at = coalesce(started_at, now()) WHERE id = ${call.id}`, db);
    await notify(db, { t: 'peers', c: call.id });
    return { peerId, secret, peers };
  });
}

/** The participant whose browser presents this peer id and secret, if they are still in this call. */
export async function peerOf(callId: number, peerId: unknown, secret: unknown): Promise<string | null> {
  const p = await q1<{ peer_id: string; secret_hash: string }>(sql`SELECT peer_id, secret_hash FROM call_peers
    WHERE call_id = ${callId} AND peer_id = ${String(peerId ?? '')} AND left_at IS NULL`);
  if (!p) return null;
  const a = Buffer.from(p.secret_hash);
  const b = Buffer.from(hash(String(secret ?? '')));
  return a.length === b.length && timingSafeEqual(a, b) ? p.peer_id : null;
}

/** Relays a set-up message to another participant of the same call. */
export async function relaySignal(callId: number, from: string, to: string, kind: 'offer' | 'answer' | 'candidate', data: unknown): Promise<void> {
  await tx(async (db) => {
    const target = await q1(sql`SELECT 1 FROM call_peers WHERE call_id = ${callId} AND peer_id = ${to} AND left_at IS NULL`, db);
    if (!target) throw notFound('Participant');
    const s = await q1<{ id: number }>(sql`INSERT INTO call_signals (call_id, from_peer, to_peer, kind, data)
      VALUES (${callId}, ${from}, ${to}, ${kind}, ${JSON.stringify(data)}) RETURNING id`, db);
    await notify(db, { t: 'signal', c: callId, s: s!.id, to });
  });
}

/** A participant leaves (button, closed tab, lost connection); the call stays open so a refreshed page can rejoin. */
export async function leaveCall(callId: number, peerId: string): Promise<void> {
  await tx(async (db) => {
    const r = await q1(sql`UPDATE call_peers SET left_at = now() WHERE call_id = ${callId} AND peer_id = ${peerId} AND left_at IS NULL RETURNING id`, db);
    if (r) await notify(db, { t: 'peers', c: callId });
  });
}

/** Ends the call for everyone. */
export async function endCall(callId: number): Promise<CallRow | null> {
  return tx(async (db) => {
    await q(sql`UPDATE call_peers SET left_at = now() WHERE call_id = ${callId} AND left_at IS NULL`, db);
    return finish(db, callId);
  });
}

/** Worker: ends calls that were joined but have been empty for `graceSeconds`. */
export async function endEmptyCalls(graceSeconds = 60): Promise<CallRow[]> {
  const ids = await q<{ id: number }>(sql`SELECT c.id FROM calls c WHERE c.status = 'open' AND c.started_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM call_peers p WHERE p.call_id = c.id AND p.left_at IS NULL)
    AND (SELECT max(p.left_at) FROM call_peers p WHERE p.call_id = c.id) <= now() - make_interval(secs => ${graceSeconds})`);
  const out: CallRow[] = [];
  for (const { id } of ids) { const c = await tx((db) => finish(db, id)); if (c) out.push(c); }
  return out;
}

async function finish(db: Db, callId: number): Promise<CallRow | null> {
  const c = await q1<CallRow>(sql`UPDATE calls SET status = 'ended',
      ended_at = coalesce((SELECT max(left_at) FROM call_peers WHERE call_id = ${callId}), now())
    WHERE id = ${callId} AND status = 'open' RETURNING *`, db);
  if (!c) return null;
  await logOnActivity(db, c);
  await notify(db, { t: 'ended', c: callId });
  await q(sql`DELETE FROM call_signals WHERE call_id = ${callId}`, db);
  return c;
}

/** Minutes between the first join and the end (at least 1 when anyone joined). */
export const callMinutes = (c: Pick<CallRow, 'started_at' | 'ended_at'>) =>
  (c.started_at && c.ended_at ? Math.max(1, Math.round((+new Date(c.ended_at) - +new Date(c.started_at)) / 60_000)) : 0);

/** The meeting activity gets the call's length and who took part, and is marked done. */
async function logOnActivity(db: Db, c: CallRow) {
  if (!c.activity_id || !c.started_at) return;
  const names = await q<{ name: string }>(sql`SELECT DISTINCT name FROM call_peers WHERE call_id = ${c.id} ORDER BY name`, db);
  const minutes = callMinutes(c);
  const outcome = `Video call, ${minutes} min, with ${names.map((n) => n.name).join(', ')}`.slice(0, 500);
  await q(sql`UPDATE activities SET duration_minutes = ${minutes}, outcome = ${outcome},
      completed_at = CASE WHEN status = 'open' THEN now() ELSE completed_at END,
      completed_by = CASE WHEN status = 'open' THEN ${c.created_by} ELSE completed_by END,
      status = CASE WHEN status = 'open' THEN 'done' ELSE status END,
      updated_at = now(), version = version + 1
    WHERE id = ${c.activity_id} AND workspace_id = ${c.workspace_id}`, db);
}

// ---------------------------------------------------------------------------------------------------------------
// Event streams

export type CallEvent = { event: 'peers'; peers: Peer[] } | { event: 'signal'; from: string; kind: string; data: unknown } | { event: 'ended' };
interface Sub { callId: number; peerId: string; send: (e: CallEvent) => void }
const subs = new Set<Sub>();
let client: pg.PoolClient | null = null;
let starting: Promise<void> | null = null;

async function dispatch(payload: string | undefined) {
  let e: { t: string; c: number; s?: number; to?: string };
  try { e = JSON.parse(payload ?? ''); } catch { return; }
  const mine = [...subs].filter((s) => s.callId === e.c);
  if (!mine.length) return;
  if (e.t === 'peers') {
    const peers = await activePeers(e.c);
    for (const s of mine) s.send({ event: 'peers', peers });
  } else if (e.t === 'signal' && e.s) {
    const targets = mine.filter((s) => s.peerId === e.to);
    if (!targets.length) return;
    const sig = await q1<{ from_peer: string; kind: string; data: unknown }>(sql`SELECT from_peer, kind, data FROM call_signals WHERE id = ${e.s}`);
    if (sig) for (const s of targets) s.send({ event: 'signal', from: sig.from_peer, kind: sig.kind, data: sig.data });
  } else if (e.t === 'ended') {
    for (const s of mine) s.send({ event: 'ended' });
  }
}

async function ensureListening() {
  if (client) return;
  starting ??= (async () => {
    const c = await pool.connect();
    c.on('notification', (n) => { void dispatch(n.payload).catch(() => {}); });
    c.on('error', () => { if (client === c) { client = null; starting = null; } try { c.release(true); } catch { /* gone */ } });
    await c.query(`LISTEN ${CHANNEL}`);
    client = c;
  })().catch((err) => { starting = null; throw err; });
  await starting;
}

export async function subscribeCall(callId: number, peerId: string, send: Sub['send']): Promise<() => void> {
  await ensureListening();
  const sub = { callId, peerId, send };
  subs.add(sub);
  return () => { subs.delete(sub); };
}

export async function stopCallListening() {
  const c = client;
  client = null; starting = null; subs.clear();
  if (c) { try { await c.query(`UNLISTEN ${CHANNEL}`); } catch { /* closing */ } c.release(); }
}
export const callSubscriberCount = () => subs.size;

/** Housekeeping: old set-up messages; calls nobody ever joined are closed after a day. */
export async function purgeCalls() {
  await q(sql`DELETE FROM call_signals WHERE created_at < now() - interval '1 day'`);
  await q(sql`UPDATE calls SET status = 'ended', ended_at = now() WHERE status = 'open' AND started_at IS NULL AND created_at < now() - interval '1 day'`);
}
