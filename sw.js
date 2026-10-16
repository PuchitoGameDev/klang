/*
 * Service worker de KLANG (web).
 *
 * Objetivos:
 *  - Abrir la app **sin red** (el shell queda precargado).
 *  - Arranques repetidos mas rapidos (los assets con hash son inmutables).
 *
 * No toca nada de otros origenes: el audio y los RPC viven en Supabase y no
 * deben pasar por aqui (ni cachearse).
 *
 * Estrategia:
 *  - Navegacion: red primero (asi un deploy nuevo se ve al instante) y, si no
 *    hay red, `index.html` de cache.
 *  - `_expo/` y `assets/` (nombre con hash): cache primero.
 *  - Resto del mismo origen: red, con copia en cache cuando responde OK.
 */

const VERSION = 'v1';
const CACHE = `klang-${VERSION}`;
const SCOPE = self.registration ? self.registration.scope : self.location.href.replace(/sw\.js.*$/, '');
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isHashedAsset(pathname) {
  return /\/_expo\//.test(pathname) || /\/assets\//.test(pathname);
}

function isSmallStatic(pathname) {
  return /\.(?:css|js|png|jpe?g|webp|svg|ico|woff2?|webmanifest)$/i.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Otros origenes (Supabase, audio, portadas remotas): sin tocar.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Rango (audio con seek) o peticiones del propio SW: sin cache.
  if (request.headers.has('range') || url.pathname.endsWith('/sw.js')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(new URL('./index.html', SCOPE), copy));
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(request)) ??
            (await cache.match(new URL('./index.html', SCOPE))) ??
            (await cache.match(new URL('./', SCOPE))) ??
            Response.error()
          );
        })
    );
    return;
  }

  if (isHashedAsset(url.pathname) || isSmallStatic(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        if (hit) {
          return hit;
        }

        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
  }
});
