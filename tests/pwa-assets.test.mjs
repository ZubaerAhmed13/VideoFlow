import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("PWA manifest identifies VideoFlow and a local icon", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../public/manifest.webmanifest", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.name, "VideoFlow Professional Core");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.icons[0].src, "./favicon.svg");
});

test("service worker uses a versioned isolated app-shell cache without user media routes", async () => {
  const source = await readFile(
    new URL("../public/service-worker.js", import.meta.url),
    "utf8",
  );

  // Cache generation is intentionally versioned, but tests should validate the
  // architecture rather than pinning one obsolete cache number forever.
  assert.match(source, /const CACHE_BUILD = "videoflow-pwa\d+(?:-[a-z0-9-]+)?"/i);
  assert.match(source, /self\.registration\.scope/);
  assert.match(source, /manifest\.webmanifest/);
  assert.match(source, /ffmpeg-core\.wasm/);
  assert.match(source, /precache-manifest\.json/);
  assert.match(source, /coi-bootstrap\.js/);
  assert.match(source, /videoflow-ai-/);

  // GitHub Pages cannot emit COOP/COEP itself, so the controlled service
  // worker response layer must supply the isolation headers required by
  // threaded ONNX WASM while keeping all resources same-origin.
  assert.match(source, /Cross-Origin-Opener-Policy/);
  assert.match(source, /Cross-Origin-Embedder-Policy/);
  assert.match(source, /Cross-Origin-Resource-Policy/);
  assert.match(source, /isolatedResponse/);

  // User media must never become part of the persistent application shell.
  assert.doesNotMatch(source, /indexedDB|\.mp4|\.mov/);
  assert.match(source, /!\/\\\/models\\\/\.\*\\\.onnx/);
});

test("packaged FFmpeg core is a static-host-safe plain WASM copy", async () => {
  const wasm = await readFile(
    new URL("../public/vendor/ffmpeg/ffmpeg-core.wasm", import.meta.url),
  );
  assert.ok(wasm.byteLength > 20 * 1024 * 1024);
  assert.deepEqual([...wasm.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  await assert.rejects(
    () => readFile(new URL("../public/vendor/ffmpeg/ffmpeg-core.wasm.gz", import.meta.url)),
    /ENOENT/,
  );
});
