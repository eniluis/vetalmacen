const CACHE_NAME = 'vetalmacen-v1';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './js/config.js',
    './js/auth.js',
    './js/scanner.js',
    './js/inventory.js',
    './js/ui.js'
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
    // No cachear peticiones a la API de Supabase para tener siempre stock real
    if (event.request.url.includes('supabase.co')) return;

    event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
});