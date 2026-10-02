// sw.js - the service worker: what makes this installable, and what makes it work with
// no signal at all.
//
// The app shell is cached on install, so opening the app never waits on the network. The
// notes themselves are not fetched over the network at all - they live in localStorage and
// go to OneDrive only when you sync - so "offline" here means genuinely everything except
// syncing.
//
// Bump CACHE when the shell changes; the old one is thrown away on activate.

const CACHE = 'sticky-shell-v1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './notes.js', './store.js',
  './sync.js', './graph.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // addAll fails the whole install if one file 404s; add them one by one instead so a
    // missing extra never stops the app from installing.
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;              // Graph and MSAL: straight to the network

  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(async (res) => {
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    }).catch(() => null);
    // cache first so the app opens instantly, then quietly refresh it for next time
    if (cached) { fresh; return cached; }
    const res = await fresh;
    if (res) return res;
    // offline and never cached: at least give the app shell back for a navigation
    if (e.request.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
    return Response.error();
  })());
});

// Tapping an alarm notification should bring the note up, not open a second window.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.noteId;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.registration.scope)) {
        c.postMessage({ type: 'open-note', id });
        return c.focus();
      }
    }
    return self.clients.openWindow('./' + (id ? '?open=' + encodeURIComponent(id) : ''));
  })());
});
