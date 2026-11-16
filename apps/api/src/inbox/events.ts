/**
 * Real-time Inbox updates. Anything that changes a conversation calls notifyInbox() inside its transaction; Postgres
 * delivers the NOTIFY on commit to every API process (also when the change came from the separate worker). Each
 * process keeps one LISTEN connection and forwards "conversation N changed" to the open event streams of users who
 * may see that conversation. Browsers then refetch through the normal API, so permissions apply as usual.
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

interface Sub { ctx: Ctx; send: (conversationId: number) => void }
const subs = new Set<Sub>();
let client: pg.PoolClient | null = null;
let starting: Promise<void> | null = null;

function dispatch(payload: string | undefined) {
  let e: { w: number; c: number; a: number | null };
  try { e = JSON.parse(payload ?? ''); } catch { return; }
  for (const s of subs) {
    if (s.ctx.workspaceId === e.w && canOnConversation(s.ctx, 'view', { assignee_id: e.a })) s.send(e.c);
  }
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

export async function subscribe(ctx: Ctx, send: (conversationId: number) => void): Promise<() => void> {
  await ensureListening();
  const sub = { ctx, send };
  subs.add(sub);
  return () => { subs.delete(sub); };
}

/** On shutdown: release the LISTEN connection so the pool can close. */
export async function stopListening(): Promise<void> {
  const c = client;
  client = null;
  starting = null;
  subs.clear();
  if (c) { try { await c.query(`UNLISTEN ${CHANNEL}`); } catch { /* closing anyway */ } c.release(); }
}

export const subscriberCount = () => subs.size;
