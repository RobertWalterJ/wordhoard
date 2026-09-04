/* Wordhoard service worker.

   Network-first with a cache fallback, plus a full precache at install.
   Cache-first would be marginally faster, but it pins whatever was cached the
   first time -- you would keep running old code until the cache name changed.
   Network-first means the app is current whenever the server is reachable and
   works completely offline when it is not, which is the point of installing it:
   a vocabulary round on the subway should not need a signal. */
const CACHE = 'wordhoard-v1';
const ASSETS = [
  '.',
  'index.html',
  'styles.css',
  'fonts.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/ability.js',
  'js/data.js',
  'js/modes.js',
  'js/store.js',
  'data/en/words.json',
  'data/en/estimator.json',
  'data/en/confusables.json',
  'data/en/meta.json',
  'fonts/literata-latin-normal-400.woff2',
  'fonts/literata-latin-normal-600.woff2',
  'fonts/literata-latin-italic-400.woff2',
  'fonts/literata-latin-ext-normal-400.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit
        || caches.match('index.html')
        || new Response('Offline and not cached yet.', { status: 503 })))
  );
});
