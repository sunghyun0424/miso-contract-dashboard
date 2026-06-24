/* eslint-disable no-restricted-globals */
'use strict';

const VERSION = '20260624c';
const SHELL = 'miso-dashboard-shell-' + VERSION;
const CDN = 'miso-dashboard-cdn-' + VERSION;

/** JS는 precache 안 함 — 구버전 캐시로 API URL 꼬임 방지 */
const PRECACHE = ['/', '/index.html', '/miso-logo.svg', '/manifest.webmanifest'];

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

function isAppScript(pathname) {
  return /\.(js|webmanifest)$/.test(pathname);
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

  if (isAppScript(url.pathname)) {
    event.respondWith(
      fetch(event.request).then((res) => {
        if (res.ok) {
          caches.open(SHELL).then((cache) => cache.put(event.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match(event.request).then((m) => m || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(event.request);
      try {
        const res = await fetch(event.request);
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      } catch (_) {
        return cached || Response.error();
      }
    })
  );
});
