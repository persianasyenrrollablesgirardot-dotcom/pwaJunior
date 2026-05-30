/**
 * Service Worker mínimo para PWA Junior.
 *
 * No es offline-first (la app necesita Supabase + DeepSeek). Solo cachea los
 * assets estáticos del shell para arranque rápido + permite "Add to Home Screen"
 * en iOS/Android. Si querés agregar offline más adelante, sumar runtime caching
 * para Supabase REST y queue de writes con Background Sync.
 */
const CACHE = 'junior-v1';
const PRECARGA = ['/junior', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECARGA).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))),
    ),
  );
  self.clients.claim();
});

// Network-first para todo. Si falla la red, intentar cache (solo cubre shell).
// NO cachear /api/* (siempre fresco — son llamadas con datos del momento).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // bypass
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Cachear el shell del PWA (HTML, JS, CSS, manifest, íconos).
        if (res.ok && (url.pathname === '/junior' || /\.(js|css|svg|png|json)$/.test(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
