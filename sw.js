// Service worker: l'app si apre anche offline (i dati li gestisce la cache di Firestore).
const CACHE = 'nina-v10';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'firebase-config.js', 'lista.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png', 'img/bg-portrait.jpg', 'img/bg-landscape.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const cacheable = url.origin === location.origin || url.hostname === 'www.gstatic.com' ||
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!cacheable) return; // le chiamate a Firestore/Auth passano dirette
  // stale-while-revalidate
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: url.origin === location.origin });
    const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; })
      .catch(() => hit || (req.mode === 'navigate' ? cache.match('index.html') : undefined));
    return hit || net;
  }));
});
