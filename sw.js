// Service worker di Addon Manager: l'interfaccia si apre anche senza rete.
//
// - Gestisce SOLO richieste GET dello stesso sito. Le API di Stremio e Nuvio e i manifest degli addon
//   stanno su altri domini: non passano da qui, non vengono modificati né salvati.
// - "Rete prima, cache poi": online si ricevono sempre i file più recenti (e la copia si aggiorna);
//   offline, o con una rete lentissima, si usa l'ultima copia. Nessuna versione vecchia "incastrata".
// - Nella cache finiscono solo file statici pubblici dell'app (nessun dato dell'utente).
//
// L'elenco SHELL va tenuto allineato ai file dell'app: un test (tests/unit.test.mjs) lo verifica.

const CACHE = 'addon-manager-v2';
const NETWORK_TIMEOUT_MS = 6000;

const SHELL = [
  './',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/backup.js',
  'js/convert.js',
  'js/i18n.js',
  'js/locales/it.js',
  'js/install.js',
  'js/main.js',
  'js/manifest.js',
  'js/model.js',
  'js/nuvio.js',
  'js/store.js',
  'js/stremio.js',
  'js/util.js',
  'js/ui/dialogs.js',
  'js/ui/dom.js',
  'js/ui/install-ui.js',
  'js/ui/theme.js',
  'js/ui/views.js',
  'img/logo.svg',
  'img/nuvio.png',
  'img/stremio.png',
  'img/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' = si scaricano le copie fresche, non quelle della cache HTTP del browser
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('addon-manager-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function fetchWithTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function networkFirst(event, request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    // Le risposte reindirizzate non si salvano: Chrome non le accetta come risposta a una navigazione.
    if (response.ok && response.type === 'basic' && !response.redirected) event.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./');
      if (shell) return shell;
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(event, request));
});
