/* Everything — service worker.
 * Shell: network-first with cache fallback (updates land, offline still works).
 * Apps & icons: stale-while-revalidate, cached lazily the first time each is opened.
 * Puter hosts: never contacted. js.puter.com is answered with the local shim. */
const VERSION = 'everything-v1-nolocal2';
const SHELL = `${VERSION}-shell`;
const APPS = `${VERSION}-apps`;
const FONTS = `${VERSION}-fonts`;
const SHELL_FILES = ['./', 'index.html', 'hub.css', 'hub.js', 'apps.json', 'puter-local.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-180.png', 'icon-32.png', 'fonts.css', 'fonts/InstrumentSerif-italic-latin-1.woff2', 'fonts/InstrumentSerif-italic-latin-ext-0.woff2', 'fonts/InstrumentSerif-normal-latin-3.woff2', 'fonts/InstrumentSerif-normal-latin-ext-2.woff2', 'fonts/Inter-normal-latin-5.woff2', 'fonts/Inter-normal-latin-ext-4.woff2'];
const PUTER = /(^|\.)(puter\.(com|work|site|app|io|dev)|puter-local\.invalid)$/i;
const TRACKERS = /(^|\.)(plausible\.io|google-analytics\.com|googletagmanager\.com|analytics\.google\.com|segment\.io|cdn\.segment\.com|mixpanel\.com|hotjar\.com|posthog\.com|sentry\.io)$/i;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const scopeURL = new URL(self.registration.scope);
const inShell = (url) => url.origin === scopeURL.origin && SHELL_FILES.some((f) => new URL(f, scopeURL).pathname === url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (PUTER.test(url.hostname)) {
    if (/^js\.puter\.com$/i.test(url.hostname)) {
      e.respondWith(caches.match(new URL('puter-local.js', scopeURL).href).then((r) => r || fetch(new URL('puter-local.js', scopeURL))).catch(() => new Response('', { headers: { 'content-type': 'text/javascript' } })));
    } else {
      e.respondWith(new Response(JSON.stringify({ success: false, error: { code: 'offline_local', message: 'Everything runs locally.' } }), { status: 503, headers: { 'content-type': 'application/json' } }));
    }
    return;
  }
  if (TRACKERS.test(url.hostname)) { e.respondWith(new Response(/\.js(\?|$)/.test(url.pathname) ? '' : null, { status: /\.js(\?|$)/.test(url.pathname) ? 200 : 204, headers: { 'content-type': 'text/javascript' } })); return; }
  if (req.method !== 'GET') return;
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { e.respondWith(cacheFirst(req, FONTS)); return; }
  if (url.origin !== scopeURL.origin) return;
  if (req.mode === 'navigate' && url.pathname === scopeURL.pathname || inShell(url)) { e.respondWith(networkFirst(req, SHELL)); return; }
  if (url.pathname.startsWith(scopeURL.pathname + 'apps/') || url.pathname.startsWith(scopeURL.pathname + 'icons/')) {
    if (req.headers.has('range')) return; // media seeking goes straight to the network
    e.respondWith(staleWhileRevalidate(req, APPS, e));
  }
});

async function networkFirst(req, name) {
  const c = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    return (await c.match(req, { ignoreSearch: true })) || (await c.match('index.html')) || Response.error();
  }
}
async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; } catch { return Response.error(); }
}
async function staleWhileRevalidate(req, name, e) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: new URL(req.url).search.includes('everything-items') });
  const net = fetch(req).then((res) => { if (res.ok && res.status === 200) c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
  if (hit) { e.waitUntil(net); return hit; }
  return (await net) || new Response('Offline', { status: 503 });
}
