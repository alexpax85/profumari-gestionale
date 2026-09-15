// Service worker: tiene una copia dei file dell'app così si apre anche senza rete.
// Strategia "prima la rete": se la rete risponde si usa (e si aggiorna la copia), altrimenti la copia salvata.
const CACHE = 'profumari-app-v1';
const PRECARICA = ['./', './index.html', './style.css', './manifest.json', './logo.svg', './favicon.svg',
  './js/app.js', './js/store.js', './js/store-firebase.js', './js/normalizza.js', './js/config.js',
  './fonts/assistant.css', './fonts/assistant-latin.woff2', './lib/xlsx.full.min.js',
  './lib/firebase/firebase-app.js', './lib/firebase/firebase-auth.js', './lib/firebase/firebase-firestore.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(PRECARICA.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(r => {
      if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
      return r;
    }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
