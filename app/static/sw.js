const CACHE_NAME = 'campusflow-shell-v17';
const APP_SHELL = [
  '/',
  '/download',
  '/static/styles.css?v=7',
  '/static/offline.css?v=1',
  '/static/schedule.css?v=3',
  '/static/campus.css?v=3',
  '/static/settings.css?v=1',
  '/static/pwa.css?v=1',
  '/static/download.css?v=1',
  '/static/offline.js?v=1',
  '/static/app.js?v=23',
  '/static/routine.css?v=1',
  '/static/planning.css?v=1',
  '/static/pdf-reader.css?v=5',
  '/static/manifest.webmanifest',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/')) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(response => {
      if (response.ok && response.type === 'basic') caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => cached);
    return cached || network;
  })());
});
