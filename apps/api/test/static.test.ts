import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { getApp, signup } from './helpers.ts';

describe('SPA static serving', () => {
  const original = config.webDist;
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crm-dist-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    await writeFile(join(dir, 'assets', 'app-123.js'), 'console.log(1)');
    config.webDist = dir + (dir.endsWith('/') || dir.endsWith('\\') ? '' : '/');
  });
  afterAll(async () => {
    config.webDist = original;
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to a real filesystem path on every OS (no "/C:/…" URL paths)', () => {
    expect(isAbsolute(original)).toBe(true);
    expect(original).not.toMatch(/^\/[A-Za-z]:/);
    // apps/web exists in the repo even before the web app is built.
    expect(existsSync(dirname(original.replace(/[\\/]+$/, '')))).toBe(true);
  });

  it('serves index.html for client routes with no-cache', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/deals/42?tab=history' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<title>spa</title>');
  });

  it('serves hashed assets with long-lived caching', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/assets/app-123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('does not cache the fallback page for a missing asset as immutable', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('refuses path traversal outside the dist folder', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/..%2f..%2fpackage.json' });
    expect(res.body).not.toContain('"workspaces"');
  });

  it('keeps unknown API routes as JSON 404s', async () => {
    const { c } = await signup();
    const res = await c.get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
