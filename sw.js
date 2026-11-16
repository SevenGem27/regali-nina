// Service worker: prima prova la rete (versione sempre aggiornata), senza rete usa la copia salvata.
const CACHE = 'nina-v14';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'firebase-config.js', 'lista.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png', 'img/bg-portrait.jpg', 'img/bg-landscape.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // file dell'app: rete prima, copia salvata se offline
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : undefined)));
    return;
  }
  if (url.hostname === 'www.gstatic.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    // librerie e caratteri: copia salvata, aggiornata in background
    e.respondWith(caches.open(CACHE).then(async cache => {
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
  // tutto il resto (Firebase) passa diretto
});
