/**
 * Meta webhooks (Messenger, Instagram, WhatsApp): GET answers Meta's verification, POST receives events. The body is
 * kept raw because X-Hub-Signature-256 is an HMAC of the exact bytes. See inbox/meta.ts.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isMetaKind } from '@crm/shared';
import { AppError, notFound } from '../lib/errors.ts';
import { channelByKey } from '../inbox/telegram.ts';
import { credentialsOf, ingestMeta, validSignature, type MetaPayload } from '../inbox/meta.ts';

type KeyParams = { Params: { key: string } };
const sameText = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function metaHookRoutes(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  /** Meta calls this once when the webhook is set up in the app dashboard. */
  app.get<KeyParams & { Querystring: Record<string, string | undefined> }>('/hooks/meta/:key', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = await channelByKey(req.params.key);
    if (!c || !isMetaKind(c.kind)) throw notFound('Channel');
    const mode = req.query['hub.mode'];
    const token = String(req.query['hub.verify_token'] ?? '');
    if (mode !== 'subscribe' || !c.webhook_secret || !sameText(token, c.webhook_secret)) throw new AppError(403, 'FORBIDDEN', 'Wrong verify token');
    return reply.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  });

  app.post<KeyParams>('/hooks/meta/:key', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    const c = await channelByKey(req.params.key);
    if (!c || !isMetaKind(c.kind) || !c.secret) throw notFound('Channel');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!validSignature(raw, req.headers['x-hub-signature-256'], credentialsOf(c).appSecret)) throw new AppError(401, 'UNAUTHENTICATED', 'Bad signature');
    let payload: MetaPayload;
    try { payload = JSON.parse(raw.toString('utf8')) as MetaPayload; } catch { throw new AppError(400, 'BAD_REQUEST', 'Invalid JSON'); }
    // Disabled channels are skipped inside; Meta always gets 200 so it doesn't retry or turn the webhook off.
    await ingestMeta(c, payload);
    return { ok: true };
  });
}
