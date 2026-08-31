import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("static test server serves module runtime with JavaScript MIME", async () => {
  const server = await read("scripts/serve-dist.mjs");
  assert.match(server, /"\.mjs": "text\/javascript; charset=utf-8"/);
  assert.match(server, /writeHead\(404/);
});

test("export range follows newly imported project duration", async () => {
  const source = await read("components/videoflow/ExportControls.tsx");
  assert.match(source, /const currentEnd = current\.rangeEnd \?\? 0/);
  assert.match(source, /rangeEnd: fullDuration/);
});

test("ONNX WASM falls back to one thread without cross-origin isolation", async () => {
  assert.match(await read("workers/ai-inference.worker.ts"), /self\.crossOriginIsolated[^\n]+: 1/);
  assert.match(await read("lib/videoflow/ai/AIInferenceEngine.ts"), /globalThis\.crossOriginIsolated[^\n]+: 1/);
});

test("nested browser runtimes resolve local ESM and WASM companions explicitly", async () => {
  assert.match(await read("scripts/copy-ffmpeg-assets.mjs"), /@ffmpeg\/core\/dist\/esm/);
  assert.match(await read("lib/videoflow/ai/AIInferenceEngine.ts"), /wasmPaths = deploymentAssetUrl\("vendor\/onnx\/"\)/);
  assert.match(await read("workers/ai-inference.worker.ts"), /runtime\.env\.wasm\.wasmPaths = data\.wasmBaseUrl/);
  assert.match(await read("scripts/verify-release.mjs"), /export default createFFmpegCore/);
  assert.match(await read("scripts/verify-nested-http.mjs"), /WebAssembly bytes/);
  const staging = await read("scripts/stage-ai-pack-ci.sh");
  const installer = await read("lib/videoflow/ai/AIRuntimeInstaller.ts");
  for (const variant of ["asyncify", "jsep", "jspi"]) {
    assert.match(staging, new RegExp(`ort-wasm-simd-threaded\\.${variant}\\.mjs`));
    assert.match(staging, new RegExp(`ort-wasm-simd-threaded\\.${variant}\\.wasm`));
    assert.match(installer, new RegExp(`ort-wasm-simd-threaded\\.${variant}\\.mjs`));
    assert.match(installer, new RegExp(`ort-wasm-simd-threaded\\.${variant}\\.wasm`));
  }
});

test("browser FFprobe calls use the explicit input flag required by ffmpeg.wasm", async () => {
  const ffmpeg = await read("lib/videoflow/ffmpeg.ts");
  assert.equal(
    [...ffmpeg.matchAll(/"-i",\s*(?:filename|mounted\.path)/g)].length,
    2,
  );
});

test("Firefox browser matrix uses baseline VP8 Vorbis fixtures", async () => {
  const fixtures = await read("scripts/generate-test-fixtures.mjs");
  const e2e = await read("tests/e2e/videoflow.spec.ts");
  assert.match(fixtures, /overlap-source\.webm/);
  assert.match(fixtures, /"libvpx"/);
  assert.match(fixtures, /libvorbis/);
  assert.match(e2e, /firefoxFixture/);
  assert.match(e2e, /firefoxAI/);
});


test("release dialogs and cross-browser imports remain bounded", async () => {
  assert.match(await read("app/globals.css"), /\.vf-export-dialog[\s\S]*max-height: calc\(100dvh - 32px\)[\s\S]*overflow-y: auto/);
  assert.match(await read("lib/videoflow/media.ts"), /OPTIONAL_TECHNICAL_PROBE_TIMEOUT_MS = 6_000/);
  assert.match(await read("components/videoflow/AIWatermarkControls.tsx"), /aria-label="Run AI preview"/);
});

test("moving-watermark certification fixture uses a true time expression", async () => {
  const fixtures = await read("scripts/generate-test-fixtures.mjs");
  assert.match(fixtures, /overlay=x='100\+300\*t':y='70\+80\*t'/);
});
