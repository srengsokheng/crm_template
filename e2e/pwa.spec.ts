import { expect, test } from '@playwright/test';
import { signUp } from './helpers.ts';

/** Width and height from a PNG's header. */
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

test('installable app: manifest and icons, the service worker takes over, an offline page when the connection drops', async ({ page, context }) => {
  // The manifest and its icons.
  const m = await page.request.get('/manifest.webmanifest');
  expect(m.headers()['content-type']).toBe('application/manifest+json');
  const manifest = await m.json();
  expect(manifest).toMatchObject({ name: 'Acme CRM', short_name: 'CRM', start_url: '/', display: 'standalone', theme_color: '#4f46e5' });
  for (const icon of manifest.icons) {
    const r = await page.request.get(icon.src);
    expect(r.headers()['content-type']).toBe('image/png');
    expect(pngSize(await r.body())).toEqual(icon.sizes.split('x').map(Number));
  }
  expect(manifest.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
  expect(pngSize(await (await page.request.get('/icons/apple-touch-icon.png')).body())).toEqual([180, 180]);

  await signUp(page);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  // The service worker registers and controls the page after a reload.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // CRM data is never cached by it.
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBeGreaterThan(0);
  expect(await page.evaluate(async () => {
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (new URL(r.url).pathname.startsWith('/api/')) return true;
    return false;
  })).toBe(false);

  // No connection: a clear offline page instead of the browser's error; back online, the app returns.
  await context.setOffline(true);
  await page.goto('/deals').catch(() => {});
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await context.setOffline(false); // the page reloads by itself when the connection is back
  await expect(page.getByRole('heading', { name: 'Deals' })).toBeVisible();

  // Your account explains how to install where the browser has no install button.
  await page.goto('/settings/account');
  await expect(page.getByText(/On Android, open the CRM in Chrome/)).toBeVisible();
});
