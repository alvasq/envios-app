// Service Worker - EnviosApp
const CACHE_NAME = 'enviosapp-v3';
const URLS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js'
];

// Instalar: cachear archivos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(URLS_TO_CACHE))
  );
  self.skipWaiting();
});

// Activar: limpiar caches viejos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache first, luego red
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        // Cachear respuestas exitosas de Firebase CDN para futuro offline
        if (response.ok && event.request.url.includes('gstatic.com/firebasejs')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Si es navegacion, devolver index.html del cache
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
