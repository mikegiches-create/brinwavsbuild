/**
 * service-worker.js
 *
 * Caching strategy:
 *  - Shell assets (JS/CSS bundles, HTML) → Cache First, update in background
 *  - Car images (Unsplash, CDN)          → Cache First with 30-day expiry
 *  - API / dynamic data                  → Network First (stale-while-revalidate)
 *
 * Place this file in your project's /public folder (next to index.html).
 * Register it from main.jsx / index.js (see registration snippet below).
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE   = `brinwavscar-shell-${CACHE_VERSION}`;
const IMAGE_CACHE   = `brinwavscar-images-${CACHE_VERSION}`;

// Assets to pre-cache on install (update paths to match your Vite build output)
const SHELL_ASSETS = [
  '/',
  '/index.html',
  // Vite injects hashed filenames at build time; add them here if known,
  // or rely on the runtime caching below.
];

// ─── Install: pre-cache shell ─────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

// ─── Activate: delete old caches ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  const KEEP = [SHELL_CACHE, IMAGE_CACHE];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// ─── Fetch: route requests ────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and browser-extension requests
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // ── Images (Unsplash, your CDN, /assets/cars/) → Cache First ────────────
  const isImage =
    request.destination === 'image' ||
    url.hostname.includes('unsplash.com') ||
    url.pathname.startsWith('/assets/cars/');

  if (isImage) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE, 30));
    return;
  }

  // ── JS/CSS/fonts → Cache First ───────────────────────────────────────────
  const isStaticAsset = /\.(js|css|woff2?|ttf|otf)(\?.*)?$/.test(url.pathname);
  if (isStaticAsset) {
    event.respondWith(cacheFirst(request, SHELL_CACHE, 7));
    return;
  }

  // ── HTML / navigation → Network First (offline fallback to shell) ────────
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // Everything else: network only
});

// ─── Strategies ───────────────────────────────────────────────────────────────

/**
 * Cache First with expiry (days).
 * Returns the cached response if fresh; otherwise fetches, caches, and returns.
 */
async function cacheFirst(request, cacheName, maxAgeDays = 7) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);

  if (cached) {
    const cachedDate = cached.headers.get('sw-cached-at');
    const age = cachedDate
      ? (Date.now() - Number(cachedDate)) / 86_400_000
      : 0;

    if (age < maxAgeDays) return cached;
    // Stale — fetch fresh in background, return stale now
    fetchAndCache(request, cache).catch(() => {});
    return cached;
  }

  return fetchAndCache(request, cache);
}

/**
 * Network First with cache fallback.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached ?? new Response('Offline', { status: 503 });
  }
}

/**
 * Fetch from network, stamp with a timestamp header, and store in cache.
 */
async function fetchAndCache(request, cache) {
  const response = await fetch(request);
  if (!response.ok) return response;

  // Clone and inject a custom timestamp header (service workers can't modify
  // response headers directly, so we build a new Response).
  const headers = new Headers(response.headers);
  headers.set('sw-cached-at', String(Date.now()));

  const body   = await response.arrayBuffer();
  const stamped = new Response(body, { status: response.status, headers });

  cache.put(request, stamped.clone());
  return stamped;
}