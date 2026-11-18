/* global self, caches, Response */
/*
 * Service worker: makes the CRM installable and quick to open on slow connections.
 * - App files under /assets/ (their names change with every build) are kept after the first load: cache first.
 * - Pages always come from the server when there is a connection (so a new version shows at once); without one,
 *   the offline page is shown.
 * - CRM data (/api/…) is never cached: what you see is always live, and nothing private stays on the device.
 */
const SHELL = 'crm-shell-v1';
const ASSETS = 'crm-assets-v1';
const SHELL_FILES = ['/offline.html', '/offline.js', '/favicon.svg', '/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== ASSETS) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** Keeps the assets cache to the newest 150 files (old builds' files would otherwise pile up). */
async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - 150))) await cache.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/widget.js' || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(ASSETS); await c.put(req, res.clone()); trim(c); }
      return res;
    })());
    return;
  }
  // Icons, manifest, favicon: from the cache when offline.
  e.respondWith(fetch(req).catch(async () => (await caches.match(req)) || Response.error()));
});
