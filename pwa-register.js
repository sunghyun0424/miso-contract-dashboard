'use strict';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            console.info('[PWA] 새 버전 사용 가능 — 새로고침하세요.');
          }
        });
      });
    }).catch((err) => console.warn('[PWA] Service Worker 등록 실패:', err));
  });
}
