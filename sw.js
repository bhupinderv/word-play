// Woordjes offline support.
// Bump VERSION whenever you change any file, so phones pick up the new copy.
const VERSION = 'woordjes-v4';
const CORE = [
  './',
  './index.html',
  './live.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only the game's own files, Google Fonts and the Firebase library are cached.
// Live Firebase traffic (sign-in, database) always goes straight to the network.
function cacheable(url){
  return url.origin === self.location.origin
    || url.hostname === 'fonts.googleapis.com'
    || url.hostname === 'fonts.gstatic.com'
    || (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || !cacheable(new URL(req.url))) return;

  // Pages: newest version when online, saved copy when offline.
  if (req.mode === 'navigate'){
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok){ const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); }
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else: serve from the cache straight away, refresh it in the background.
  event.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    if (cached) { event.waitUntil(fresh); return cached; }
    return fresh;
  }));
});
