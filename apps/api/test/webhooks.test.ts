import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processJobs, processOutbox } from '../src/automation/engine.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { checkWebhookUrl, deliverWebhook, hostAllowed, isPrivateAddress, normaliseHost, policy, sign } from '../src/lib/webhooks.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

// A local receiver. Tests run with the development policy (http + localhost allowed) unless a test turns it off.
const received: { headers: IncomingHttpHeaders; body: string }[] = [];
let answer = 200;
let server: Server;
let base = '';
beforeAll(async () => {
  policy.allowHttp = true; policy.allowPrivate = true;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      received.push({ headers: req.headers, body });
      if (answer === 302) res.writeHead(302, { location: 'http://169.254.169.254/' }).end(); else res.writeHead(answer).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  policy.allowHttp = false; policy.allowPrivate = false;
  server.close();
  await (await getApp()).close(); await pool.end();
});
const drain = async () => { await processOutbox(); await processJobs(50); };

describe('webhook action', () => {
  it('calls an allow-listed URL with a signed JSON payload when a deal reaches a stage', async () => {
    const { c, dealPipeline, stage } = await signup();
    // Not on the allow-list yet: the rule can't be saved.
    const rule = { entityType: 'deal', pipelineId: dealPipeline.id, stageId: stage(dealPipeline, 'Proposal').id, trigger: 'stage_entered', action: 'webhook', config: { url: `${base}/crm` } };
    const refused = await c.post('/automation-rules', rule);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('allow-list');

    expect((await c.put('/settings/webhooks', { allowedHosts: ['localhost', ' Hooks.Example.com ', '*.zapier.com'] })).body.allowedHosts)
      .toEqual(['localhost', 'hooks.example.com', '*.zapier.com']);
    const { secret } = (await c.get('/settings/webhooks')).body;
    expect(secret).toMatch(/^whsec_/);
    expect((await c.post('/automation-rules', rule)).status).toBe(201);

    const d = (await c.post('/deals', { title: 'Hooked', amount: '1200' })).body;
    received.length = 0;
    await c.post(`/deals/${d.id}/move`, { stageId: stage(dealPipeline, 'Proposal').id });
    await drain();
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(headers['x-crm-signature']).toBe(sign(secret, body));
    expect(headers['x-crm-event']).toBe('deal.automation');
    const payload = JSON.parse(body);
    expect(payload.record).toMatchObject({ type: 'deal', id: d.id, title: 'Hooked', amount: '1200.00', stage: 'Proposal' });
    expect(payload.record.url).toMatch(new RegExp(`/deals/${d.id}$`));
    const runs = (await c.get(`/automation-runs/deal/${d.id}`)).body.data;
    expect(runs[0]).toMatchObject({ status: 'success', action: 'webhook', message: 'Webhook answered HTTP 200' });
    expect((await c.get(`/history/deal/${d.id}`)).body.data.some((h: any) => h.action === 'webhook_sent')).toBe(true);

    // Rotating the secret changes the signature.
    const rotated = (await c.post('/settings/webhooks/rotate-secret', {})).body.secret;
    expect(rotated).not.toBe(secret);
  });

  it('retries failures and marks the run failed after the last attempt', async () => {
    const { c, dealPipeline } = await signup();
    await c.put('/settings/webhooks', { allowedHosts: ['localhost'] });
    await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'created', action: 'webhook', config: { url: `${base}/fail` } });
    answer = 500;
    try {
      const d = (await c.post('/deals', { title: 'Fails' })).body;
      received.length = 0;
      await drain();
      for (let i = 0; i < 2; i++) { await q(sql`UPDATE jobs SET run_at = now() WHERE status = 'pending' AND type = 'automation.run'`); await processJobs(50); }
      expect(received).toHaveLength(3);
      const runs = (await c.get(`/automation-runs/deal/${d.id}`)).body.data;
      expect(runs[0]).toMatchObject({ status: 'failed', message: 'The webhook answered HTTP 500' });
    } finally { answer = 200; }
  });

  it('never follows redirects and refuses private addresses in production mode', async () => {
    answer = 302;
    try {
      await expect(deliverWebhook(`${base}/r`, ['localhost'], 's', 'e', {}, '1')).rejects.toThrow(/redirect/);
    } finally { answer = 200; }
    policy.allowPrivate = false;
    try {
      received.length = 0;
      await expect(deliverWebhook(`${base}/x`, ['localhost'], 's', 'e', {}, '1')).rejects.toThrow(/private address/);
      expect(received).toHaveLength(0);
    } finally { policy.allowPrivate = true; }
  });

  it('validates URLs, hosts and addresses', () => {
    policy.allowHttp = false;
    try {
      const allowed = ['hooks.example.com', '*.zapier.com'];
      expect(checkWebhookUrl('https://hooks.example.com/a', allowed).hostname).toBe('hooks.example.com');
      expect(checkWebhookUrl('https://x.zapier.com/a', allowed).hostname).toBe('x.zapier.com');
      expect(() => checkWebhookUrl('http://hooks.example.com/a', allowed)).toThrow(/https/);
      expect(() => checkWebhookUrl('https://u:p@hooks.example.com/', allowed)).toThrow(/password/);
      expect(() => checkWebhookUrl('https://127.0.0.1/', allowed)).toThrow(/IP address/);
      expect(() => checkWebhookUrl('https://evil.com/', allowed)).toThrow(/allow-list/);
      expect(() => checkWebhookUrl('https://zapier.com.evil.com/', allowed)).toThrow(/allow-list/);
      expect(() => checkWebhookUrl('not a url', allowed)).toThrow(/full URL/);
    } finally { policy.allowHttp = true; }
    expect(hostAllowed('zapier.com', ['*.zapier.com'])).toBe(false);
    expect(hostAllowed('evilzapier.com', ['*.zapier.com'])).toBe(false);
    expect(normaliseHost('https://x.com/path')).toBeNull();
    expect(normaliseHost('x.com:8080')).toBeNull();
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('webhook settings are admin-only and per workspace', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.get('/settings/webhooks')).status).toBe(403);
    expect((await rep.c.put('/settings/webhooks', { allowedHosts: ['x.com'] })).status).toBe(403);
    expect((await rep.c.post('/settings/webhooks/rotate-secret', {})).status).toBe(403);
    expect((await c.put('/settings/webhooks', { allowedHosts: ['http://bad'] })).status).toBe(400);
    await c.put('/settings/webhooks', { allowedHosts: ['a.example.com'] });
    expect(JSON.stringify((await c.patch('/workspace', { name: 'Renamed' })).body)).not.toContain('whsec_');
    expect(JSON.stringify((await c.get('/auth/me')).body)).not.toContain('whsec_');
    const other = await signup('Other');
    expect((await other.c.get('/settings/webhooks')).body.allowedHosts).toEqual([]);
    expect((await other.c.get('/settings/webhooks')).body.secret).not.toBe((await c.get('/settings/webhooks')).body.secret);
  });
});
