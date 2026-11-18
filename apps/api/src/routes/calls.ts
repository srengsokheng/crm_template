/**
 * Video calls: the team's side (/calls, signed in) and the guest's side (/public/calls/:token, the link sent to the
 * customer). See calls/calls.ts.
 *
 * Who on the team may open a call: for a call on a meeting activity, people who may see that activity; on an Inbox
 * conversation, people who may see that conversation; a call on its own, anyone in the workspace who has the link.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { callCreateSchema, callGuestJoinSchema, callPeerSchema, callSignalSchema } from '@crm/shared';
import { config } from '../config.ts';
import { pool, q1, sql, tx } from '../db/index.ts';
import type { Ctx } from '../lib/context.ts';
import { AppError, forbidden, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { canOnConversation } from '../lib/permissions.ts';
import { camel } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import {
  activePeers, callByGuestToken, callMinutes, createCall, endCall, guestUrlOf, iceServers, joinCall, leaveCall, peerOf,
  relaySignal, stopCallListening, subscribeCall, type CallEvent, type CallRow,
} from '../calls/calls.ts';
import { canTouchActivity } from './activities.ts';
import { documentSettings } from './documents.ts';

type IdParams = { Params: { id: string } };
type TokenParams = { Params: { token: string } };

/** The call if this team member may open it (404 otherwise, so calls of other workspaces look like they don't exist). */
async function staffCall(ctx: Ctx, id: number): Promise<CallRow> {
  const c = await q1<CallRow>(sql`SELECT * FROM calls WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`);
  if (!c) throw notFound('Call');
  if (c.activity_id) {
    const a = await q1<{ assignee_id: number | null; created_by: number | null }>(sql`SELECT assignee_id, created_by FROM activities WHERE id = ${c.activity_id}`);
    if (a && !canTouchActivity(ctx, 'view', a) && c.created_by !== ctx.userId) throw notFound('Call');
  }
  if (c.conversation_id) {
    const cv = await q1<{ assignee_id: number | null }>(sql`SELECT assignee_id FROM conversations WHERE id = ${c.conversation_id}`);
    if (cv && !canOnConversation(ctx, 'view', cv) && c.created_by !== ctx.userId) throw notFound('Call');
  }
  return c;
}

function publicCall(c: CallRow, extra: Record<string, unknown> = {}) {
  return camel({
    id: c.id, title: c.title, status: c.status, activity_id: c.activity_id, conversation_id: c.conversation_id, created_by: c.created_by,
    created_at: c.created_at, started_at: c.started_at, ended_at: c.ended_at, minutes: c.status === 'ended' ? callMinutes(c) : null, ...extra,
  });
}

export async function callRoutes(app: FastifyInstance) {
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => { for (const s of streams) s.end(); streams.clear(); await stopCallListening(); });

  /** The participant's live event stream; leaving the page (closing the stream) leaves the call. */
  async function stream(reply: FastifyReply, call: CallRow, peerId: string) {
    const res = reply.raw;
    const unsubscribe = await subscribeCall(call.id, peerId, (e: CallEvent) => {
      const { event, ...data } = e;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    reply.hijack();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\nevent: peers\ndata: ${JSON.stringify({ peers: await activePeers(call.id) })}\n\n`);
    streams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    res.on('close', () => { clearInterval(ping); unsubscribe(); streams.delete(res); void leaveCall(call.id, peerId).catch(() => {}); });
  }

  // ---------------------------------------------------------------- team
  app.post('/calls', { config: { rateLimit: { max: config.isTest ? 1000 : 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(callCreateSchema, req.body);
    let title = body.title ?? '';
    if (body.activityId) {
      const a = await q1<{ subject: string; kind: string; assignee_id: number | null; created_by: number | null }>(sql`
        SELECT subject, kind, assignee_id, created_by FROM activities WHERE id = ${body.activityId} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`);
      if (!a || !canTouchActivity(ctx, 'view', a)) throw notFound('Activity');
      title ||= a.subject;
    }
    if (body.conversationId) {
      const cv = await q1<{ title: string; assignee_id: number | null }>(sql`SELECT title, assignee_id FROM conversations WHERE id = ${body.conversationId} AND workspace_id = ${ctx.workspaceId}`);
      if (!cv || !canOnConversation(ctx, 'view', cv)) throw notFound('Conversation');
      if (!canOnConversation(ctx, 'edit', cv)) throw forbidden('You can read this conversation but not invite the customer to a call');
      title ||= `Call with ${cv.title}`;
    }
    const c = await tx((db) => createCall(db, ctx.workspaceId, ctx.userId, title || 'Video call', { activityId: body.activityId, conversationId: body.conversationId }));
    return reply.code(201).send(publicCall(c, { guest_url: guestUrlOf(c) }));
  });

  app.get<IdParams>('/calls/:id', async (req) => {
    const ctx = ctxOf(req);
    const c = await staffCall(ctx, Number(req.params.id));
    return publicCall(c, { guest_url: c.status === 'open' ? guestUrlOf(c) : null, peers: await activePeers(c.id), ice_servers: iceServers() });
  });

  app.post<IdParams>('/calls/:id/join', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const ctx = ctxOf(req);
    const c = await staffCall(ctx, Number(req.params.id));
    const me = await q1<{ name: string }>(sql`SELECT name FROM users WHERE id = ${ctx.userId}`);
    return { ...(await joinCall(c, me?.name ?? 'Team member', ctx.userId)), iceServers: iceServers() };
  });

  app.get<IdParams & { Querystring: { peer?: string; secret?: string } }>('/calls/:id/events', async (req, reply) => {
    const ctx = ctxOf(req);
    const c = await staffCall(ctx, Number(req.params.id));
    const peer = await peerOf(c.id, req.query.peer, req.query.secret);
    if (!peer) throw new AppError(403, 'NOT_IN_CALL', 'Join the call first');
    await stream(reply, c, peer);
  });

  app.post<IdParams>('/calls/:id/signal', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(callSignalSchema, req.body);
    const c = await staffCall(ctx, Number(req.params.id));
    const from = await peerOf(c.id, body.peer, body.secret);
    if (!from) throw new AppError(403, 'NOT_IN_CALL', 'Join the call first');
    await relaySignal(c.id, from, body.to, body.kind, body.data);
    return reply.code(204).send();
  });

  app.post<IdParams>('/calls/:id/leave', async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(callPeerSchema, req.body);
    const c = await staffCall(ctx, Number(req.params.id));
    const peer = await peerOf(c.id, body.peer, body.secret);
    if (peer) await leaveCall(c.id, peer);
    return reply.code(204).send();
  });

  /** Ends the call for everyone (the person who started it, or an admin). */
  app.post<IdParams>('/calls/:id/end', async (req) => {
    const ctx = ctxOf(req);
    const c = await staffCall(ctx, Number(req.params.id));
    if (c.created_by !== ctx.userId && !ctx.isAdmin) throw forbidden('Only the person who started the call (or an admin) can end it for everyone');
    const ended = (await endCall(c.id)) ?? (await q1<CallRow>(sql`SELECT * FROM calls WHERE id = ${c.id}`, pool))!;
    return publicCall(ended);
  });

  // ---------------------------------------------------------------- guests (the link sent to the customer)
  async function guestCall(t: string): Promise<CallRow> {
    const c = await callByGuestToken(t);
    if (!c) throw notFound('Call');
    return c;
  }

  app.get<TokenParams>('/public/calls/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const c = await guestCall(req.params.token);
    const ws = await q1<{ name: string }>(sql`SELECT name FROM workspaces WHERE id = ${c.workspace_id}`);
    return { title: c.title, status: c.status, host: ws?.name ?? '', lang: (await documentSettings(c.workspace_id)).customerLanguage };
  });

  app.post<TokenParams>('/public/calls/:token/join', { config: { rateLimit: { max: config.isTest ? 1000 : 10, timeWindow: '1 minute' } } }, async (req) => {
    const c = await guestCall(req.params.token);
    const body = parse(callGuestJoinSchema, req.body);
    return { ...(await joinCall(c, body.name, null)), iceServers: iceServers() };
  });

  app.get<TokenParams & { Querystring: { peer?: string; secret?: string } }>('/public/calls/:token/events', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = await guestCall(req.params.token);
    const peer = await peerOf(c.id, req.query.peer, req.query.secret);
    if (!peer) throw new AppError(403, 'NOT_IN_CALL', 'Join the call first');
    await stream(reply, c, peer);
  });

  app.post<TokenParams>('/public/calls/:token/signal', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = await guestCall(req.params.token);
    const body = parse(callSignalSchema, req.body);
    const from = await peerOf(c.id, body.peer, body.secret);
    if (!from) throw new AppError(403, 'NOT_IN_CALL', 'Join the call first');
    await relaySignal(c.id, from, body.to, body.kind, body.data);
    return reply.code(204).send();
  });

  app.post<TokenParams>('/public/calls/:token/leave', async (req, reply) => {
    const c = await guestCall(req.params.token);
    const body = parse(callPeerSchema, req.body);
    const peer = await peerOf(c.id, body.peer, body.secret);
    if (peer) await leaveCall(c.id, peer);
    return reply.code(204).send();
  });
}
