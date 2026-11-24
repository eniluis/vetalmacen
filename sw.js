const CACHE_NAME = 'vetalmacen-v7';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './js/config.js?v=6',
    './js/auth.js?v=6',
    './js/scanner.js?v=6',
    './js/inventory.js?v=6',
    './js/ui.js?v=6',
    './js/app.js?v=6'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.url.includes('supabase.co')) return;

    // Intenta traer siempre lo más nuevo de la red; si no hay señal en el rancho, usa la caché
    event.respondWith(
        fetch(event.request)
        .then((networkResponse) => {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
});