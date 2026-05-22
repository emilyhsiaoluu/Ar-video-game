// Mouth Munch — service worker.
// Bump VERSION when shipping app updates to invalidate old caches.
const VERSION = "mouth-munch-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./game.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(req, cacheName, fallback) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && (resp.ok || resp.type === "opaque")) {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    if (fallback) {
      const fb = await cache.match(fallback);
      if (fb) return fb;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // App shell — cache-first; if the network is gone too, fall back to index.html.
    event.respondWith(cacheFirst(req, SHELL_CACHE, "./index.html"));
  } else {
    // Third-party assets (MediaPipe library, WASM, model file) — cache-first too,
    // so the game keeps working without a connection after the first load.
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
  }
});
