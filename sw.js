/* Interval Chime service worker: offline app shell, no network calls of its own. */
var VERSION = 'interval-chime-v12';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Stale-while-revalidate for same-origin GETs; navigations fall back to the cached shell.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // promo/ is a separate static demo. Do not cache it and do not answer its
  // navigations with the app shell.
  if (url.pathname.indexOf('/promo/') !== -1 || /\/promo\/?$/.test(url.pathname)) return;
  var isNav = req.mode === 'navigate';
  // The shell must not stay stale after a new worker activates. Network first
  // for the page and its script/style; the precache is the offline fallback.
  var path = url.pathname;
  var isShell = isNav || /\/(index\.html|app\.js|styles\.css|sw\.js)$/.test(path);
  if (isShell) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(VERSION).then(function (cache) { cache.put(isNav ? './index.html' : req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.open(VERSION).then(function (cache) {
        return cache.match(isNav ? './index.html' : req, { ignoreSearch: true });
      }).then(function (hit) { return hit || new Response('Offline', { status: 503 }); });
    }));
    return;
  }
  e.respondWith(caches.open(VERSION).then(function (cache) {
    var key = isNav ? './index.html' : req;
    return cache.match(key, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') cache.put(isNav ? './index.html' : req, res.clone());
        return res;
      }).catch(function () { return hit; });
      if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
      return net.then(function (res) { return res || new Response('Offline', { status: 503 }); });
    });
  }));
});
