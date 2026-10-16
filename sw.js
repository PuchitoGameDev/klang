/*
 * Service worker de KLANG (web).
 *
 * Objetivos:
 *  - Abrir la app **sin red** (el shell queda precargado).
 *  - Arranques repetidos mas rapidos (los assets con hash son inmutables).
 *  - Que un deploy nuevo no mezcle HTML nuevo con chunks viejos.
 *
 * No toca nada de otros origenes: el audio y los RPC viven en Supabase y no
 * deben pasar por aqui (ni cachearse).
 *
 * Estrategia:
 *  - Navegacion: red primero, sin cache HTTP; si no hay red se usa el shell
 *    cacheado. Asi un deploy nuevo nunca arranca con un index.html viejo.
 *  - `_expo/` y `assets/` (nombre con hash): cache primero.
 *  - Resto del mismo origen: red, con copia en cache cuando responde OK.
 */

/*
 * OJO: subir `VERSION` en cada publicacion. El hash del bundle principal no
 * siempre cambia (Metro reutiliza nombres de chunks), asi que la URL
 * `sw.js?v=<hash>` puede quedarse igual entre versiones. Cambiar el contenido
 * de este archivo es lo que garantiza que el navegador instale el worker nuevo,
 * borre la cache anterior y la app recargue con los bundles de este deploy.
 */
const VERSION = 'v9e370ecf9dcc';
const CACHE = `klang-${VERSION}`;
const SCOPE = self.registration ? self.registration.scope : self.location.href.replace(/sw\.js.*$/, '');
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

function scoped(path) {
  return new URL(path, SCOPE).href;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      // `cache: reload` evita guardar un index.html viejo que GitHub Pages
      // pudiera tener en la cache HTTP en el momento del deploy.
      await Promise.all(
        SHELL.map(async (path) => {
          try {
            const response = await fetch(scoped(path), { cache: 'reload' });

            if (response.ok) {
              await cache.put(scoped(path), response);
            }
          } catch {
            // Un asset opcional que falle no impide instalar el SW.
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();

      // `controllerchange` no siempre llega cuando el script tiene la misma
      // URL; este aviso hace que la app recargue una sola vez tras el deploy.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach((client) => client.postMessage({ type: 'KLANG_SW_ACTIVATED' }));
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
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
      (async () => {
        const cache = await caches.open(CACHE);
        const cached =
          (await cache.match(request)) ??
          (await cache.match(scoped('./index.html'))) ??
          (await cache.match(scoped('./')));

        const network = fetch(request, { cache: 'no-store' })
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void cache.put(scoped('./index.html'), copy);
            }
            return response;
          })
          .catch(() => null);

        // Red primero: el HTML nuevo es lo que enlaza los chunks nuevos. El
        // cache solo evita dejar la app sin abrir cuando no hay conexion.
        const response = await network;

        return response ?? cached ?? Response.error();
      })()
    );
    return;
  }

  if (isHashedAsset(url.pathname) || isSmallStatic(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        if (hit) {
          return hit;
        }

        return fetch(request, { cache: 'reload' }).then((response) => {
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