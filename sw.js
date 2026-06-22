/* eslint-disable no-restricted-globals */
'use strict';

const VERSION = '20260622f';
const SHELL = 'miso-dashboard-shell-' + VERSION;
const CDN = 'miso-dashboard-cdn-' + VERSION;

const PRECACHE = [
  '/',
  '/index.html',
  '/miso-logo.svg',
  '/metrics.js',
  '/miso-api.js',
  '/miso-sheets.js',
  '/idb-sync.js',
  '/pwa-register.js',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith('miso-dashboard-') && k !== SHELL && k !== CDN).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isCdnRequest(url) {
  return url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com');
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/api/')) return;

  if (isCdnRequest(url)) {
    event.respondWith(
      caches.open(CDN).then(async (cache) => {
        const cached = await cache.match(event.request);
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return cached || res;
        } catch (_) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html').then((m) => m || caches.match('/'))
      )
    );
    return;
  }

  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || network.then((r) => r || caches.match('/index.html'));
    })
  );
});
