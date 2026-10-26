/* GrowizeMessages service worker — app-shell caching only.
 * Never caches /api/* responses, conversations, credentials or tokens. */
'use strict';

const VERSION = 'growize-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const CDN_CACHE = `${VERSION}-cdn`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './assets/icons/logo.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/favicon-32.png',
  './assets/icons/apple-touch-icon.png',
  './services/store.js',
  './services/api.js',
  './services/demo.js',
  './services/supabase.js',
  './services/rules-engine.js',
  './services/live-mode.js',
  './components/ui.js',
  './components/navigation.js',
  './components/auth.js',
  './components/dashboard.js',
  './components/inbox.js',
  './components/automations.js',
  './components/ai-settings.js',
  './components/integrations.js',
  './components/activity-logs.js',
  './components/system-health.js',
  './components/settings.js',
  './components/setup-wizard.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Cache each asset individually so one failure cannot break the install.
    await Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => undefined);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache mutations

  const url = new URL(request.url);

  // Backend API + Supabase: network only, never cached, explicit offline signal.
  if (url.pathname.includes('/api/') || /supabase(\.co)?/.test(url.hostname)) {
    if (url.searchParams.has('apikey')) return; // let Supabase client handle it
    event.respondWith(fetch(request).catch(() => new Response(
      JSON.stringify({ ok: false, offline: true, error: 'You are offline. Live management actions are unavailable.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  // Navigations: network first, fall back to cached shell for offline use.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('./index.html', res.clone());
        return res;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) ||
          new Response('<h1>GrowizeMessages</h1><p>Offline and not cached yet.</p>',
            { headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // CDN modules (lucide, supabase-js): stale-while-revalidate runtime cache.
  if (/esm\.sh|unpkg\.com|cdn\.jsdelivr\.net/.test(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // Same-origin static assets: cache first, refresh in background.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});
