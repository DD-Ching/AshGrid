// AshGrid service worker — basic offline shell.
// Strategy split:
//   index.html / manifest        → NETWORK-FIRST (so the user always
//                                  sees the latest version after we
//                                  push; falls back to cache only
//                                  when offline)
//   ONNX models / icons / wasm   → CACHE-FIRST (those rarely change
//                                  and are the bulk of bandwidth)
//
// Cache version is the install timestamp suffix so every new build
// gets a fresh cache and old caches are evicted on activate. If you
// add files to ASSETS, bump the suffix or the precache will not run
// (skipWaiting + clients.claim makes the new SW take over instantly).
// Bump suffix any time JS / asset wiring changes meaningfully — old SW
// will evict its cache on `activate` (see below) and the new SW will
// network-first /js/* to avoid the cache-first staleness that bit users
// during Phase 4–10 (player console showed `ARENA_SEED_MAX is not
// defined` because cached arena_recruitment.js predated the SEED block).
const CACHE = 'ashgrid-v71-nonn-actually-removes-2026-05-14';
const ASSETS = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './ai_arena/onnx/model_easy.onnx',
  './ai_arena/onnx/model_medium.onnx',
  './ai_arena/onnx/model_hard.onnx',
  './ai_arena/onnx/model_evolved.onnx',
  './ai_arena/onnx/model_elite.onnx',
  './ai_arena/onnx/model_norespawn.onnx',
  './ai_arena/onnx/model_warrior.onnx',
  './ai_arena/onnx/model_sharpshooter.onnx',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => null))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // Network-first for HTML / manifest / sw.js itself — guarantees fresh
  // app shell on every reload while we still ship a working offline mode.
  // Network-first ALSO for /js/* — these change every commit and the
  // previous cache-first behaviour caused 'X is not defined' errors when
  // a freshly-pushed JS file kept getting the stale cached copy. ONNX
  // models, icons, sound assets stay cache-first below (they're big and
  // rarely change).
  const isHTML = url.pathname === '/' ||
                 url.pathname.endsWith('/') ||
                 url.pathname.endsWith('.html') ||
                 url.pathname.endsWith('.webmanifest') ||
                 url.pathname.endsWith('sw.js') ||
                 url.pathname.startsWith('/js/') ||
                 url.pathname.endsWith('.js');
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }
  // Cache-first for everything else (ONNX, icons, sounds)
  e.respondWith(
    caches.match(e.request).then(
      (hit) => hit || fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
