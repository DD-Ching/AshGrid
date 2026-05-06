// AshGrid service worker — basic offline shell.
// Cache index.html + ONNX models + icons on install. On fetch, prefer cache
// for game assets, fall through to network for everything else.
const CACHE = 'ashgrid-v1';
const ASSETS = [
  './',
  './index.html',
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
  // Same-origin GET only — pass cross-origin (e.g. CDN ort wasm) through.
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) => hit || fetch(e.request).then((res) => {
        // Lazily cache new same-origin assets we serve.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
