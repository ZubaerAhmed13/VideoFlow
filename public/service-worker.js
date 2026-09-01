const CACHE_BUILD = "videoflow-pwa10-coi";
const BASE = new URL("./", self.registration.scope);
const appUrl = (path) => new URL(path, BASE).href;
const CORE_SHELL = [
  appUrl("./"),
  appUrl("manifest.webmanifest"),
  appUrl("favicon.svg"),
  appUrl("coi-bootstrap.js"),
  appUrl("precache-manifest.json"),
  appUrl("vendor/ffmpeg/ffmpeg-core.js"),
  appUrl("vendor/ffmpeg/ffmpeg-core.wasm"),
];
const isProtectedCache = (key) => key.startsWith("videoflow-ai-");
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function isolatedResponse(response) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return isolatedResponse(cached);
    try {
      const response = await fetch(event.request);
      if (response.ok && !event.request.url.startsWith("blob:") && !/\/models\/.*\.onnx(?:$|\?)/i.test(event.request.url)) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_BUILD).then((cache) => cache.put(event.request, copy)));
      }
      return isolatedResponse(response);
    } catch {
      const shell = await caches.match(appUrl("./"));
      return shell ? isolatedResponse(shell) : Response.error();
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
