/* KAM PDFs service worker: caches the whole app so it works offline and can be installed as an app. */
const VERSION = 'kam-pdfs-v1.5.0';
const FILES = [
  './', 'index.html', 'scan.html', 'core.js', 'annot.js', 'ops.js', 'scan-core.js', 'scan-ui.js', 'scan-desktop.js',
  'manifest.json', 'logo.svg', 'icons/icon-64.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/pdf-lib.min.js', 'lib/peerjs.min.js', 'lib/qrcode.min.js',
  'examples/demo.js',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  })));
});
