// Service worker ajoutant les en-têtes COOP/COEP à toutes les réponses
// de même origine : rend la page « cross-origin isolated » (SharedArrayBuffer)
// même sur un hébergement statique qui ne permet pas de les configurer
// (GitHub Pages…). Tous les fichiers du site sont locaux : aucune ressource
// externe n'est bloquée.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const res = await fetch(req);
    if (res.status === 0) return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  })());
});
