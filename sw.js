/* KAM PDFs service worker: caches the whole app so it works offline and can be installed as an app. */
const VERSION = 'kam-pdfs-v1.13.0';
// dict/en.txt and lib/ocr/* are deliberately not precached: they are large and only
// fetched when spell checking or OCR is first used, after which the fetch handler below
// keeps them for offline use.
const FILES = [
  './', 'index.html', 'scan.html', 'core.js', 'annot.js', 'ops.js', 'scan-core.js', 'scan-ui.js', 'scan-desktop.js',
  'spell.js', 'spell-ui.js', 'pdftext.js', 'pdftext-ui.js', 'ocr.js', 'ocr-ui.js', 'layers.js', 'autosave.js',
  'manifest.json', 'logo.svg', 'icons/icon-64.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/pdf-lib.min.js', 'lib/peerjs.min.js', 'lib/qrcode.min.js',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('message', e => { if (e.data && e.data.type === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const save = (req, res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; };
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  // Branding files change independently of the app code, and version.json is how the app
  // learns that a newer release exists. Always try the network for these, so an installed app
  // can never pick up stale artwork or be told it is current when it is not, and fall back to
  // the cache when offline.
  if (/\/icons\/|manifest\.json$|version\.json$|logo\.(svg|ico)$/.test(new URL(e.request.url).pathname)) {
    e.respondWith(fetch(e.request).then(res => save(e.request, res))
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true })
    .then(hit => hit || fetch(e.request).then(res => save(e.request, res))));
});
