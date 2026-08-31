const CACHE_BUILD = "videoflow-pwa9";
const BASE = new URL("./", self.registration.scope);
const appUrl = (path) => new URL(path, BASE).href;
const CORE_SHELL = [
  appUrl("./"),
  appUrl("manifest.webmanifest"),
  appUrl("favicon.svg"),
  appUrl("precache-manifest.json"),
  appUrl("vendor/ffmpeg/ffmpeg-core.js"),
  appUrl("vendor/ffmpeg/ffmpeg-core.wasm"),
];
const isProtectedCache = (key) => key.startsWith("videoflow-ai-");

async function generatedShell() {
  try {
    const response = await fetch(appUrl("precache-manifest.json"), { cache: "no-store" });
    if (!response.ok) return [];
    const entries = await response.json();
    return Array.isArray(entries) ? entries.map((entry) => appUrl(String(entry).replace(/^\.\//, ""))) : [];
  } catch {
    return [];
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_BUILD);
    const generated = await generatedShell();
    await cache.addAll([...new Set([...CORE_SHELL, ...generated])]);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_BUILD && !isProtectedCache(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(
      (cached) => cached || fetch(event.request)
        .then((response) => {
          if (response.ok && !event.request.url.startsWith("blob:") && !/\/models\/.*\.onnx(?:$|\?)/i.test(event.request.url)) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_BUILD).then((cache) => cache.put(event.request, copy)));
          }
          return response;
        })
        .catch(() => caches.match(appUrl("./"))),
    ),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
