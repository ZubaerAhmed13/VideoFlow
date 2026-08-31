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

test("service worker uses a versioned app-shell cache without user media routes", async () => {
  const source = await readFile(
    new URL("../public/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /videoflow-pwa9/);
  assert.match(source, /self\.registration\.scope/);
  assert.match(source, /manifest\.webmanifest/);
  assert.match(source, /ffmpeg-core\.wasm/);
  assert.match(source, /precache-manifest\.json/);
  assert.match(source, /videoflow-ai-/);
  assert.doesNotMatch(source, /indexedDB|\.mp4|\.mov/);
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
