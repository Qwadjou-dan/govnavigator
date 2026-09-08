/* GovNavigator Ghana — service worker for offline reading.
 *
 * The core promise: guidance you have already seen stays readable without a
 * signal. Someone checks a requirement before travelling, loses the network,
 * and still wants the checklist. Bump VERSION whenever this file changes so
 * the caches are rebuilt.
 */
const VERSION = 'v7';
const SHELL = `gn-shell-${VERSION}`; // own-origin app shell + static assets
// Visited service data (cross-origin GET). Deliberately unversioned: the page
// writes here too (`api.ts`), and data is network-first with the cache used
// only offline — so version-busting it would break the page↔SW link on redeploy.
const API = 'gn-api';

const PRECACHE = ['/', '/services', '/institutions'];

// Cross-origin list endpoints the shell needs on every paint. The page tells us
// the API base after registering (the SW can't read build-time env vars), then
// we prime them so the home/services pages work offline even if the person has
// only ever opened the home page. Tolerant of failures: one endpoint being down
// must not block activation.
const LIST_ENDPOINTS = ['/system', '/services', '/categories', '/institutions'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// The page posts its API base here just after registration, so we can move the
// shell's list data into the API cache before anyone goes offline. Cached under
// the exact request the fetch handler matches against (base + endpoint).
self.addEventListener('message', (event) => {
  const { type, base } = event.data ?? {};
  if (type !== 'GN_PRIME_LISTS' || typeof base !== 'string' || !base) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(API);
      await Promise.allSettled(
        LIST_ENDPOINTS.map(async (endpoint) => {
          const url = base.replace(/\/$/, '') + endpoint;
          const fresh = await fetch(url);
          if (fresh && fresh.ok) await cache.put(new Request(url), fresh.clone());
        }),
      );
    })(),
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

// The chunks a hydrated page needs (`/_next/static/...`). Caching a page's HTML
// alone leaves the JS that makes it interactive uncached — an offline reload
// would show the shell but crash hydration. Grab every referenced asset too.
function staticAssetUrlsFrom(html) {
  const urls = new Set();
  const re = /(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && m[1]) urls.add(m[1]);
  return [...urls];
}

// cache.match() applies Vary-based matching: the backend's CORS headers put a
// Vary on responses, and a request stored from a stripped Request(url) won't
// match the page's real fetch. To survive offline we also scan cache keys by
// URL alone and return the exact entry stored.
async function matchByUrl(cache, request) {
  const want = new URL(request.url).href;
  const keys = await cache.keys();
  for (const key of keys) {
    if (new URL(key.url).href === want) return cache.match(key);
  }
  return undefined;
}

async function lookupCached(cache, request) {
  // Vary-aware match first, then the URL-only scan (see matchByUrl) — the two
  // together cover cached entries whether the storing request matched headers
  // or not.
  const hit = await cache.match(request);
  if (hit) return hit;
  return matchByUrl(cache, request);
}

// Store a response under both the real request (so a Vary-aware match works
// later) and a stripped URL key (so the URL-only scan finds it even when the
// later request sends different headers or none at all).
async function storeResponse(cache, request, response) {
  try {
    await cache.put(request, response.clone());
    await cache.put(new Request(request.url), response.clone());
  } catch {
    /* body already consumed or opaque — the network result still goes through */
  }
}

// API data (cross-origin GET): stale-while-revalidate. Serve whatever is cached
// immediately — the whole point of this app is that guidance you have already
// seen must stay readable without a signal — then refresh it in the background
// so the next visit is either fresh or cached-still.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(API);
  const cached = await lookupCached(cache, request);

  const network = fetch(request).then(async (fresh) => {
    if (fresh && fresh.ok) await storeResponse(cache, request, fresh);
    return fresh;
  });

  if (cached) {
    // Don't block the page on the refresh; a failure (or an offline fetch that
    // never rejects) must not hang the UI.
    network.catch(() => {});
    return cached;
  }
  // No cache yet: wait for the network, but bound it — an unreachable backend
  // must fail cleanly, not leave the skeleton up forever. Generous because the
  // free Render instance cold-starts (~15s) on idle; a tight bound would paint
  // the list empty for a person whose backend was just waking up.
  return Promise.race([
    network,
    new Promise((_, reject) => setTimeout(() => reject(new Error('offline and not cached')), 25000)),
  ]);
}

// App navigation: network-first so the live page always wins, cached shell as
// the offline fallback. Caches the page's JS/CSS chunks too so an offline
// reload can actually hydrate, not just show dead HTML.
async function navigateFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      await cache.put(request, fresh.clone());
      const html = await fresh.clone().text();
      await Promise.allSettled(
        staticAssetUrlsFrom(html).map(async (url) => {
          if (await cache.match(url)) return;
          const asset = await fetch(url);
          if (asset && asset.ok) await cache.put(new Request(url), asset.clone());
        }),
      );
    }
    return fresh;
  } catch {
    const cached = await lookupCached(cache, request);
    if (cached) return cached;
    return caches.match('/');
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await lookupCached(cache, request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) await storeResponse(cache, request, fresh);
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch POST/other

  // Visited guidance from the API (cross-origin): stale-while-revalidate —
  // serve the copy you have seen before instantly, refresh in the background.
  if (isCrossOrigin(request)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // App navigation: network-first so the live page always wins, cached shell
  // as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(navigateFirst(request));
    return;
  }

  // Static assets (JS/CSS/images/fonts/manifest): cache-first — these never
  // change between builds and are what make the offline shell render at all.
  if (request.destination === 'script' || request.destination === 'style' ||
      request.destination === 'image' || request.destination === 'font' ||
      request.destination === 'manifest') {
    event.respondWith(cacheFirst(request, SHELL));
  }
});
