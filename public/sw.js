/* Carte di Casa: l'app si apre subito anche quando il server dorme o manca internet.
   I file dell'app stanno in cache; /api e /entra vanno sempre in rete. */
const VERSION = 'cdc-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/regole.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'cdc-fonts').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // caratteri di Google: dalla cache appena possibile
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open('cdc-fonts').then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') c.put(req, res.clone());
          return res;
        } catch (e) {
          return new Response('', { status: 504 }); // senza internet si usa il carattere del telefono
        }
      })
    );
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/entra') return;

  // pagine: la versione in cache subito, poi si aggiorna in silenzio
  const key = req.mode === 'navigate' ? '/index.html' : req;
  event.respondWith(
    caches.open(VERSION).then(async (c) => {
      const hit = await c.match(key);
      const update = fetch(req)
        .then((res) => {
          if (res.ok) c.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(update);
        return hit;
      }
      const res = await update;
      return res || new Response('Sei senza internet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })
  );
});
