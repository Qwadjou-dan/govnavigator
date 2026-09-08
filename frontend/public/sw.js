/* GovNavigator Ghana — service worker for offline reading.
 *
 * The core promise: guidance you have already seen stays readable without a
 * signal. Someone checks a requirement before travelling, loses the network,
 * and still wants the checklist. Bump VERSION whenever this file changes so
 * the caches are rebuilt.
 */
const VERSION = 'v2';
const SHELL = `gn-shell-${VERSION}`; // own-origin app shell + static assets
const API = `gn-api-${VERSION}`;     // visited service data (cross-origin GET)

const PRECACHE = ['/', '/services', '/institutions'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('gn-') && k !== SHELL && k !== API).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isCrossOrigin(request) {
  try {
    return new URL(request.url).origin !== self.location.origin;
  } catch {
    return false;
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      // Cache a copy; the response we return stays independent of the cached one.
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Nothing cached and offline: fall back to the app shell so the person
    // still gets the UI rather than a dead network error.
    if (request.mode === 'navigate') return caches.match('/');
    throw new Error('offline and not cached');
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch POST/other

  // Visited guidance from the API (cross-origin): network-first, cache on
  // success, fall back to the cached copy when offline.
  if (isCrossOrigin(request)) {
    event.respondWith(networkFirst(request, API));
    return;
  }

  // App navigation: network-first so the live page always wins, cached shell
  // as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL));
    return;
  }

  // Static assets (JS/CSS/images/fonts): cache-first — these never change
  // between builds and are what make the offline shell render at all.
  if (request.destination === 'script' || request.destination === 'style' ||
      request.destination === 'image' || request.destination === 'font') {
    event.respondWith(cacheFirst(request, SHELL));
  }
});
