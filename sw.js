/**
 * Offline support for the installed app.
 *
 * Bump VERSION on every deploy: the old cache is dropped on activate, so
 * clients pick up new code on their next launch.
 */

const VERSION = 'v2';
const CACHE = `vietlott-${VERSION}`;

// Relative to the service worker's own location, so this works unchanged at a
// domain root and under a GitHub Pages project subpath.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/config.js',
  './js/store.js',
  './js/crawler.js',
  './js/rng.js',
  './js/strategies.js',
  './js/stats.js',
  './js/backtest.js',
  './js/chart.js',
  './js/keno.js',
  './data/power655.jsonl',
  './data/power645.jsonl',
  './data/power535.jsonl',
  './icons/favicon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // A single missing file must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || network.then((res) => res || Promise.reject(new Error('offline')));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The crawl proxy is live-only: never cache it, and let it fail naturally
  // when no local server is running so the app falls back to its other sources.
  if (url.pathname.includes('/api/')) return;

  // Navigations: fresh when online, the cached shell when not.
  if (request.mode === 'navigate') {
    event.respondWith(
      networkFirst(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Draw data (local snapshot or the upstream repo) should be as new as
  // possible, with the last copy as the offline fallback.
  if (url.pathname.endsWith('.jsonl') || url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
