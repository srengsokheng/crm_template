/**
 * Real-time Inbox updates. Anything that changes a conversation calls notifyInbox() inside its transaction; Postgres
 * delivers the NOTIFY on commit to every API process (also when the change came from the separate worker). Each
 * process keeps one LISTEN connection and forwards events to the open streams:
 *   - team members' streams (GET /inbox/events) get "conversation N changed" for conversations they may see, and
 *     "someone is typing" (the visitor, or a colleague);
 *   - a website visitor's stream (GET /public/webchat/:key/events) gets "your conversation changed" and "the team is
 *     typing" for their own conversation only.
 * Browsers then refetch through the normal API, so permissions apply as usual. Typing events are never stored.
 */
import type pg from 'pg';
import { pool, q, sql, type Db } from '../db/index.ts';
import type { Ctx } from '../lib/context.ts';
import { canOnConversation } from '../lib/permissions.ts';

const CHANNEL = 'inbox';

/** Tell listeners a conversation changed (call inside the transaction that changed it). */
export async function notifyInbox(db: Db, conversationId: number): Promise<void> {
  await q(sql`SELECT pg_notify(${CHANNEL}, json_build_object('w', workspace_id, 'c', id, 'a', assignee_id)::text)
    FROM conversations WHERE id = ${conversationId}`, db);
}

/**
 * "Someone is typing" in a conversation: the visitor/customer (side "customer") or a team member (side "team", with
 * their user id so their own stream skips it). Sent at once, not tied to a transaction.
 */
export async function notifyTyping(conversationId: number, side: 'customer' | 'team', name: string, userId?: number): Promise<void> {
  await q(sql`SELECT pg_notify(${CHANNEL}, json_build_object('t', 'typing', 'w', workspace_id, 'c', id, 'a', assignee_id,
      's', ${side}::text, 'n', ${name.slice(0, 100)}::text, 'u', ${userId ?? null}::bigint)::text)
    FROM conversations WHERE id = ${conversationId}`);
}

export type StreamEvent = { event: 'conversation'; conversationId: number } | { event: 'typing'; conversationId: number; name: string; side: 'customer' | 'team' };

interface Sub { ctx: Ctx; send: (e: StreamEvent) => void }
interface VisitorSub { conversationId: number; send: (event: 'messages' | 'typing', name?: string) => void }
const subs = new Set<Sub>();
const visitors = new Set<VisitorSub>();
let client: pg.PoolClient | null = null;
let starting: Promise<void> | null = null;

interface Payload { t?: 'typing'; w: number; c: number; a: number | null; s?: 'customer' | 'team'; n?: string; u?: number | null }

export function dispatch(payload: string | undefined) {
  let e: Payload;
  try { e = JSON.parse(payload ?? ''); } catch { return; }
  if (e.t === 'typing') {
    const side = e.s === 'team' ? 'team' : 'customer';
    for (const s of subs) {
      if (s.ctx.workspaceId !== e.w || (side === 'team' && s.ctx.userId === e.u)) continue;
      if (canOnConversation(s.ctx, 'view', { assignee_id: e.a })) s.send({ event: 'typing', conversationId: e.c, name: e.n ?? '', side });
    }
    if (side === 'team') for (const v of visitors) if (v.conversationId === e.c) v.send('typing', e.n ?? '');
    return;
  }
  for (const s of subs) {
    if (s.ctx.workspaceId === e.w && canOnConversation(s.ctx, 'view', { assignee_id: e.a })) s.send({ event: 'conversation', conversationId: e.c });
  }
  for (const v of visitors) if (v.conversationId === e.c) v.send('messages');
}

/** Opens the LISTEN connection once per process (reopened on the next subscription if it drops). */
async function ensureListening(): Promise<void> {
  if (client) return;
  starting ??= (async () => {
    const c = await pool.connect();
    c.on('notification', (n) => dispatch(n.payload));
    c.on('error', () => { if (client === c) { client = null; starting = null; } try { c.release(true); } catch { /* already gone */ } });
    await c.query(`LISTEN ${CHANNEL}`);
    client = c;
  })().catch((e) => { starting = null; throw e; });
  await starting;
}

export async function subscribe(ctx: Ctx, send: (e: StreamEvent) => void): Promise<() => void> {
  await ensureListening();
  const sub = { ctx, send };
  subs.add(sub);
  return () => { subs.delete(sub); };
}

/** Caps for visitors' streams (public, so bounded): per process and per conversation. */
export const VISITOR_STREAMS_MAX = 2000;
export const VISITOR_STREAMS_PER_CONVERSATION = 5;

/** A website visitor's stream for their own conversation; null when the caps are reached. */
export async function subscribeVisitor(conversationId: number, send: VisitorSub['send']): Promise<(() => void) | null> {
  if (visitors.size >= VISITOR_STREAMS_MAX) return null;
  let same = 0;
  for (const v of visitors) if (v.conversationId === conversationId) same++;
  if (same >= VISITOR_STREAMS_PER_CONVERSATION) return null;
  await ensureListening();
  const sub = { conversationId, send };
  visitors.add(sub);
  return () => { visitors.delete(sub); };
}

/** On shutdown: release the LISTEN connection so the pool can close. */
export async function stopListening(): Promise<void> {
  const c = client;
  client = null;
  starting = null;
  subs.clear();
  visitors.clear();
  if (c) { try { await c.query(`UNLISTEN ${CHANNEL}`); } catch { /* closing anyway */ } c.release(); }
}

export const subscriberCount = () => subs.size;
export const visitorCount = () => visitors.size;
