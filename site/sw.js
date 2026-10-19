/* Everything — service worker.
 * Shell (launcher + engine): network-first with cache fallback, so updates land and offline still works.
 * Apps: page HTML is network-first (a fresh deploy never pairs an old page with deleted chunks);
 *       content-hashed build assets are cache-first (they never change); everything else is stale-while-revalidate.
 * The app cache survives updates so apps opened before keep working offline; only the shell cache is versioned.
 * Retired hosts (*.invalid) are never contacted; the old SDK address is answered with everything-core.js. */
const VERSION = 'everything-v4-a30e6a96b2';
const SHELL = `${VERSION}-shell`;
const APPS = 'everything-apps-v4';
const FONTS = 'everything-fonts-v4';
const SHELL_FILES = ['./', 'index.html', 'hub.css', 'hub.js', 'apps.json', 'everything-core.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-180.png', 'icon-32.png', 'fonts.css', 'fonts/InstrumentSerif-italic-latin-1.woff2', 'fonts/InstrumentSerif-italic-latin-ext-0.woff2', 'fonts/InstrumentSerif-normal-latin-3.woff2', 'fonts/InstrumentSerif-normal-latin-ext-2.woff2', 'fonts/Inter-normal-latin-5.woff2', 'fonts/Inter-normal-latin-ext-4.woff2'];
const EHUB = /\.invalid$/i;
const TRACKERS = /(^|\.)(plausible\.io|google-analytics\.com|googletagmanager\.com|analytics\.google\.com|segment\.io|cdn\.segment\.com|mixpanel\.com|hotjar\.com|posthog\.com|sentry\.io)$/i;
const HASHED = /\/assets\/[^/]+[-.][A-Za-z0-9_]{8,}\.(?:js|mjs|css|wasm|woff2?|ttf|png|jpe?g|webp|avif|svg|gif|json|data|bin)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, APPS, FONTS]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

const scopeURL = new URL(self.registration.scope);
const inShell = (url) => url.origin === scopeURL.origin && SHELL_FILES.some((f) => new URL(f, scopeURL).pathname === url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (EHUB.test(url.hostname)) {
    if (/^sdk\.everything-hub\.invalid$/i.test(url.hostname)) {
      e.respondWith(caches.match(new URL('everything-core.js', scopeURL).href).then((r) => r || fetch(new URL('everything-core.js', scopeURL))).catch(() => new Response('', { headers: { 'content-type': 'text/javascript' } })));
    } else {
      e.respondWith(new Response(JSON.stringify({ success: false, error: { code: 'offline_local', message: 'Everything runs locally.' } }), { status: 503, headers: { 'content-type': 'application/json' } }));
    }
    return;
  }
  if (TRACKERS.test(url.hostname)) { e.respondWith(new Response(/\.js(\?|$)/.test(url.pathname) ? '' : null, { status: /\.js(\?|$)/.test(url.pathname) ? 200 : 204, headers: { 'content-type': 'text/javascript' } })); return; }
  if (req.method !== 'GET') return;
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { e.respondWith(cacheFirst(req, FONTS)); return; }
  if (url.origin !== scopeURL.origin) return;
  if (url.pathname.startsWith(scopeURL.pathname + 'api/')) return; // the server API is never cached
  if (req.mode === 'navigate' && url.pathname === scopeURL.pathname || inShell(url)) { e.respondWith(networkFirst(req, SHELL, true)); return; }
  if (url.pathname.startsWith(scopeURL.pathname + 'apps/') || url.pathname.startsWith(scopeURL.pathname + 'icons/')) {
    if (req.headers.has('range')) return; // media seeking goes straight to the network
    if (req.mode === 'navigate' || /\/$|\.html?$/.test(url.pathname)) { e.respondWith(networkFirst(req, APPS, false)); return; }
    if (HASHED.test(url.pathname)) { e.respondWith(cacheFirst(req, APPS)); return; }
    e.respondWith(staleWhileRevalidate(req, APPS, e));
  }
});

// Network-first; app pages ignore the query (everything-items/args) when falling back to the cache.
async function networkFirst(req, name, shell) {
  const c = await caches.open(name);
  const key = shell ? req : stripQuery(req.url);
  try {
    const res = await fetch(req);
    if (res.ok && res.status === 200) c.put(key, res.clone()).catch(() => {});
    return res;
  } catch {
    return (await c.match(key, { ignoreSearch: true })) || (shell ? await c.match('index.html') : null) || offline();
  }
}
function stripQuery(u) { const x = new URL(u); x.search = ''; x.hash = ''; return x.href; }
async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()).catch(() => {}); return res; } catch { return Response.error(); }
}
async function staleWhileRevalidate(req, name, e) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: /everything-(items|args)/.test(new URL(req.url).search) });
  const net = fetch(req).then((res) => { if (res.ok && res.status === 200) c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
  if (hit) { e.waitUntil(net); return hit; }
  return (await net) || offline();
}
function offline() {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:15px system-ui;padding:40px;color:#444">You’re offline and this part of Everything Hub hasn’t been saved on this device yet. Open it once while online to use it offline.</body>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
