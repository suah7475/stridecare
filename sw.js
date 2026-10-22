/* StrideCare service worker — 오프라인 앱 셸.
 * 같은 출처의 앱 셸은 네트워크 우선, 실패 시 캐시로 폴백합니다.
 * 측정 데이터는 IndexedDB/localStorage에만 저장되며 서비스 워커가 전송하지 않습니다.
 */
const VERSION = 'stridecare-v4';
const APP_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/session.js',
  './js/store.js',
  './js/charts.js',
  './js/calibrate.js',
  './js/benchmark.js',
  './js/core/detector.js',
  './js/core/dsp.js',
  './js/core/simulator.js',
  './js/core/stats.js',
  './assets/icon.svg',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('stridecare-') && !key.startsWith(VERSION))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    // Pretendard CDN 등 외부 정적 자원은 캐시 우선으로 재사용합니다.
    if (request.destination === 'style' || request.destination === 'font') {
      event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    }
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigate(request));
    return;
  }

  event.respondWith(networkFirst(request, APP_CACHE, RUNTIME_CACHE));
});

async function networkFirstNavigate(request) {
  const cache = await caches.open(APP_CACHE);
  const cached = (await cache.match(request)) || (await cache.match('./index.html'));
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put('./index.html', response.clone());
      return response;
    }
    // Captive portals and some offline proxies answer with a synthetic error
    // response instead of rejecting the promise. Prefer the cached shell.
    if (cached) return cached;
    return response;
  } catch {
    return cached || new Response('오프라인 상태입니다. 앱을 다시 열어 주세요.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function networkFirst(request, shellCacheName, runtimeCacheName) {
  const cache = await caches.open(shellCacheName);
  const cached = (await cache.match(request)) ||
    (await caches.open(runtimeCacheName).then((runtime) => runtime.match(request)));
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
      return response;
    }
    if (response && response.status >= 400 && response.status < 500) {
      return response;
    }
    if (cached) return cached;
    return new Response('', { status: response?.status || 504, statusText: 'Offline' });
  } catch {
    if (cached) return cached;
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}
