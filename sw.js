/* BrowserDJ service worker: keeps the studio working offline.
   Online, every request goes to the network first, so a new version shows up on the next visit; the copy that
   comes back is kept. Offline, the kept copy is used. The app files are fetched once at install, so the whole
   studio (examples included) works offline after the first visit. Fonts come from Google and are kept the same way.
   SHELL must list every file index.html loads: test/engine.test.js checks that. */
const CACHE = 'browserdj-v3';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'favicon.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'examples/examples.js',
  'js/engine.js',
  'js/sound.js',
  'js/samples.js',
  'js/library.js',
  'js/project.js',
  'js/pianoroll.js',
  'js/drums.js',
  'js/playlist.js',
  'js/mixer.js',
  'js/live.js',
  'js/beatbox.js',
  'js/midiimport.js',
  'js/share.js',
  'js/tour.js',
  'js/agent.js',
  'js/app.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('browserdj-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mine = url.origin === self.location.origin;
  if (!mine && !FONTS.test(req.url)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      // a page visit (with or without a #share link) gets the studio itself
      const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
