import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { deliverWebhook, policy } from '../src/lib/webhooks.ts';
import { drainJobs, getApp, inviteUser, signup } from './helpers.ts';

const received: { headers: IncomingHttpHeaders; url: string }[] = [];
let answer = 200;
let server: Server;
let port = 0;
const realResolve = policy.resolve;
beforeAll(async () => {
  policy.allowHttp = true;
  server = createServer((req, res) => { req.resume(); req.on('end', () => { received.push({ headers: req.headers, url: req.url ?? '' }); res.writeHead(answer).end(); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => { policy.resolve = realResolve; policy.allowPrivate = false; answer = 200; received.length = 0; });
afterAll(async () => { policy.allowHttp = false; server.close(); await (await getApp()).close(); await pool.end(); });

describe('DNS pinning', () => {
  it('connects to the address that was checked — the host is resolved once, never again', async () => {
    policy.allowPrivate = true; // the receiver is on 127.0.0.1
    let lookups = 0;
    // "hooks.example.test" doesn't exist in real DNS: the request can only arrive if the checked address is used.
    policy.resolve = async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; };
    const status = await deliverWebhook(`http://hooks.example.test:${port}/in?x=1`, ['hooks.example.test'], 's', 'e', { a: 1 }, 'd1');
    expect(status).toBe(200);
    expect(lookups).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].headers.host).toBe(`hooks.example.test:${port}`); // the host name is still sent (virtual hosts, TLS SNI)
    expect(received[0].url).toBe('/in?x=1');
  });

  it('a rebinding resolver (public first, private later) is never asked a second time', async () => {
    // Production policy: private addresses refused. First answer public (passes the check), any later answer private.
    let calls = 0;
    policy.resolve = async () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const attempts: unknown[] = [];
    // The connection goes to 93.184.216.34 (unreachable from the test, so it fails) — never to 127.0.0.1.
    const prev = policy.timeoutMs;
    policy.timeoutMs = 1500;
    try {
      await expect(deliverWebhook(`http://rebind.example.test:${port}/`, ['rebind.example.test'], 's', 'e', {}, 'd2', (d) => { attempts.push(d); })).rejects.toThrow();
    } finally { policy.timeoutMs = prev; }
    expect(calls).toBe(1);
    expect(received).toHaveLength(0); // the local receiver was never reached
    expect(attempts).toEqual([expect.objectContaining({ ok: false, statusCode: null })]);
  });

  it('refuses a host whose answers include a private address, before connecting', async () => {
    policy.resolve = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
    await expect(deliverWebhook('http://mixed.example.test/', ['mixed.example.test'], 's', 'e', {}, 'd3')).rejects.toThrow(/private address/);
    expect(received).toHaveLength(0);
  });
});

describe('delivery log and test send', () => {
  it('logs every attempt per rule (success, failures with retries) and admins can send a test', async () => {
    policy.allowPrivate = true;
    const { c, dealPipeline } = await signup();
    await c.get('/settings/webhooks'); // creates the signing secret
    await c.put('/settings/webhooks', { allowedHosts: ['localhost'] });
    const rule = (await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'created', action: 'webhook', config: { url: `http://localhost:${port}/hook` } })).body;

    await c.post('/deals', { title: 'Logged' });
    await drainJobs();
    answer = 500;
    await c.post('/deals', { title: 'Failing' });
    await drainJobs();
    for (let i = 0; i < 2; i++) { await q(sql`UPDATE jobs SET run_at = now() WHERE status = 'pending' AND type = 'automation.run'`); await drainJobs(); }

    const log = (await c.get(`/automation-rules/${rule.id}/deliveries`)).body.data;
    expect(log.map((d: any) => [d.ok, d.statusCode])).toEqual([[false, 500], [false, 500], [false, 500], [true, 200]]);
    expect(log[0]).toMatchObject({ event: 'deal.automation', isTest: false, url: `http://localhost:${port}/hook`, error: 'The webhook answered HTTP 500' });
    expect(log[0].durationMs).toBeGreaterThanOrEqual(0);

    // Test send: sample payload, reported back and logged as a test.
    answer = 204;
    const t = (await c.post(`/automation-rules/${rule.id}/test-webhook`, {})).body;
    expect(t).toMatchObject({ ok: true, statusCode: 204, error: null });
    expect(received.at(-1)!.headers['x-crm-event']).toBe('deal.test');
    answer = 404;
    expect((await c.post(`/automation-rules/${rule.id}/test-webhook`, {})).body).toMatchObject({ ok: false, statusCode: 404, error: 'The webhook answered HTTP 404' });
    const after = (await c.get(`/automation-rules/${rule.id}/deliveries`)).body.data;
    expect(after.slice(0, 2).map((d: any) => [d.isTest, d.statusCode])).toEqual([[true, 404], [true, 204]]);

    // Admin only; other workspaces can't see the rule; non-webhook rules have no log.
    const rep = await inviteUser(c, 'Manager');
    expect((await rep.c.get(`/automation-rules/${rule.id}/deliveries`)).status).toBe(403);
    expect((await rep.c.post(`/automation-rules/${rule.id}/test-webhook`, {})).status).toBe(403);
    const other = await signup('Other');
    expect((await other.c.get(`/automation-rules/${rule.id}/deliveries`)).status).toBe(404);
    const noteRule = (await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'created', action: 'add_note', config: { text: 'x' } })).body;
    expect((await c.get(`/automation-rules/${noteRule.id}/deliveries`)).status).toBe(400);
  });
});
